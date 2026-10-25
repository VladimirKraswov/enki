//! Managed, persistent Chromium over Microsoft's official Playwright MCP.
//! The desktop owns lifecycle only; engines own tool permissions/agent loops.
//!
//! - `files`: the pinned runtime on disk and its validation/refresh.
//! - `node`: which Node.js interpreter may run it.
//! - `gateway`: the private authenticated loopback channel to the daemon.
//! - this module: the one daemon this Desktop owns, serialized install/start,
//!   and cancellation by an explicit stop or by Desktop exiting.
mod files;
mod gateway;
pub mod monitor;
mod node;
mod shared;

pub use files::{root_dir, support_dir};
pub use node::node_program;
pub(crate) use node::npm_cli;

use crate::process::{own_process_group, terminate_group};
use files::{installed_at, private_dir, VERSION};
use gateway::Endpoint;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, TryLockError,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::Emitter;
use tauri::Manager;

const DAEMON_START: Duration = Duration::from_secs(15);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(1250);
const TERMINATE_GRACE: Duration = Duration::from_secs(4);
/// How long the stdio MCP shim waits for a daemon that is still starting
/// (for example while Desktop itself launches) before failing closed.
const MCP_READY_WAIT: Duration = Duration::from_secs(10);
/// Upper bound on how long Desktop's exit waits for an in-flight install or
/// start to terminate its own children.
const EXIT_WAIT: Duration = Duration::from_secs(10);

const NOT_INSTALLED: &str =
    "Инструменты браузера ещё не установлены. Установите их в настройках Desktop.";
const CANCELLED_BY_EXIT: &str = "Настройка браузера отменена при закрытии Desktop.";
const CANCELLED_BY_STOP: &str = "Операция браузера отменена: управление браузером остановлено.";

/// Native lifecycle state shared by every browser command.
///
/// Lock order is `operation` before `owner`. `owner` is held only briefly, so
/// an explicit stop is never queued behind a long installation.
#[derive(Default, Clone)]
pub struct BrowserRuntime {
    /// The daemon process tree this Desktop process started, if any.
    owner: Arc<Mutex<Option<OwnedBrowser>>>,
    /// Serializes install/start within this process; the lifecycle file lock
    /// covers other Desktop processes.
    operation: Arc<Mutex<()>>,
    /// Set once when Desktop exits; never cleared.
    shutting_down: Arc<AtomicBool>,
    /// Bumped by an explicit stop, so install/start that is queued or already
    /// running gives up instead of finishing behind the user's back.
    stop_epoch: Arc<AtomicU64>,
    selection_epoch: Arc<AtomicU64>,
    projection_epoch: Arc<AtomicU64>,
    selection_context: Arc<Mutex<String>>,
}

impl BrowserRuntime {
    fn cancellation(&self) -> Cancellation {
        Cancellation {
            shutting_down: self.shutting_down.clone(),
            stop_epoch: self.stop_epoch.clone(),
            started: self.stop_epoch.load(Ordering::Acquire),
        }
    }
    fn owner(&self) -> MutexGuard<'_, Option<OwnedBrowser>> {
        self.owner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    fn operation(&self) -> MutexGuard<'_, ()> {
        self.operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    /// Ask the daemon named by the readiness record to close, then terminate
    /// and reap the process tree this Desktop owns. Used by explicit stop and
    /// before replacing the runtime or the daemon's interpreter.
    fn stop_service(&self) {
        let owned = self.owner().take();
        if let Ok(root) = root_dir() {
            let _ = gateway::request(&root, Endpoint::Stop, Some(&json!({})));
        }
        if let Some(owned) = owned {
            owned.terminate();
        }
    }
}

/// Captured at command entry; checked at every blocking step.
#[derive(Clone)]
struct Cancellation {
    shutting_down: Arc<AtomicBool>,
    stop_epoch: Arc<AtomicU64>,
    started: u64,
}

impl Cancellation {
    fn check(&self) -> Result<(), String> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(CANCELLED_BY_EXIT.into());
        }
        if self.stop_epoch.load(Ordering::Acquire) != self.started {
            return Err(CANCELLED_BY_STOP.into());
        }
        Ok(())
    }
}

/// The daemon this Desktop started. The daemon watches the read end of the
/// owner pipe: when Desktop exits or crashes the pipe closes and the daemon
/// shuts its browser down instead of becoming an orphan.
struct OwnedBrowser {
    child: Child,
    _owner_pipe: Option<ChildStdin>,
    #[cfg(target_os = "windows")]
    _job: crate::process::KillOnCloseJob,
}

impl OwnedBrowser {
    #[allow(unused_mut)]
    fn adopt(mut child: Child) -> Result<Self, String> {
        let owner_pipe = child.stdin.take();
        #[cfg(target_os = "windows")]
        {
            let job = match crate::process::KillOnCloseJob::attach(&child) {
                Ok(job) => job,
                Err(error) => {
                    terminate_group(&mut child, TERMINATE_GRACE);
                    return Err(error);
                }
            };
            return Ok(Self {
                child,
                _owner_pipe: owner_pipe,
                _job: job,
            });
        }
        #[cfg(not(target_os = "windows"))]
        {
            Ok(Self {
                child,
                _owner_pipe: owner_pipe,
            })
        }
    }
    fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
    fn terminate(mut self) {
        terminate_group(&mut self.child, TERMINATE_GRACE);
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub supported: bool,
    pub installed: bool,
    pub running: bool,
    pub browser_open: bool,
    pub command: String,
    pub node_program: Option<String>,
    pub skill_path: String,
    pub runtime_path: String,
    pub profile_path: String,
    pub version: Option<String>,
    pub error: Option<String>,
}

/// Installed managed browser tools: the bundled runtime attaches its browser
/// tools (via `--browser-mcp`) and loads the browser skills from here.
pub fn installed_skills() -> Option<std::path::PathBuf> {
    let current = support_dir().ok()?;
    installed_at(&current)
        .then(|| current.join("skills"))
        .filter(|p| p.is_dir())
}

fn status(configured: Option<&str>) -> Result<BrowserStatus, String> {
    let root = root_dir()?;
    let current = support_dir()?;
    let node = node_program(configured);
    let health = gateway::health(&root).ok().map(|(_, value)| value);
    let installed = installed_at(&current);
    Ok(BrowserStatus {
        supported: cfg!(any(
            target_os = "macos",
            target_os = "linux",
            target_os = "windows"
        )),
        installed,
        running: health.as_ref().is_some_and(|v| v["running"] == true),
        browser_open: health.as_ref().is_some_and(|v| v["browserOpen"] == true),
        command: shared::command()?.to_string_lossy().into_owned(),
        node_program: node.as_ref().ok().map(|p| p.to_string_lossy().into_owned()),
        error: node.err(),
        skill_path: current.join("skills").to_string_lossy().into_owned(),
        runtime_path: current.to_string_lossy().into_owned(),
        profile_path: root.join("profile").to_string_lossy().into_owned(),
        version: installed.then(|| VERSION.to_owned()),
    })
}

/// `node <script>` with the managed Chromium location and the verified
/// interpreter first on PATH (npm and Playwright start helpers by name).
/// Relative PATH entries are dropped so the working directory cannot inject
/// programs. Process-group ownership is decided by the caller.
fn node_command(node: &Path, root: &Path, script: &Path) -> Command {
    let mut command = Command::new(node);
    command
        .arg(script)
        .env("PLAYWRIGHT_BROWSERS_PATH", root.join("browsers"));
    if let Some(parent) = node.parent() {
        let mut paths = vec![parent.to_path_buf()];
        if let Some(path) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&path).filter(|entry| entry.is_absolute()));
        }
        if let Ok(path) = std::env::join_paths(paths) {
            command.env("PATH", path);
        }
    }
    crate::process::hide_console(&mut command);
    command
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn start(
    runtime: &BrowserRuntime,
    configured: Option<&str>,
    cancel: &Cancellation,
) -> Result<(), String> {
    cancel.check()?;
    let _operation = runtime.operation();
    cancel.check()?;
    let root = root_dir()?;
    private_dir(&root)?;
    let _lock = files::lifecycle_lock(
        &root,
        "Браузер уже запускается или настраивается другим процессом Desktop.",
    )?;
    let current = support_dir()?;
    if !installed_at(&current) {
        return Err(NOT_INSTALLED.into());
    }
    let node = node_program(configured)?;
    {
        // Reap an owned daemon that already exited, so it is not reported as ours.
        let mut owner = runtime.owner();
        if owner.as_mut().is_some_and(|owned| !owned.running()) {
            *owner = None;
        }
    }
    let same_node =
        files::recorded_node(&current).is_some_and(|recorded| same_file(&recorded, &node));
    if same_node && gateway::health(&root).is_ok() {
        return Ok(());
    }
    runtime.stop_service();
    cancel.check()?;
    private_dir(&root.join("workspace"))?;
    private_dir(&root.join("profile"))?;
    files::record_node(&current, &node)?;
    // Readiness must come from a daemon started after this point, not from a
    // record that an earlier daemon left behind.
    let previous = gateway::ready(&root).map(|ready| ready.instance_id);
    let mut command = node_command(&node, &root, &current.join("daemon.mjs"));
    own_process_group(&mut command);
    let child = command
        .arg(&root)
        .current_dir(root.join("workspace"))
        .env("OCDESKTOP_BROWSER_OWNER_PIPE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Не удалось запустить браузерный сервис.")?;
    let mut owned = OwnedBrowser::adopt(child)?;
    let deadline = Instant::now() + DAEMON_START;
    loop {
        if let Err(error) = cancel.check() {
            owned.terminate();
            return Err(error);
        }
        if !owned.running() {
            return Err("Браузерный сервис завершился. Проверьте установку Node/npm и системные библиотеки Chromium в Linux.".into());
        }
        if let Ok((ready, _)) = gateway::health(&root) {
            if previous.as_deref() != Some(ready.instance_id.as_str()) {
                let mut owner = runtime.owner();
                // Checked under the owner lock: a stop that bumped the epoch
                // either finds this daemon in `owner` or is honoured here.
                if let Err(error) = cancel.check() {
                    drop(owner);
                    owned.terminate();
                    return Err(error);
                }
                *owner = Some(owned);
                return Ok(());
            }
        }
        if Instant::now() >= deadline {
            owned.terminate();
            return Err("Браузерный сервис не запустился за 15 секунд. Повторите запуск.".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn install(
    runtime: &BrowserRuntime,
    configured: Option<&str>,
    cancel: &Cancellation,
) -> Result<(), String> {
    cancel.check()?;
    let _operation = runtime.operation();
    cancel.check()?;
    let root = root_dir()?;
    private_dir(&root)?;
    let _lock = files::lifecycle_lock(
        &root,
        "Установка браузера уже выполняется другим процессом Desktop.",
    )?;
    shared::migrate(&root, || cancel.check())?;
    let current = support_dir()?;
    if installed_at(&current) {
        return Ok(());
    }
    if files::dependencies_installed(&current) {
        // Same packages and Chromium; only Desktop-owned scripts changed. The
        // daemon would otherwise keep running the previous script.
        runtime.stop_service();
        files::refresh_scripts(&current)?;
        if installed_at(&current) {
            return Ok(());
        }
    }
    let node = node_program(configured)?;
    let npm = npm_cli(&node)?;
    runtime.stop_service();
    files::remove_stale_staging(&root);
    cancel.check()?;
    let staging = files::staging_dir(&root);
    private_dir(&staging)?;
    private_dir(&root.join("workspace"))?;
    files::write_resources(&staging)?;
    let mut command = node_command(&node, &root, &staging.join("setup.mjs"));
    own_process_group(&mut command);
    #[allow(unused_mut)]
    let mut child = command
        .arg(&root)
        .arg(npm)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Не удалось начать установку браузера.")?;
    #[cfg(target_os = "windows")]
    let _install_job = match crate::process::KillOnCloseJob::attach(&child) {
        Ok(job) => job,
        Err(error) => {
            terminate_group(&mut child, TERMINATE_GRACE);
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    if let Err(error) = wait_for_installer(&mut child, &staging, cancel, INSTALL_TIMEOUT) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    files::promote(&root, &staging, &current)
}

fn wait_for_installer(
    child: &mut Child,
    staging: &Path,
    cancel: &Cancellation,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Err(error) = cancel.check() {
            terminate_group(child, TERMINATE_GRACE);
            return Err(error);
        }
        match child.try_wait() {
            Ok(Some(exit)) => {
                return if exit.success() && installed_at(staging) {
                    Ok(())
                } else {
                    Err("Установка браузера не завершена. Проверьте сеть, свободное место, npm и системные библиотеки Linux.".into())
                }
            }
            Err(_) => {
                terminate_group(child, TERMINATE_GRACE);
                return Err("Не удалось проверить процесс установки браузера.".into());
            }
            Ok(None) if Instant::now() >= deadline => {
                terminate_group(child, TERMINATE_GRACE);
                return Err("Время установки браузера истекло. Повторите настройку.".into());
            }
            Ok(None) => thread::sleep(Duration::from_millis(200)),
        }
    }
}

fn validated_url(value: Option<&str>) -> Result<String, String> {
    let value = value
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("about:blank")
        .trim();
    if value == "about:blank" {
        return Ok(value.to_owned());
    }
    let parsed = url::Url::parse(value).map_err(|_| "Введите полный HTTP(S)-адрес.")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Разрешены HTTP(S)-адреса без встроенных логинов и паролей.".into());
    }
    Ok(parsed.into())
}

fn main_window(window: &tauri::Window) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Настройки браузера доступны только в основном окне Desktop.".into());
    }
    Ok(())
}

/// Every browser command blocks on files, processes or loopback HTTP; none of
/// that may run on the async runtime's worker threads.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn browser_status(
    window: tauri::Window,
    node_program: Option<String>,
) -> Result<BrowserStatus, String> {
    main_window(&window)?;
    blocking(move || status(node_program.as_deref())).await
}

#[tauri::command]
pub async fn browser_install(
    window: tauri::Window,
    state: tauri::State<'_, BrowserRuntime>,
    node_program: Option<String>,
) -> Result<BrowserStatus, String> {
    main_window(&window)?;
    let runtime = state.inner().clone();
    let cancel = runtime.cancellation();
    blocking(move || {
        install(&runtime, node_program.as_deref(), &cancel)?;
        status(node_program.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn browser_start(
    window: tauri::Window,
    state: tauri::State<'_, BrowserRuntime>,
    node_program: Option<String>,
) -> Result<BrowserStatus, String> {
    main_window(&window)?;
    let runtime = state.inner().clone();
    let cancel = runtime.cancellation();
    blocking(move || {
        start(&runtime, node_program.as_deref(), &cancel)?;
        status(node_program.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn browser_open(
    window: tauri::Window,
    state: tauri::State<'_, BrowserRuntime>,
    url: Option<String>,
    node_program: Option<String>,
    scope_key: Option<String>,
) -> Result<BrowserStatus, String> {
    main_window(&window)?;
    let runtime = state.inner().clone();
    let cancel = runtime.cancellation();
    blocking(move || {
        let address = url
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| validated_url(Some(value)))
            .transpose()?;
        start(&runtime, node_program.as_deref(), &cancel)?;
        let root = root_dir()?;
        // Without a URL only the window is revealed: the current page, form
        // values and tabs stay exactly as they are.
        let mut payload = match address {
            Some(address) => json!({"method":"tools/call","owner":"user","reveal":true,"params":{"name":"browser_navigate","arguments":{"url":address}}}),
            None => json!({"method":"desktop/reveal"}),
        };
        if let Some(scope_key) = scope_key { payload["scopeKey"] = json!(scope_key); }
        let result = gateway::request(&root, Endpoint::Rpc, Some(&payload))?;
        if result["result"]["isError"] == true {
            return Err("Не удалось открыть страницу. Проверьте адрес, сеть и библиотеки Chromium в Linux.".into());
        }
        status(node_program.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn browser_stop(
    window: tauri::Window,
    state: tauri::State<'_, BrowserRuntime>,
) -> Result<BrowserStatus, String> {
    main_window(&window)?;
    let runtime = state.inner().clone();
    // Cancel queued or in-flight install/start before stopping: they notice
    // within one polling interval and terminate their own children.
    runtime.stop_epoch.fetch_add(1, Ordering::AcqRel);
    blocking(move || {
        runtime.stop_service();
        status(None)
    })
    .await
}

/// Next selection revision: strictly greater than every earlier one and than
/// `now`, so it stays monotonic across a Desktop reconnect. An explicit CAS
/// loop: `fetch_update` is deprecated on current stable and its replacement
/// `try_update` is not available on older supported toolchains.
fn next_selection_revision(epoch: &AtomicU64, now: u64) -> u64 {
    let mut previous = epoch.load(Ordering::Acquire);
    loop {
        let next = previous.max(now) + 1;
        match epoch.compare_exchange_weak(previous, next, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return next,
            Err(actual) => previous = actual,
        }
    }
}

/// Select a projection without stopping any background browser or agent.
#[tauri::command]
pub async fn browser_session(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserRuntime>,
    directory: Option<String>,
    engine: Option<String>,
    session_id: Option<String>,
) -> Result<Value, String> {
    main_window(&window)?;
    // Remains monotonic when Desktop reconnects to an already running daemon.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_micros() as u64;
    let revision = next_selection_revision(&state.selection_epoch, now);
    let payload = match (directory, engine, session_id) {
        (Some(directory), Some(engine), Some(session_id)) => {
            if !Path::new(&directory).is_absolute()
                || !matches!(engine.as_str(), "opencode" | "pi")
                || session_id.is_empty()
                || session_id.len() > 200
                || !session_id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            {
                return Err("Некорректная сессия браузера.".into());
            }
            json!({"method":"desktop/session", "workspace":directory, "session":{"engine":engine,"sessionID":session_id}, "revision":revision})
        }
        (None, None, None) => {
            json!({"method":"desktop/session", "session":null,"revision":revision})
        }
        _ => return Err("Не указана полная сессия браузера.".into()),
    };
    let identity = format!("{}:{}", payload["workspace"], payload["session"]);
    let changed = {
        let mut previous = state
            .selection_context
            .lock()
            .map_err(|_| "Не удалось выбрать браузер.")?;
        let changed = *previous != identity;
        *previous = identity;
        changed
    };
    if changed {
        state.projection_epoch.fetch_add(1, Ordering::AcqRel);
        if let Some(viewer) = app.get_webview_window(monitor::LABEL) {
            viewer.hide().map_err(|e| e.to_string())?;
            app.emit_to(monitor::LABEL, "browser-monitor://scope", revision)
                .map_err(|e| e.to_string())?;
        }
    }
    blocking(move || gateway::request(&root_dir()?, Endpoint::Rpc, Some(&payload))).await
}

/// Read-only pixel projection; tokens remain in the native gateway. Only the
/// trusted main window can invoke this, never the remote page being displayed.
#[tauri::command]
pub async fn browser_view(window: tauri::Window) -> Result<Value, String> {
    main_window(&window)?;
    blocking(move || gateway::request(&root_dir()?, Endpoint::View, None)).await
}

/// Lightweight presence polling must not spawn Node version probes or capture
/// page pixels while the panel is hidden.
#[tauri::command]
pub async fn browser_presence(
    window: tauri::Window,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    main_window(&window)?;
    blocking(move || {
        let mut health = gateway::health(&root_dir()?)
            .map(|(_, value)| value)
            .unwrap_or_else(|_| json!({"browserOpen":false,"running":false}));
        health["monitorOpen"] = json!(monitor::visible(&app));
        Ok(health)
    })
    .await
}

fn panel_tool(action: &str, args: &Value) -> Result<Value, String> {
    let coord = |key: &str, max: f64| -> Result<f64, String> {
        args[key]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0 && *n <= max)
            .ok_or_else(|| "Некорректные координаты браузера.".into())
    };
    let (name, arguments) = match action {
        "preferences" => {
            let environment = args
                .get("environment")
                .filter(|v| v.is_object())
                .ok_or("Некорректные настройки браузера.")?;
            if environment.to_string().len() > 4096 {
                return Err("Слишком большой набор настроек браузера.".into());
            }
            ("desktop/preferences", json!({"environment":environment}))
        }
        "mode" => {
            let mode = args["mode"]
                .as_str()
                .filter(|v| matches!(*v, "fast" | "human"))
                .ok_or("Некорректный режим браузера.")?;
            (
                if args.get("scopeKey").is_some() {
                    "desktop/mode"
                } else {
                    "desktop/default-mode"
                },
                json!({"mode":mode}),
            )
        }
        "resize" => {
            let width = args["width"]
                .as_u64()
                .filter(|v| (320..=1920).contains(v))
                .ok_or("Некорректная ширина браузера.")?;
            let height = args["height"]
                .as_u64()
                .filter(|v| (240..=1200).contains(v))
                .ok_or("Некорректная высота браузера.")?;
            ("desktop/resize", json!({"width":width,"height":height}))
        }
        "navigate" => (
            "browser_navigate",
            json!({"url": validated_url(Some(args["url"].as_str().ok_or("Нужен адрес страницы.")?))?}),
        ),
        "click" => (
            "desktop/click",
            json!({"x":coord("x",1920.0)?,"y":coord("y",1200.0)?}),
        ),
        "drag" => (
            "desktop/drag",
            json!({"x":coord("x",1920.0)?,"y":coord("y",1200.0)?,"endX":coord("endX",1920.0)?,"endY":coord("endY",1200.0)?}),
        ),
        "wheel" => {
            let dy = args["dy"]
                .as_f64()
                .filter(|n| n.is_finite() && n.abs() <= 2000.0)
                .ok_or("Некорректная прокрутка.")?;
            ("desktop/wheel", json!({"dy":dy}))
        }
        "copy" => ("desktop/copy", json!({})),
        "text" => {
            let text = args["text"]
                .as_str()
                .filter(|s| s.len() <= 16384)
                .ok_or("Слишком большой текст.")?;
            ("desktop/type", json!({"text":text}))
        }
        "key" => {
            let key = args["key"].as_str().ok_or("Нужна клавиша.")?;
            if !matches!(
                key,
                "Enter"
                    | "Tab"
                    | "Backspace"
                    | "Delete"
                    | "Escape"
                    | "ArrowLeft"
                    | "ArrowRight"
                    | "ArrowUp"
                    | "ArrowDown"
                    | "Home"
                    | "End"
                    | "PageUp"
                    | "PageDown"
                    | "ControlOrMeta+a"
            ) {
                return Err("Эта клавиша не поддерживается браузером.".into());
            }
            ("desktop/key", json!({"key":key}))
        }
        "back" => ("browser_navigate_back", json!({})),
        "reload" => ("desktop/reload", json!({})),
        "forward" => ("desktop/forward", json!({})),
        "new" => ("browser_tabs", json!({"action":"new"})),
        "select" | "close" => {
            let index = args["index"]
                .as_u64()
                .filter(|n| *n < 128)
                .ok_or("Некорректная вкладка.")?;
            ("browser_tabs", json!({"action":action,"index":index}))
        }
        _ => return Err("Действие браузера не поддерживается.".into()),
    };
    Ok(json!({"name":name,"arguments":arguments}))
}

#[tauri::command]
pub async fn browser_input(
    window: tauri::Window,
    action: String,
    args: Value,
) -> Result<Value, String> {
    main_window(&window)?;
    let params = panel_tool(&action, &args)?;
    let expected = args.get("expected").cloned();
    let scope_key = args.get("scopeKey").cloned();
    blocking(move || {
        let root = root_dir()?;
        let mut payload = if params["name"].as_str().is_some_and(|name| name.starts_with("desktop/")) {
            { let mut payload = params["arguments"].clone(); payload["method"] = params["name"].clone(); payload }
        } else { json!({
            "method":"tools/call", "workspace":root.join("workspace"), "owner":"user", "params":params
        }) };
        if let Some(expected) = expected { payload["expected"] = expected; }
        if let Some(scope_key) = scope_key { payload["scopeKey"] = scope_key; }
        let result = gateway::request(&root, Endpoint::Rpc, Some(&payload))?;
        if result["result"]["isError"] == true { return Err("Действие не выполнено. Проверьте страницу и повторите.".into()); }
        Ok(result["result"].clone())
    }).await
}

/// Desktop exit: cancel install/start, wait (bounded) for them to clean up,
/// then stop only the daemon this process owns.
pub fn shutdown(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<BrowserRuntime>() else {
        return;
    };
    let runtime = state.inner().clone();
    runtime.shutting_down.store(true, Ordering::Release);
    let deadline = Instant::now() + EXIT_WAIT;
    let _operation = loop {
        match runtime.operation.try_lock() {
            Ok(guard) => break Some(guard),
            Err(TryLockError::Poisoned(poisoned)) => break Some(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(50))
            }
            Err(TryLockError::WouldBlock) => break None,
        }
    };
    let owned = runtime.owner().take();
    if let Some(owned) = owned {
        if let Ok(root) = root_dir() {
            let _ = gateway::request(&root, Endpoint::Stop, Some(&json!({})));
        }
        owned.terminate();
    }
}

/// Poll until the daemon answers, so an engine that launches the proxy while
/// Desktop is still starting its browser does not fail needlessly.
fn wait_for_service(root: &Path, limit: Duration) -> Result<(), String> {
    let deadline = Instant::now() + limit;
    loop {
        match gateway::health(root) {
            Ok(_) => return Ok(()),
            Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(250)),
            Err(error) => return Err(error),
        }
    }
}

/// `--browser-mcp`: the stdio entry point the Enki Runtime launches. It never
/// starts or stops the daemon; it only connects to the one Desktop owns.
pub fn mcp_main() -> Result<(), String> {
    let root = root_dir()?;
    let current = support_dir()?;
    if !installed_at(&current) {
        return Err(
            "Desktop browser tools are not installed. Open Desktop → Settings → Browser.".into(),
        );
    }
    wait_for_service(&root, MCP_READY_WAIT)?;
    let recorded = files::recorded_node(&current);
    let node = node_program(recorded.as_deref().and_then(Path::to_str))?;
    // Inherited stdio is MCP JSON-RPC only. The proxy stays in the engine's
    // process group, so the engine's own cleanup reaches it; it exits on
    // stdin EOF. The browser owner stays alive for other engines and the UI.
    let exit = node_command(&node, &root, &current.join("proxy.mjs"))
        .arg(&root)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|_| "Could not launch browser MCP proxy")?;
    if !exit.success() {
        return Err("Browser MCP proxy stopped. Reconnect it from Desktop settings.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_revisions_are_strictly_monotonic_and_never_below_now() {
        let epoch = AtomicU64::new(0);
        assert_eq!(next_selection_revision(&epoch, 100), 101);
        // A clock that went backwards (or a reconnect) still advances.
        assert_eq!(next_selection_revision(&epoch, 50), 102);
        assert_eq!(next_selection_revision(&epoch, 500), 501);
        assert_eq!(epoch.load(Ordering::SeqCst), 501, "stored = returned");
        // Concurrent selections never hand out the same revision.
        let shared = Arc::new(AtomicU64::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let shared = shared.clone();
                std::thread::spawn(move || {
                    (0..250)
                        .map(|_| next_selection_revision(&shared, 7))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let mut all: Vec<u64> = threads
            .into_iter()
            .flat_map(|t| t.join().unwrap())
            .collect();
        all.sort_unstable();
        all.dedup();
        assert_eq!(all.len(), 2000);
        assert_eq!((all[0], all[1999]), (8, 2007));
    }

    #[test]
    fn panel_inputs_are_bounded_and_do_not_accept_arbitrary_tools() {
        for (action, args) in [
            ("evaluate", json!({"function":"() => window.__TAURI__"})),
            ("navigate", json!({"url":"javascript:alert(1)"})),
            ("navigate", json!({"url":"file:///C:/Users/private.txt"})),
            ("click", json!({"x":-1,"y":20})),
            ("click", json!({"x":1921,"y":20})),
            ("wheel", json!({"dy":2001})),
            ("key", json!({"key":"Alt+F4"})),
            ("select", json!({"index":128})),
            ("close", json!({"index":-1})),
            ("text", json!({"text":"a".repeat(16385)})),
        ] {
            assert!(panel_tool(action, &args).is_err(), "{action}");
        }
        assert_eq!(
            panel_tool("click", &json!({"x":12,"y":34})).unwrap()["name"],
            "desktop/click"
        );
        assert_eq!(
            panel_tool("new", &json!({})).unwrap()["arguments"]["action"],
            "new"
        );
        assert_eq!(
            panel_tool("text", &json!({"text":"Привет"})).unwrap()["name"],
            "desktop/type"
        );
        assert_eq!(
            panel_tool("reload", &json!({})).unwrap()["name"],
            "desktop/reload"
        );
    }
    #[test]
    fn navigation_rejects_privileged_and_credential_urls() {
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,x",
            "http://user:password@example.com",
            "http:///",
            "relative/path",
            "about:settings",
        ] {
            assert!(validated_url(Some(bad)).is_err(), "{bad}");
        }
        assert_eq!(validated_url(None).unwrap(), "about:blank");
        assert_eq!(
            validated_url(Some("https://example.com/path")).unwrap(),
            "https://example.com/path"
        );
    }
    #[test]
    #[cfg(unix)]
    fn node_override_that_hangs_is_killed_within_deadline() {
        use std::os::unix::fs::PermissionsExt;
        let temp =
            std::env::temp_dir().join(format!("browser-node-timeout-{}", std::process::id()));
        private_dir(&temp).unwrap();
        let script = temp.join("node");
        fs::write(&script, "#!/bin/sh\nexec sleep 30\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let started = Instant::now();
        assert!(node_program(script.to_str())
            .unwrap_err()
            .contains("5 секунд"));
        assert!(started.elapsed() < Duration::from_secs(8));
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    #[cfg(unix)]
    fn managed_private_directory_rejects_symlink() {
        let temp =
            std::env::temp_dir().join(format!("browser-private-link-{}", std::process::id()));
        private_dir(&temp).unwrap();
        let link = temp.join("link");
        std::os::unix::fs::symlink(std::env::temp_dir(), &link).unwrap();
        assert!(private_dir(&link).is_err());
        fs::remove_dir_all(temp).unwrap();
    }
    fn cancellation(flag: &Arc<AtomicBool>, epoch: &Arc<AtomicU64>) -> Cancellation {
        Cancellation {
            shutting_down: flag.clone(),
            stop_epoch: epoch.clone(),
            started: epoch.load(Ordering::Acquire),
        }
    }
    #[test]
    #[cfg(unix)]
    fn shutdown_cancels_installer_and_reaps_its_own_child() {
        use std::os::unix::process::CommandExt;
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        let epoch = Arc::new(AtomicU64::new(0));
        let cancel = cancellation(&flag, &epoch);
        let signal = flag.clone();
        let setter = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            signal.store(true, Ordering::Release);
        });
        let began = Instant::now();
        let result = wait_for_installer(
            &mut child,
            Path::new("/nonexistent-test-owned-browser-stage"),
            &cancel,
            Duration::from_secs(30),
        );
        assert!(result.unwrap_err().contains("закрытии Desktop"));
        assert!(began.elapsed() < Duration::from_secs(2));
        assert!(child.try_wait().unwrap().is_some());
        setter.join().unwrap();
    }
    #[test]
    #[cfg(unix)]
    fn explicit_stop_cancels_an_installer_already_in_flight() {
        use std::os::unix::process::CommandExt;
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        let epoch = Arc::new(AtomicU64::new(7));
        let cancel = cancellation(&flag, &epoch);
        let stopper = epoch.clone();
        let setter = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            stopper.fetch_add(1, Ordering::AcqRel);
        });
        let began = Instant::now();
        let error = wait_for_installer(
            &mut child,
            Path::new("/nonexistent-test-owned-browser-stage"),
            &cancel,
            Duration::from_secs(30),
        )
        .unwrap_err();
        assert_eq!(error, CANCELLED_BY_STOP);
        assert!(began.elapsed() < Duration::from_secs(2));
        assert!(child.try_wait().unwrap().is_some());
        setter.join().unwrap();
    }
    #[test]
    fn a_stop_before_a_queued_operation_cancels_it_and_later_operations_run() {
        let runtime = BrowserRuntime::default();
        let queued = runtime.cancellation();
        runtime.stop_epoch.fetch_add(1, Ordering::AcqRel);
        assert_eq!(queued.check().unwrap_err(), CANCELLED_BY_STOP);
        assert!(runtime.cancellation().check().is_ok());
        runtime.shutting_down.store(true, Ordering::Release);
        assert_eq!(
            runtime.cancellation().check().unwrap_err(),
            CANCELLED_BY_EXIT
        );
    }
    #[test]
    fn relative_node_override_never_searches_cwd() {
        assert!(node_program(Some("node")).is_err());
    }
    #[test]
    fn status_requires_completed_setup_not_just_package_files() {
        let temp =
            std::env::temp_dir().join(format!("browser-install-incomplete-{}", std::process::id()));
        private_dir(&temp).unwrap();
        fs::write(temp.join("package.json"), "{}").unwrap();
        assert!(!installed_at(&temp));
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn panel_mode_and_resize_are_narrow_and_bounded() {
        assert_eq!(
            panel_tool("mode", &json!({"mode":"human"})).unwrap()["name"],
            "desktop/default-mode"
        );
        for mode in ["unsafe", "", "Human"] {
            assert!(panel_tool("mode", &json!({"mode":mode})).is_err());
        }
        assert!(panel_tool("resize", &json!({"width":640,"height":480})).is_ok());
        for args in [
            json!({"width":319,"height":480}),
            json!({"width":640,"height":1201}),
            json!({"width":640.5,"height":480}),
            json!({"width":640}),
        ] {
            assert!(panel_tool("resize", &args).is_err());
        }
    }

    #[test]
    fn panel_environment_envelope_cannot_replace_rpc_method_or_escape_size_limit() {
        let value = panel_tool(
            "preferences",
            &json!({
                "environment":{"locale":"ru-RU"}, "method":"tools/call", "owner":"agent"
            }),
        )
        .unwrap();
        assert_eq!(
            value,
            json!({"name":"desktop/preferences", "arguments":{"environment":{"locale":"ru-RU"}}})
        );
        for environment in [
            Value::Null,
            json!([]),
            json!("invalid"),
            json!({"locale":"x".repeat(4096)}),
        ] {
            assert!(panel_tool("preferences", &json!({"environment":environment})).is_err());
        }
    }

    #[test]
    fn resources_pin_official_dependencies_and_no_unsafe_flags() {
        let manifest: Value = serde_json::from_str(files::DEPENDENCIES[0].1).unwrap();
        assert_eq!(manifest["dependencies"]["@playwright/mcp"], VERSION);
        let daemon = include_str!("../resources/browser/daemon.mjs");
        assert!(
            include_str!("../resources/browser/preferences.mjs").contains("chromiumSandbox: true")
        );
        assert!(!daemon.contains("allowUnrestrictedFileAccess: true"));
        assert!(!daemon.contains("--no-sandbox"));
        assert!(daemon.contains("127.0.0.1"));
    }
    #[test]
    fn daemon_owner_pipe_is_opt_in_so_manual_smoke_runs_are_unaffected() {
        let daemon = include_str!("../resources/browser/daemon.mjs");
        assert!(daemon.contains("OCDESKTOP_BROWSER_OWNER_PIPE"));
    }
}
