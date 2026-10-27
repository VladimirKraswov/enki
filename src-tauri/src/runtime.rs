//! Supervision of the bundled Enki Runtime (pinned Node.js + Pi SDK).
//!
//! Ownership rules:
//! - The runtime is a child of this native process, never of the WebView. A
//!   window reload, a hidden window or a closed tab never stops running work;
//!   only an explicit application exit (or update) does, with a bounded drain.
//! - It is launched from the immutable, versioned artifact inside the signed
//!   app bundle by absolute path with an argument vector. PATH never selects the
//!   interpreter; NODE_OPTIONS/NODE_PATH from the user environment are removed.
//! - It listens on 127.0.0.1 only. The bearer token is generated here, sent over
//!   the child's stdin (never argv, env or a URL) and rotated.
//! - stdout of the child is a JSON-lines control channel: `ready`, `activity`,
//!   `drained` and broker requests for the OS vault, the pinned Hub client and
//!   the shared-capability registry. No secret is materialized to disk.
//! - Unix: own process group; Windows: hidden console + kill-on-close Job.

use crate::process::{hide_console, own_process_group, terminate_group_until, OutputTail};
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::BufReader,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

const READY_DEADLINE: Duration = Duration::from_secs(60);
const STDERR_TAIL: usize = 16 * 1024;
const ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];
pub const CONTRACT: u64 = 1;
pub const TOKEN_EVENT: &str = "enki-runtime://token";
pub const STATUS_EVENT: &str = "enki-runtime://status";
const VAULT_SERVICE: &str = "dev.local.opencodedesktop.pi-credentials";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub endpoint: String,
    pub token: String,
    pub instance: String,
    pub version: String,
    pub contract: u64,
}

pub struct Supervised {
    child: OwnedChild,
    writer: control::ControlWriter,
    writer_task: Arc<Mutex<control::WriterTask>>,
    gate: Arc<control::GenerationGate>,
    generation: String,
    acks: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
    port: u16,
    token: String,
    pending_rotation: Option<rotation::PendingRotation>,
    instance: String,
    version: String,
    /// Keeps the stderr pipe drained for the child's whole life.
    _stderr: OutputTail,
    #[cfg(target_os = "windows")]
    _job: Option<crate::process::KillOnCloseJob>,
}

const CHILD_CLEANUP: Duration = Duration::from_secs(2);

/// The exact owned runtime child. Every drop path (failed start, replaced or
/// dropped supervision) is bounded: TERM/KILL of its own group within
/// CHILD_CLEANUP, then reaped. A child not proven reaped by then is moved, never
/// dropped, into the supervisor's `retained` registry, which blocks replacement
/// generations and authoritative idle until a later bounded attempt reaps it.
struct OwnedChild {
    child: Option<Child>,
    retained: Arc<Mutex<Vec<Child>>>,
}
struct StartingGeneration {
    gate: Arc<control::GenerationGate>,
    committed: bool,
}
impl Drop for StartingGeneration {
    fn drop(&mut self) {
        if !self.committed {
            self.gate.revoke();
        }
    }
}
impl std::ops::Deref for OwnedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        self.child.as_ref().expect("owned runtime child")
    }
}
impl std::ops::DerefMut for OwnedChild {
    fn deref_mut(&mut self) -> &mut Child {
        self.child.as_mut().expect("owned runtime child")
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        if !terminate_group_until(&mut child, Instant::now() + CHILD_CLEANUP) {
            self.retained
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(child);
        }
    }
}

/// Bounded retry for retained children; true when none remains unreaped.
fn reap_retained(retained: &Mutex<Vec<Child>>, until: Instant) -> bool {
    let mut retained = retained
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    retained.retain_mut(|child| !terminate_group_until(child, until));
    retained.is_empty()
}

impl Drop for Supervised {
    fn drop(&mut self) {
        self.gate.revoke();
        self.writer.revoke();
        // `child` then drops through OwnedChild: bounded, retained if unreaped.
    }
}

impl Supervised {
    fn process_alive(&mut self) -> bool {
        // An inspection failure is uncertainty, never proof of an exited child.
        !matches!(self.child.try_wait(), Ok(Some(_)))
    }
    fn alive(&mut self) -> bool {
        self.gate.is_active() && self.process_alive()
    }

    fn transact(&self, operation: &str, message: Value, until: Instant) -> Result<Value, String> {
        self.transact_id(operation, message, &new_request_id()?, until)
            .map_err(AckError::into_message)
    }

    /// Generation- and id-bound command. Reusing an id is only valid for
    /// operations the runtime deduplicates by requestId (maintenance): it then
    /// returns the stored outcome of that same request instead of re-executing.
    fn transact_id(
        &self,
        operation: &str,
        mut message: Value,
        id: &str,
        until: Instant,
    ) -> Result<Value, AckError> {
        let id = id.to_string();
        let (sender, receiver) = mpsc::channel();
        {
            let mut waiters = self
                .acks
                .lock()
                .map_err(|_| AckError::NotSent("Канал подтверждений ядра недоступен".into()))?;
            if waiters.len() >= 16 {
                return Err(AckError::NotSent(
                    "Слишком много команд ожидают подтверждения ядра".into(),
                ));
            }
            waiters.insert(id.clone(), sender);
        }
        let result = (|| {
            let invalid = || AckError::NotSent("Некорректная команда ядра".into());
            let object = message.as_object_mut().ok_or_else(invalid)?;
            object.insert("generation".into(), json!(self.generation));
            object.insert("requestId".into(), json!(id));
            let bytes = serde_json::to_vec(&message).map_err(|_| invalid())?;
            // From here on the bytes may have reached the child: only an exact
            // ACK is certainty; everything else is reported as uncertain.
            self.writer
                .try_enqueue(bytes)
                .and_then(|receipt| {
                    receipt.wait_until(until.min(Instant::now() + Duration::from_secs(2)))
                })
                .map_err(|error| {
                    AckError::Uncertain(format!(
                        "Доставка команды ядру не подтверждена ({error:?})"
                    ))
                })?;
            let response = receiver
                .recv_timeout(until.saturating_duration_since(Instant::now()))
                .map_err(|_| {
                    AckError::Uncertain(
                        "Ядро не подтвердило команду; её результат пока неизвестен".into(),
                    )
                })?;
            if response["type"] != "ack"
                || response["id"].as_str() != Some(id.as_str())
                || response["op"].as_str() != Some(operation)
                || response["generation"].as_str() != Some(self.generation.as_str())
                || response["instance"].as_str() != Some(self.instance.as_str())
            {
                return Err(AckError::Uncertain(
                    "Подтверждение относится к другой команде или экземпляру ядра".into(),
                ));
            }
            if response["ok"].as_bool() != Some(true) {
                return Err(AckError::Refused(
                    "Ядро отказалось выполнить команду или не смогло завершить её".into(),
                ));
            }
            Ok(response)
        })();
        if let Ok(mut waiters) = self.acks.lock() {
            waiters.remove(&id);
        }
        result
    }
}

/// Outcome classes of a supervisor command. Only `Uncertain` may have changed
/// runtime state without an exact ACK; it is never treated as success or failure.
#[derive(Debug)]
enum AckError {
    NotSent(String),
    Refused(String),
    Uncertain(String),
}

impl AckError {
    fn into_message(self) -> String {
        match self {
            AckError::NotSent(message)
            | AckError::Refused(message)
            | AckError::Uncertain(message) => message,
        }
    }
}

#[derive(Default, Clone)]
pub struct RuntimeSupervisor {
    inner: Arc<Mutex<Option<Supervised>>>,
    start: Arc<Mutex<()>>,
    activity: Arc<Mutex<Value>>,
    next_generation: Arc<AtomicU64>,
    /// Maintenance/restart stop latch; cleared only after proven cancellation.
    stopping: Arc<AtomicBool>,
    /// Application exit or installer handoff: never cleared in this process.
    exiting: Arc<AtomicBool>,
    /// Incremented by every stop request so a restart can detect a concurrent one.
    stop_requests: Arc<AtomicU64>,
    current_gate: Arc<Mutex<Option<Arc<control::GenerationGate>>>>,
    writers: Arc<Mutex<Vec<Arc<Mutex<control::WriterTask>>>>>,
    /// Owned children whose bounded cleanup was not confirmed (see OwnedChild).
    retained: Arc<Mutex<Vec<Child>>>,
}

fn send_line(writer: &control::ControlWriter, message: &Value) -> Result<(), String> {
    let line = serde_json::to_vec(message).map_err(|_| "Некорректная команда ядра")?;
    writer
        .try_enqueue(line)
        .and_then(|receipt| receipt.wait_until(Instant::now() + Duration::from_secs(2)))
        .map_err(|error| format!("Канал ядра Enki недоступен ({error:?})"))
}

fn new_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Нет источника случайных чисел")?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

fn new_request_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "Нет источника случайных чисел")?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

fn ready_identity(ready: &Value, artifact: &Artifact) -> Result<(u16, String), String> {
    let port = ready["port"]
        .as_u64()
        .filter(|port| (1..=65535).contains(port))
        .ok_or("Среда выполнения не сообщила корректный порт")? as u16;
    let instance = ready["instance"]
        .as_str()
        .filter(|id| {
            id.len() == 36
                && id.bytes().enumerate().all(|(index, byte)| {
                    if [8, 13, 18, 23].contains(&index) {
                        byte == b'-'
                    } else {
                        byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
                    }
                })
        })
        .ok_or("Среда выполнения не сообщила корректный экземпляр")?;
    if ready["type"] != "ready"
        || ready["contract"].as_u64() != Some(CONTRACT)
        || ready["schema"].as_u64() != Some(artifact.schema)
        || ready["sdk"].as_str() != Some(artifact.sdk.as_str())
        || ready["version"].as_str() != Some(artifact.build.as_str())
    {
        return Err("Ответ готовности не совпадает с проверенным пакетом Pi SDK".into());
    }
    Ok((port, instance.to_string()))
}

// ------------------------------------------------------------------ artifact

/// Layout of the bundled artifact (see scripts/runtime/prepare.mjs):
///   agent-runtime/runtime-manifest.json
///   agent-runtime/node/bin/node | node/node.exe
///   agent-runtime/app/dist/main.js, app/node_modules/...
pub(crate) mod artifact;
mod config_commit;
mod config_fs;
mod control;
mod rotation;
mod vault;

pub struct Artifact {
    root: PathBuf,
    node: PathBuf,
    entry: PathBuf,
    version: String,
    sdk: String,
    build: String,
    schema: u64,
    digest: String,
}

fn artifact_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("ENKI_RUNTIME_DIR").map(PathBuf::from) {
        if dir.is_absolute() {
            return Ok(dir);
        }
        return Err("ENKI_RUNTIME_DIR должен быть абсолютным путём".into());
    }
    Ok(app
        .path()
        .resource_dir()
        .map_err(|_| "Каталог ресурсов Enki недоступен")?
        .join("agent-runtime"))
}

#[cfg(test)]
fn inside(root: &Path, relative: &str) -> Result<PathBuf, String> {
    artifact::safe_relative(relative)
        .then(|| root.join(relative))
        .ok_or_else(|| "Некорректный путь в манифесте среды выполнения".into())
}

/// Verify the complete immutable artifact at every activation; a previous .ok
/// marker is not evidence about its current bytes. This never executes Node.
pub fn locate(app: &tauri::AppHandle) -> Result<Artifact, String> {
    let root = artifact_root(app)?;
    let node_relative = if cfg!(windows) {
        "node/node.exe"
    } else {
        "node/bin/node"
    };
    let verified = artifact::verify(
        &root,
        artifact::Expected {
            contract: Some(CONTRACT),
            node: Some(node_relative),
            entry: Some("app/dist/main.js"),
            ..artifact::Expected::default()
        },
    )
    .map_err(|detail| {
        format!("Встроенная среда выполнения повреждена: {detail}. Переустановите Enki.")
    })?;
    for required in [
        "app/runtime-version.json",
        "app/runtime-lock.json",
        "app/package.json",
        "app/package-lock.json",
    ] {
        if !verified.manifest.files.contains_key(required) {
            return Err("Манифест не покрывает метаданные встроенного ядра".into());
        }
    }
    let info: Value = serde_json::from_slice(
        &fs::read(root.join("app/runtime-version.json"))
            .map_err(|_| "Метаданные ядра недоступны")?,
    )
    .map_err(|_| "Метаданные ядра повреждены")?;
    let sdk = info["sdk"]
        .as_str()
        .filter(|sdk| *sdk == env!("ENKI_PINNED_PI_SDK"))
        .ok_or("Версия Pi SDK не совпадает со встроенным контрактом")?
        .to_string();
    let build = info["version"]
        .as_str()
        .filter(|id| {
            id.len() == 16
                && id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .ok_or("Некорректный идентификатор сборки ядра")?
        .to_string();
    if verified.manifest.version != format!("{sdk}-{build}") {
        return Err("Версия пакета и идентификатор сборки ядра различаются".into());
    }
    let schema = env!("ENKI_RUNTIME_SCHEMA")
        .parse()
        .map_err(|_| "Контракт схемы Enki повреждён")?;
    Ok(Artifact {
        root: verified.root,
        node: verified.node,
        entry: verified.entry,
        version: verified.manifest.version,
        sdk,
        build,
        schema,
        digest: verified.manifest_sha256,
    })
}

static BUNDLED_NODE: Mutex<Option<PathBuf>> = Mutex::new(None);
/// The verified bundled interpreter (known after the first runtime start);
/// the managed browser runtime prefers it over any user-installed Node.
pub fn known_bundled_node() -> Option<PathBuf> {
    BUNDLED_NODE.lock().ok().and_then(|n| n.clone())
}

fn data_dir() -> Result<PathBuf, String> {
    let dir = crate::paths::app_data_dir()?.join("runtime");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

fn command(artifact: &Artifact) -> Result<Command, String> {
    let mut command = Command::new(&artifact.node);
    command.arg(&artifact.entry);
    command.args(["--data"]).arg(data_dir()?);
    if crate::paths::profile_override()?.is_none() {
        let home = crate::paths::user_home()?;
        command
            .arg("--user-pi-agent-dir")
            .arg(home.join(".pi").join("agent"));
        command
            .arg("--pi-cli-root")
            .arg(crate::paths::app_data_dir()?.join("pi-sessions"));
        if let Ok(dir) = crate::paths::opencode_data_dir() {
            let db = dir.join("opencode.db");
            if db.is_file() {
                command.arg("--opencode-db").arg(db);
            }
        }
    }
    command.current_dir(&artifact.root);
    // User-controlled interpreter injection must not reach the runtime.
    for variable in [
        "NODE_OPTIONS",
        "NODE_PATH",
        "NODE_REPL_EXTERNAL_MODULE",
        "NODE_EXTRA_CA_CERTS_OVERRIDE",
    ] {
        command.env_remove(variable);
    }
    // Tools and language servers that are `#!/usr/bin/env node` scripts must
    // find the pinned interpreter, not whichever Node the user happens to have.
    if let Some(bin) = artifact.node.parent() {
        let mut paths = vec![bin.to_path_buf()];
        if let Some(inherited) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&inherited).filter(|p| p.is_absolute()));
        }
        command.env(
            "PATH",
            std::env::join_paths(paths).map_err(|e| e.to_string())?,
        );
    }
    own_process_group(&mut command);
    hide_console(&mut command);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Ok(command)
}

// -------------------------------------------------------------------- broker

// The OS vault is reachable only through `config_commit`: versioned immutable
// refs, CAS revisions and the import head. The former unconditional
// vault.write/vault.delete could overwrite or remove another writer's
// credential and are no longer served; legacy `pi-provider:` entries remain
// readable (revision 0) through vault.credentialRead.
fn broker(app: &tauri::AppHandle, method: &str, params: &Value) -> Result<Value, String> {
    if crate::runtime_ui::relayable(method) {
        return crate::runtime_ui::broker(app, method, params);
    }
    broker_core(method, params)
}
/// Local supervisor requests carry the owned child's generation and the live
/// admission of their own retained permit; only then may config/vault methods
/// run. Everything else uses the shared broker.
fn local_broker(
    app: &tauri::AppHandle,
    method: &str,
    params: &Value,
    generation: &str,
    admission: config_commit::Admission,
) -> Result<Value, String> {
    if config_commit::handles(method) {
        return config_commit::dispatch(method, params, Some((generation, admission)));
    }
    broker(app, method, params)
}
fn broker_core(method: &str, params: &Value) -> Result<Value, String> {
    match method {
        // Reached only without a generation (e.g. the remote relay): refused.
        m if config_commit::handles(m) => config_commit::dispatch(m, params, None),
        "hub.identity" => Ok(json!({ "scope": crate::hub::broker_identity()? })),
        "hub.request" => {
            let path = params["path"].as_str().ok_or("Не указан путь Hub")?;
            let scope = params["scope"].as_str().ok_or("Не указана область Hub")?;
            let body = params.get("body").filter(|b| !b.is_null()).cloned();
            crate::hub::broker_request(path, body, scope)
        }
        "capabilities.prepare" => {
            let directory = params["directory"].as_str().ok_or("Не указан каталог")?;
            crate::capabilities::runtime_scope(Path::new(directory))
        }
        _ => Err("Неизвестный запрос среды выполнения".into()),
    }
}

// ------------------------------------------------------------------ lifecycle

/// One admitted control request. Its permit is shared only with the
/// admission handed to the broker for this request, so the generation stays
/// in drain count until the broker call has returned AND the job is dropped
/// after its response frame is written.
struct BrokerJob {
    message: Value,
    permit: Arc<control::GenerationPermit>,
}

impl BrokerJob {
    /// Live predicate of THIS job's generation: false from the moment it is
    /// revoked. Owns a permit share, never a borrow or a global lookup.
    fn admission(&self) -> config_commit::Admission {
        let permit = self.permit.clone();
        Arc::new(move || permit.is_active())
    }

    /// Settle the request into its response frame. A revoked generation is
    /// refused before the broker; an admitted one is re-checked by the config
    /// authority at its OS lease. The caller sends the frame, then drops self.
    fn respond(
        &self,
        generation: &str,
        broker: impl FnOnce(&str, &Value, config_commit::Admission) -> Result<Value, String>,
    ) -> Value {
        let id = self.message["id"].as_str().unwrap_or_default();
        let method = self.message["method"].as_str().unwrap_or_default();
        let result = if self.permit.is_active() {
            broker(method, &self.message["params"], self.admission())
        } else {
            Err("Поколение ядра завершает работу".into())
        };
        match result {
            Ok(value) => {
                json!({"type":"response","id":id,"generation":generation,"ok":true,"value":value})
            }
            Err(error) => {
                json!({"type":"response","id":id,"generation":generation,"ok":false,"error":error})
            }
        }
    }
}

/// Owned identity and shared state of one launched generation, moved into its
/// reader and broker workers.
struct ReaderContext {
    gate: Arc<control::GenerationGate>,
    generation: String,
    current_gate: Arc<Mutex<Option<Arc<control::GenerationGate>>>>,
    activity: Arc<Mutex<Value>>,
    acks: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
}

fn spawn_reader(
    app: tauri::AppHandle,
    stdout: std::process::ChildStdout,
    writer: control::ControlWriter,
    ready: mpsc::SyncSender<Value>,
    context: ReaderContext,
) {
    let ReaderContext {
        gate,
        generation,
        current_gate,
        activity,
        acks,
    } = context;
    let (jobs, receiver) = mpsc::sync_channel::<BrokerJob>(16);
    let receiver = Arc::new(Mutex::new(receiver));
    for _ in 0..4 {
        let receiver = receiver.clone();
        let writer = writer.clone();
        let generation = generation.clone();
        let broker_app = app.clone();
        thread::spawn(move || loop {
            let job = match receiver.lock() {
                Ok(receiver) => receiver.recv(),
                Err(_) => break,
            };
            let Ok(job) = job else { break };
            let response = job.respond(&generation, |method, params, admission| {
                local_broker(&broker_app, method, params, &generation, admission)
            });
            let _ = send_line(&writer, &response);
            // Retained through the actual side effect and response; only now
            // does this job leave the drain count.
            drop(job);
        });
    }
    thread::spawn(move || {
        let is_current = || {
            current_gate.lock().is_ok_and(|current| {
                current
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &gate))
            })
        };
        let publish = |update: &dyn Fn(&mut Value) -> Option<Value>| {
            publish_if_current(&current_gate, &gate, &activity, update, &|event| {
                let _ = app.emit(STATUS_EVENT, event);
            })
        };
        let valid_activity = |message: &Value| {
            message["idle"].is_boolean()
                && ["running", "queued", "pending"]
                    .iter()
                    .all(|key| message[*key].as_u64().is_some())
        };
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        // EOF (Ok(false)) or a framing error ends the stream.
        while let Ok(true) = control::read_control_line(&mut reader, &mut line) {
            let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                break;
            };
            if message["generation"].as_str() != Some(generation.as_str()) {
                break;
            }
            match message["type"].as_str() {
                Some("ready") => {
                    // Authoritative initial snapshot, ordered before any later
                    // activity frame on this same stream. Absent/invalid stays
                    // conservatively non-idle.
                    let snapshot = &message["activity"];
                    if valid_activity(snapshot) && gate.is_active() {
                        let mut initial = snapshot.clone();
                        initial["type"] = json!("activity");
                        initial["instance"] = message["instance"].clone();
                        publish(&|state| {
                            *state = initial.clone();
                            Some(initial.clone())
                        });
                    }
                    let _ = ready.try_send(message);
                }
                Some("ack") => {
                    if !is_current() {
                        continue;
                    }
                    if let Some(id) = message["id"].as_str() {
                        if let Ok(mut waiters) = acks.lock() {
                            if let Some(waiter) = waiters.remove(id) {
                                let _ = waiter.send(message);
                            }
                        }
                    }
                }
                Some("activity") | Some("drained") => {
                    if message["type"] == "activity" && !valid_activity(&message) {
                        break;
                    }
                    if message["type"] == "activity" && !gate.is_active() {
                        continue;
                    }
                    publish(&|state| {
                        *state = message.clone();
                        Some(message.clone())
                    });
                }
                Some("request") => {
                    let valid = message["id"]
                        .as_str()
                        .is_some_and(|id| !id.is_empty() && id.len() <= 128)
                        && message["method"]
                            .as_str()
                            .is_some_and(|method| !method.is_empty() && method.len() <= 128);
                    if !valid {
                        break;
                    }
                    let permit = match gate.admit() {
                        Ok(permit) => permit,
                        Err(_) => {
                            let _ = send_line(
                                &writer,
                                &json!({"type":"response","id":message["id"],"generation":generation,"ok":false,"error":"Ядро занято или завершает работу"}),
                            );
                            continue;
                        }
                    };
                    let job = BrokerJob {
                        message,
                        permit: Arc::new(permit),
                    };
                    if let Err(error) = jobs.try_send(job) {
                        let job = match error {
                            mpsc::TrySendError::Full(job)
                            | mpsc::TrySendError::Disconnected(job) => job,
                        };
                        let _ = send_line(
                            &writer,
                            &json!({"type":"response","id":job.message["id"],"generation":generation,"ok":false,"error":"Превышено число запросов к нативному мосту"}),
                        );
                    }
                }
                _ => break,
            }
        }
        drop(jobs);
        gate.revoke();
        let unavailable = json!({"idle":false,"state":"unavailable","generation":generation});
        publish(&|current| {
            // Keep a final drain report available to Quit, but never keep an
            // old idle:true as authority after control EOF/failure.
            if current["type"] == "drained" {
                current["controlClosed"] = json!(true);
                current["idle"] = json!(false);
            } else {
                *current = unavailable.clone();
            }
            Some(unavailable.clone())
        });
    });
}

/// Generation check, state mutation and UI publication as ONE transition under
/// the current_gate lock. A replacement generation is installed under the same
/// lock, so an older reader can never overwrite it (or emit stale status)
/// between its check and its write. Lock order: current_gate, then activity.
fn publish_if_current(
    current_gate: &Mutex<Option<Arc<control::GenerationGate>>>,
    gate: &Arc<control::GenerationGate>,
    activity: &Mutex<Value>,
    update: &dyn Fn(&mut Value) -> Option<Value>,
    emit: &dyn Fn(Value),
) -> bool {
    let Ok(current) = current_gate.lock() else {
        return false;
    };
    if !current
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, gate))
    {
        return false;
    }
    let event = match activity.lock() {
        Ok(mut state) => update(&mut state),
        Err(_) => return false,
    };
    if let Some(event) = event {
        emit(event);
    }
    drop(current);
    true
}

/// The lifecycle start lock, waited for until `until` (never forever).
fn lock_until(start: &Mutex<()>, until: Instant) -> Result<std::sync::MutexGuard<'_, ()>, String> {
    loop {
        match start.try_lock() {
            Ok(lock) => return Ok(lock),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err("Состояние запуска ядра повреждено".into())
            }
            Err(std::sync::TryLockError::WouldBlock) if Instant::now() < until => {
                thread::sleep(Duration::from_millis(10))
            }
            Err(_) => {
                return Err(
                    "Предыдущая операция с ядром ещё не завершилась (lifecycle_busy).".into(),
                )
            }
        }
    }
}

/// Single-flight start shared by every concurrent `ensure`: callers serialize
/// on the start lock and RE-CHECK `live` under it, so only the first caller
/// launches and the others reuse what it published. A failed launch publishes
/// nothing; the next waiter then makes its own bounded attempt.
fn start_once<T>(
    start: &Mutex<()>,
    until: Instant,
    live: impl Fn() -> Result<Option<T>, String>,
    launch: impl FnOnce(&std::sync::MutexGuard<'_, ()>) -> Result<T, String>,
) -> Result<T, String> {
    let guard = lock_until(start, until)?;
    if let Some(existing) = live()? {
        return Ok(existing);
    }
    launch(&guard)
}

impl RuntimeSupervisor {
    fn live(&self) -> Result<Option<Connection>, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Состояние среды выполнения недоступно")?;
        if let Some(runtime) = inner.as_mut() {
            if runtime.alive() {
                return Ok(Some(Connection {
                    endpoint: format!("http://127.0.0.1:{}", runtime.port),
                    token: runtime.token.clone(),
                    instance: runtime.instance.clone(),
                    version: runtime.version.clone(),
                    contract: CONTRACT,
                }));
            }
        }
        Ok(None)
    }

    fn halted(&self) -> bool {
        self.stopping.load(Ordering::Acquire) || self.exiting.load(Ordering::Acquire)
    }

    fn own(&self, child: Child) -> OwnedChild {
        OwnedChild {
            child: Some(child),
            retained: self.retained.clone(),
        }
    }

    /// Idempotent: concurrent callers share one start; a live runtime is reused.
    pub fn ensure(&self, app: &tauri::AppHandle) -> Result<Connection, String> {
        let until = Instant::now() + READY_DEADLINE;
        if self.halted() {
            return Err("Ядро Enki завершает работу".into());
        }
        start_once(
            &self.start,
            until,
            || {
                self.reconcile_rotation(app)?;
                self.live()
            },
            |start| self.ensure_locked(app, until, start),
        )
    }

    /// Startup and shutdown share the start lock as one lifecycle barrier: a
    /// stop request (latched before it waits for the lock) aborts this start at
    /// every checkpoint, so no late ready commits a generation after cleanup.
    fn ensure_locked(
        &self,
        app: &tauri::AppHandle,
        until: Instant,
        _start: &std::sync::MutexGuard<'_, ()>,
    ) -> Result<Connection, String> {
        if self.halted() || app.state::<crate::lifecycle::Lifecycle>().closing() {
            return Err("Enki завершает работу; новые агенты не запускаются".into());
        }
        crate::updates::ensure_writable()?;
        if let Some(connection) = self.live()? {
            return Ok(connection);
        }
        {
            let mut inner = self.inner.lock().map_err(|_| "Состояние ядра недоступно")?;
            if let Some(previous) = inner.as_mut() {
                previous.gate.revoke();
                let cleanup_until = until.min(Instant::now() + Duration::from_secs(5));
                if !crate::process::terminate_group_until(&mut previous.child, cleanup_until) {
                    return Err(
                        "Предыдущее ядро ещё останавливается; повторный запуск отложен".into(),
                    );
                }
                previous.writer.revoke();
                if !previous.gate.wait_drained_until(cleanup_until) {
                    return Err("Нативные операции предыдущего ядра ещё завершаются".into());
                }
            }
            *inner = None;
        }
        {
            let mut writers = self
                .writers
                .lock()
                .map_err(|_| "Состояние канала ядра недоступно")?;
            writers.retain(|writer| {
                writer
                    .lock()
                    .map_or(true, |mut task| !task.reap_if_finished())
            });
            if !writers.is_empty() {
                return Err(
                    "Канал предыдущего ядра ещё закрывается; повторите подключение позже".into(),
                );
            }
        }
        // A child whose earlier cleanup was not confirmed still owns resources.
        if !reap_retained(&self.retained, until.min(Instant::now() + CHILD_CLEANUP)) {
            return Err(
                "Предыдущий процесс ядра ещё завершается; запуск отложен (reap_pending).".into(),
            );
        }
        if let Some(previous) = self
            .current_gate
            .lock()
            .map_err(|_| "Состояние запуска недоступно")?
            .as_ref()
        {
            if !previous.wait_drained_until(Instant::now() + Duration::from_secs(2)) {
                return Err(
                    "Предыдущее ядро ещё завершает нативный запрос. Повторите подключение позже."
                        .into(),
                );
            }
        }
        let gate = control::GenerationGate::new(
            self.next_generation.fetch_add(1, Ordering::AcqRel) + 1,
            24,
        );
        let mut startup = StartingGeneration {
            gate: gate.clone(),
            committed: false,
        };
        {
            // Same lock order as the readers (current_gate, then activity), so
            // the new generation and its state are published as one transition.
            let mut current = self
                .current_gate
                .lock()
                .map_err(|_| "Состояние запуска недоступно")?;
            *current = Some(gate.clone());
            *self
                .activity
                .lock()
                .map_err(|_| "Состояние ядра недоступно")? =
                json!({"idle":false,"state":"starting","nativeGeneration":gate.generation});
        }
        let artifact = locate(app)?;
        if self.halted() || Instant::now() >= until {
            return Err("Запуск ядра отменён или превысил время ожидания".into());
        }
        if let Ok(mut node) = BUNDLED_NODE.lock() {
            *node = Some(artifact.node.clone());
        }
        let token = new_token()?;
        let generation = new_token()?;
        let configure_id = new_request_id()?;
        // Windows: created suspended and resumed only after kill-on-close Job
        // assignment, so no runtime descendant can start outside the Job.
        #[cfg(target_os = "windows")]
        let (mut child, job) = {
            let (child, job) = crate::process::spawn_in_job(&mut command(&artifact)?)
                .map_err(|error| format!("Не удалось запустить ядро Enki: {error}"))?;
            (self.own(child), job)
        };
        #[cfg(not(target_os = "windows"))]
        let mut child = self.own(
            command(&artifact)?
                .spawn()
                .map_err(|error| format!("Не удалось запустить ядро Enki: {error}"))?,
        );
        let pipe = child.stdin.take().ok_or("Нет канала ввода ядра")?;
        let (writer, writer_task) = control::ControlWriter::start(pipe);
        let writer_task = Arc::new(Mutex::new(writer_task));
        self.writers
            .lock()
            .map_err(|_| "Состояние канала ядра недоступно")?
            .push(writer_task.clone());
        let stdout = child.stdout.take().ok_or("Нет канала вывода ядра")?;
        let stderr = child
            .stderr
            .take()
            .map(|pipe| OutputTail::follow(pipe, STDERR_TAIL))
            .unwrap_or_default();
        let (sender, receiver) = mpsc::sync_channel(1);
        let acks = Arc::new(Mutex::new(HashMap::new()));
        spawn_reader(
            app.clone(),
            stdout,
            writer.clone(),
            sender,
            ReaderContext {
                gate: gate.clone(),
                generation: generation.clone(),
                current_gate: self.current_gate.clone(),
                activity: self.activity.clone(),
                acks: acks.clone(),
            },
        );
        let executable = std::env::current_exe().map_err(|_| "Путь Enki недоступен")?;
        let mut origins: Vec<&str> = ORIGINS.to_vec();
        if cfg!(debug_assertions) {
            origins.extend(["http://localhost:1425", "http://127.0.0.1:1425"]);
        }
        send_line(
            &writer,
            &json!({"type":"configure","requestId":configure_id,"generation":generation,
            "token":token,"origins":origins,"version":env!("CARGO_PKG_VERSION"),"executable":executable}),
        )?;
        let ready = loop {
            if self.halted() || !gate.is_active() {
                return Err("Запуск ядра прерван".into());
            }
            let remaining = until.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(
                    "Ядро Enki не подтвердило готовность за 60 секунд (ready_timeout).".into(),
                );
            }
            match receiver.recv_timeout(remaining.min(Duration::from_millis(100))) {
                Ok(ready) => break ready,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => return Err("Канал запуска ядра Enki закрылся (control_closed).".into()),
            }
        };
        if ready["requestId"].as_str() != Some(configure_id.as_str()) {
            return Err("Ответ готовности относится к другому запуску".into());
        }
        let (port, instance) = ready_identity(&ready, &artifact)?;
        if self.halted() || !gate.is_active() {
            return Err("Запуск ядра отменён".into());
        }
        let supervised = Supervised {
            child,
            writer,
            writer_task,
            gate,
            generation,
            acks,
            port,
            token: token.clone(),
            pending_rotation: None,
            instance: instance.clone(),
            version: artifact.version.clone(),
            _stderr: stderr,
            #[cfg(target_os = "windows")]
            _job: Some(job),
        };
        let connection = Connection {
            endpoint: format!("http://127.0.0.1:{port}"),
            token,
            instance,
            version: artifact.version,
            contract: CONTRACT,
        };
        *self.inner.lock().map_err(|_| "Состояние ядра недоступно")? = Some(supervised);
        startup.committed = true;
        Ok(connection)
    }

    fn lock_start_until(&self, until: Instant) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        lock_until(&self.start, until)
    }

    /// Publish a replacement bearer only after the exact runtime ACK.
    pub fn rotate(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let until = Instant::now() + Duration::from_secs(5);
        let _start = self.lock_start_until(until)?;
        if self.halted() {
            return Err("Ядро завершает работу".into());
        }
        let mut inner = self.inner.lock().map_err(|_| "Состояние ядра недоступно")?;
        let Some(runtime) = inner.as_mut() else {
            return Ok(());
        };
        if !runtime.alive() {
            return Err("Связь с ядром недоступна".into());
        }
        // A failed ACK may already have installed the replacement. Keep its
        // exact id/token across calls instead of leaving an expired old token
        // authoritative for another six hours or issuing a different rotation.
        if runtime.pending_rotation.is_none() {
            runtime.pending_rotation = Some(rotation::PendingRotation::new(
                new_request_id()?,
                new_token()?,
            ));
        }
        Self::settle_rotation(runtime, app)
    }

    /// Called under the lifecycle start lock before returning credentials to
    /// any reconnecting WebView. Never restart work to repair authentication.
    fn reconcile_rotation(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "Состояние ядра недоступно")?;
        if let Some(runtime) = inner.as_mut() {
            if runtime.alive() && runtime.pending_rotation.is_some() {
                Self::settle_rotation(runtime, app)?;
            }
        }
        Ok(())
    }

    fn settle_rotation(runtime: &mut Supervised, app: &tauri::AppHandle) -> Result<(), String> {
        let Some(pending) = runtime.pending_rotation.take() else {
            return Ok(());
        };
        let result = pending.resolve(|id, token| {
            let message = json!({"type":"rotate","token":token,"graceMs":120000});
            let mut outcome = runtime.transact_id(
                "rotate",
                message.clone(),
                id,
                Instant::now() + Duration::from_secs(5),
            );
            if matches!(outcome, Err(AckError::Uncertain(_))) && runtime.alive() {
                outcome = runtime.transact_id(
                    "rotate",
                    message,
                    id,
                    Instant::now() + Duration::from_secs(5),
                );
            }
            outcome.map_err(AckError::into_message)?;
            if !runtime.gate.is_active() {
                return Err("Ядро отключилось во время обновления подключения".into());
            }
            Ok(())
        });
        match result {
            Ok(token) => {
                runtime.token = token;
                let _ = app.emit(TOKEN_EVENT, json!({"instance":runtime.instance}));
                Ok(())
            }
            Err((pending, _)) => {
                runtime.pending_rotation = Some(pending);
                Err("Обновление доступа к ядру пока не подтверждено. Подключение будет повторено; задания сохранены.".into())
            }
        }
    }

    pub fn activity(&self) -> Value {
        self.activity
            .lock()
            .map(|value| value.clone())
            .unwrap_or(Value::Null)
    }

    pub fn begin_maintenance(&self) -> Result<(), String> {
        let until = Instant::now() + Duration::from_secs(30);
        let start = self.lock_start_until(until)?;
        if self.halted() {
            return Err("Ядро завершает работу".into());
        }
        self.begin_maintenance_locked(until, &start)
    }

    /// Success means this exact generation holds the fence AND completed its
    /// private backup (the runtime ACKs begin only after backupForUpdate).
    /// An uncertain begin is reconciled by the read-only `status` of that exact
    /// requestId (ordered after it on the same channel, so `unknown` proves it
    /// never arrived); begin is never re-sent. If it stays uncertain, the fence
    /// is ended by a confirmed `end` (serialized after the pending begin by the
    /// runtime) or, failing that, by stopping this exact owned child.
    fn begin_maintenance_locked(
        &self,
        until: Instant,
        start: &std::sync::MutexGuard<'_, ()>,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "Состояние ядра недоступно")?;
        let Some(runtime) = inner.as_mut() else {
            return Ok(());
        };
        if !runtime.alive() || !runtime.gate.wait_drained_until(Instant::now()) {
            return Err("Ядро недоступно или ещё завершает системный запрос".into());
        }
        let begin = new_request_id()?;
        let message = json!({"type":"maintenance","mode":"begin"});
        let error = match runtime.transact_id("maintenance", message, &begin, until) {
            Ok(_) => return Ok(()),
            // Not sent, or an exact ACK with ok:false (the runtime ends its own
            // fence when backup fails): no fence is held by this request.
            Err(AckError::NotSent(error) | AckError::Refused(error)) => {
                return Err(format!(
                    "Обновление пока не может начать обслуживание: {error}"
                ))
            }
            Err(AckError::Uncertain(error)) => error,
        };
        let settle = Instant::now() + Duration::from_secs(10);
        while runtime.alive() {
            let status = runtime.transact(
                "maintenance",
                json!({"type":"maintenance","mode":"status","target":begin}),
                settle,
            );
            match status
                .as_ref()
                .ok()
                .filter(|ack| ack["target"] == begin.as_str())
            {
                // The original request's own receipt: fence held, backup done.
                Some(ack) if ack["state"] == "held" => return Ok(()),
                Some(ack)
                    if matches!(ack["state"].as_str(), Some("unknown" | "failed" | "ended")) =>
                {
                    return Err(format!(
                        "Обслуживание не началось (подтверждено ядром): {error}"
                    ))
                }
                Some(ack) if ack["state"] == "pending" && Instant::now() < settle => {
                    thread::sleep(Duration::from_millis(100))
                }
                _ => break,
            }
        }
        let ended = runtime.alive()
            && runtime
                .transact(
                    "maintenance",
                    json!({"type":"maintenance","mode":"end"}),
                    Instant::now() + Duration::from_secs(5),
                )
                .is_ok();
        if ended {
            return Err(format!(
                "Обслуживание не началось (подтверждена отмена): {error}"
            ));
        }
        // Fence state of this generation is unknown: end it with its process.
        runtime.gate.revoke();
        if let Ok(mut state) = self.activity.lock() {
            *state = json!({"idle":false,"state":"maintenance-uncertain"});
        }
        drop(inner);
        let stopped = self.shutdown_locked(Instant::now() + Duration::from_secs(20), start);
        Err(match stopped {
            Ok(()) => format!("Обслуживание не подтверждено; ядро остановлено безопасно: {error}"),
            Err(stop) => format!("Обслуживание не подтверждено: {error}; {stop}"),
        })
    }

    pub fn end_maintenance(&self) -> Result<(), String> {
        let until = Instant::now() + Duration::from_secs(3);
        let _start = self.lock_start_until(until)?;
        let inner = self.inner.lock().map_err(|_| "Состояние ядра недоступно")?;
        if let Some(runtime) = inner.as_ref() {
            runtime.transact(
                "maintenance",
                json!({"type":"maintenance","mode":"end"}),
                until,
            )?;
        } else if !self.exiting.load(Ordering::Acquire) {
            // Proven cancellation (the installer never started) after a
            // verified stop may reconnect to the same installed code. No
            // stopped command is replayed. Application exit is never undone.
            self.stopping.store(false, Ordering::Release);
        }
        Ok(())
    }

    /// Ok only when no maintenance fence of this process can still be held:
    /// an exact `end` ACK (bounded retries, each a fresh id; ending is
    /// idempotent), or else the exact owned runtime stopped and reaped. A
    /// failed stop is returned and the caller keeps its native gate closed.
    pub fn release_maintenance(&self) -> Result<(), String> {
        let mut last = String::new();
        for attempt in 0..3 {
            if attempt > 0 {
                thread::sleep(Duration::from_millis(250));
            }
            match self.end_maintenance() {
                Ok(()) => return Ok(()),
                Err(error) => last = error,
            }
        }
        self.shutdown_checked(Duration::from_secs(20))
            .map_err(|stop| format!("{last}; {stop}"))?;
        // Stopped: no runtime holds a fence. This clears the stop latch exactly
        // like a proven cancellation (application exit stays permanent).
        self.end_maintenance()
    }

    /// A diagnostic only. Installation additionally acquires the runtime's
    /// synchronous maintenance fence; a stale activity frame is insufficient.
    pub fn idle(&self) -> bool {
        if self.halted() {
            return false;
        }
        let Ok(_start) = self.start.try_lock() else {
            return false;
        };
        let Ok(mut inner) = self.inner.try_lock() else {
            return false;
        };
        let Ok(gate) = self.current_gate.try_lock() else {
            return false;
        };
        if gate
            .as_ref()
            .is_some_and(|gate| !gate.wait_drained_until(Instant::now()))
        {
            return false;
        }
        match inner.as_mut() {
            // No supervised runtime is NOT idle while a failed start still has
            // an unfinished writer or an owned child whose cleanup is unproven.
            None => {
                let writers_closed = self.writers.try_lock().is_ok_and(|mut writers| {
                    writers.retain(|writer| {
                        writer
                            .lock()
                            .map_or(true, |mut task| !task.reap_if_finished())
                    });
                    writers.is_empty()
                });
                writers_closed && self.retained.try_lock().is_ok_and(|kept| kept.is_empty())
            }
            Some(runtime) => runtime.alive() && self.activity()["idle"].as_bool() == Some(true),
        }
    }

    /// Fence new starts first, then drain, kill and reap under one total budget.
    /// A failed cleanup retains ownership and blocks replacement generations.
    pub fn shutdown_checked(&self, budget: Duration) -> Result<(), String> {
        let until = Instant::now() + budget;
        self.latch_stop();
        let start = self.lock_start_until(until)?;
        self.shutdown_locked(until, &start)
    }

    /// Latch before waiting for the start lock: an in-progress start observes
    /// it at its next checkpoint and aborts instead of committing late.
    fn latch_stop(&self) -> u64 {
        self.stopping.store(true, Ordering::Release);
        let request = self.stop_requests.fetch_add(1, Ordering::AcqRel) + 1;
        if let Ok(gate) = self.current_gate.lock() {
            if let Some(gate) = gate.as_ref() {
                gate.revoke();
            }
        }
        request
    }

    fn shutdown_locked(
        &self,
        until: Instant,
        _start: &std::sync::MutexGuard<'_, ()>,
    ) -> Result<(), String> {
        let budget = until.saturating_duration_since(Instant::now());
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Состояние остановки ядра недоступно")?;
        let Some(runtime) = inner.as_mut() else {
            return Ok(());
        };
        let reserve = Duration::from_millis(500).min(budget / 2);
        let drain_until = until.checked_sub(reserve).unwrap_or(until);
        if runtime.process_alive() {
            // An ACK failure cannot prevent cleanup of this exact owned child.
            let _ = runtime.transact("shutdown", json!({"type":"shutdown","mode":"drain",
                "deadlineMs":drain_until.saturating_duration_since(Instant::now()).as_millis() as u64}), drain_until);
        }
        while runtime.process_alive() && Instant::now() < drain_until {
            thread::sleep(Duration::from_millis(10));
        }
        #[cfg(target_os = "windows")]
        {
            runtime._job.take();
        }
        if !crate::process::terminate_group_until(&mut runtime.child, until) {
            return Err(
                "Ядро ещё завершает работу; повторный запуск заблокирован (reap_pending).".into(),
            );
        }
        runtime.writer.revoke();
        while !runtime
            .writer_task
            .lock()
            .is_ok_and(|task| task.is_finished())
            && Instant::now() < until
        {
            thread::sleep(Duration::from_millis(5));
        }
        let writer_closed = runtime
            .writer_task
            .lock()
            .is_ok_and(|mut task| task.reap_if_finished());
        let brokers_closed = runtime.gate.wait_drained_until(until);
        if !writer_closed || !brokers_closed {
            return Err("Нативные запросы ядра ещё завершаются; повторный запуск заблокирован (drain_pending).".into());
        }
        *inner = None;
        Ok(())
    }

    /// Application exit: permanent for this process; never cleared by a later
    /// maintenance end, restart or failed installer handoff.
    pub fn shutdown(&self, budget: Duration) {
        self.exiting.store(true, Ordering::Release);
        let _ = self.shutdown_checked(budget);
    }

    /// Installer handoff succeeded: this process must not start a runtime again.
    pub fn retire(&self) {
        self.exiting.store(true, Ordering::Release);
    }

    /// Fence, backup, drain, reap and start again under ONE start-lock hold, so
    /// no other start or stop interleaves. A stop requested by anyone else in
    /// the meantime (quit, update) wins: the replacement is then not started.
    pub fn restart(&self, app: &tauri::AppHandle) -> Result<Connection, String> {
        let until = Instant::now() + Duration::from_secs(30);
        if self.halted() {
            return Err("Ядро Enki завершает работу".into());
        }
        let start = self.lock_start_until(until)?;
        if self.halted() {
            return Err("Ядро Enki завершает работу".into());
        }
        self.begin_maintenance_locked(until, &start)?;
        let mine = self.latch_stop();
        self.shutdown_locked(Instant::now() + Duration::from_secs(20), &start)?;
        if self.exiting.load(Ordering::Acquire)
            || self.stop_requests.load(Ordering::Acquire) != mine
        {
            return Err("Перезапуск отменён: запрошена остановка Enki".into());
        }
        self.stopping.store(false, Ordering::Release);
        self.ensure_locked(app, Instant::now() + READY_DEADLINE, &start)
    }
}

#[tauri::command]
pub async fn runtime_connection(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Connection, String> {
    if window.label() != "main" {
        return Err("Только главное окно подключается к среде выполнения".into());
    }
    let supervisor = app.state::<RuntimeSupervisor>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || supervisor.ensure(&app))
        .await
        .map_err(|_| "Запуск среды выполнения прерван".to_string())?
}

#[tauri::command]
pub async fn runtime_status(app: tauri::AppHandle) -> Result<Value, String> {
    let supervisor = app.state::<RuntimeSupervisor>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let live = supervisor.live()?;
        let artifact = locate(&app);
        Ok(json!({
            "running": live.is_some(),
            "version": live.as_ref().map(|c| c.version.clone()),
            "bundled": artifact.as_ref().ok().map(|a| &a.version),
            "artifactDigest": artifact.as_ref().ok().map(|a| &a.digest),
            "error": artifact.err(),
            "activity": supervisor.activity(),
        }))
    })
    .await
    .map_err(|_| "Состояние среды выполнения недоступно".to_string())?
}

/// Explicit user action only: drains, stops and starts the runtime again.
#[tauri::command]
pub async fn runtime_restart(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Connection, String> {
    if window.label() != "main" {
        return Err("Только главное окно управляет средой выполнения".into());
    }
    let supervisor = app.state::<RuntimeSupervisor>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !supervisor.idle() {
            return Err(
                "Агент ещё работает. Остановите задачи перед перезапуском среды выполнения."
                    .to_string(),
            );
        }
        supervisor.restart(&app)
    })
    .await
    .map_err(|_| "Перезапуск прерван".to_string())?
}

/// A remote runtime (SSH host) asks the attached desktop for Hub operations.
/// Relays the pinned Hub client and gesture-scoped UI operations. OS-vault secrets and
/// local capability paths never leave this computer.
#[tauri::command]
pub async fn runtime_broker_relay(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    method: String,
    params: Value,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Только главное окно отвечает удалённой среде выполнения".into());
    }
    if !relayable(&method) {
        return Err("Это действие недоступно удалённой среде выполнения".into());
    }
    tauri::async_runtime::spawn_blocking(move || broker(&app, &method, &params))
        .await
        .map_err(|_| "Запрос прерван".to_string())?
}

fn relayable(method: &str) -> bool {
    matches!(method, "hub.identity" | "hub.request") || crate::runtime_ui::relayable(method)
}

/// Periodic token rotation while the app runs.
pub fn start_rotation(app: tauri::AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(6 * 3600));
        let supervisor = app.state::<RuntimeSupervisor>().inner().clone();
        // Short bounded reconciliation after a lost ACK, rather than waiting
        // six hours with a token which may expire in two minutes.
        for attempt in 0..3 {
            if supervisor.rotate(&app).is_ok() {
                break;
            }
            if attempt < 2 {
                thread::sleep(Duration::from_secs(15));
            }
        }
    });
}

/// Explicit application exit.
pub fn shutdown(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<RuntimeSupervisor>() {
        state.inner().shutdown(Duration::from_secs(30));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    /// Production `ensure` seam with an own launch factory (no tauri app, no
    /// installed process): eight concurrent callers start exactly ONE runtime.
    #[test]
    fn concurrent_ensure_starts_one_runtime_and_every_caller_reuses_it() {
        let start = Arc::new(Mutex::new(()));
        let published: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));
        let launches = Arc::new(AtomicU32::new(0));
        let until = Instant::now() + Duration::from_secs(10);
        let callers: Vec<_> = (0..8)
            .map(|_| {
                let (start, published, launches) =
                    (start.clone(), published.clone(), launches.clone());
                thread::spawn(move || {
                    start_once(
                        &start,
                        until,
                        || Ok(*published.lock().unwrap()),
                        |_guard| {
                            let instance = launches.fetch_add(1, Ordering::SeqCst) + 1;
                            // A slow start: every other caller is already waiting.
                            thread::sleep(Duration::from_millis(50));
                            *published.lock().unwrap() = Some(instance);
                            Ok(instance)
                        },
                    )
                })
            })
            .collect();
        let results: Vec<u32> = callers
            .into_iter()
            .map(|c| c.join().unwrap().unwrap())
            .collect();
        assert_eq!(launches.load(Ordering::SeqCst), 1);
        assert!(results.iter().all(|instance| *instance == 1), "{results:?}");
    }

    /// A failed start publishes nothing; the next waiter retries once on its
    /// own and no caller ever observes two published runtimes.
    #[test]
    fn a_failed_start_is_not_shared_as_success_and_never_duplicates_a_runtime() {
        let start = Arc::new(Mutex::new(()));
        let published: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));
        let launches = Arc::new(AtomicU32::new(0));
        let until = Instant::now() + Duration::from_secs(10);
        let callers: Vec<_> = (0..4)
            .map(|_| {
                let (start, published, launches) =
                    (start.clone(), published.clone(), launches.clone());
                thread::spawn(move || {
                    start_once(
                        &start,
                        until,
                        || Ok(*published.lock().unwrap()),
                        |_guard| {
                            let attempt = launches.fetch_add(1, Ordering::SeqCst) + 1;
                            thread::sleep(Duration::from_millis(20));
                            if attempt == 1 {
                                return Err("first start failed".to_string());
                            }
                            let mut slot = published.lock().unwrap();
                            assert!(slot.is_none(), "a second runtime would be published");
                            *slot = Some(attempt);
                            Ok(attempt)
                        },
                    )
                })
            })
            .collect();
        let results: Vec<Result<u32, String>> =
            callers.into_iter().map(|c| c.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_err()).count(), 1);
        assert!(
            results.iter().flatten().all(|instance| *instance == 2),
            "{results:?}"
        );
        assert_eq!(launches.load(Ordering::SeqCst), 2);
        // A lock held past the deadline is a bounded refusal, not a hang.
        let held = start.lock().unwrap();
        let refused = start_once(
            &start,
            Instant::now() + Duration::from_millis(30),
            || Ok(None::<u32>),
            |_guard| Ok(9),
        );
        drop(held);
        assert!(refused.unwrap_err().contains("lifecycle_busy"));
    }

    #[test]
    fn application_exit_and_installer_handoff_are_never_undone_by_maintenance_end() {
        let exit = RuntimeSupervisor::default();
        exit.shutdown(Duration::from_millis(200));
        assert!(exit.halted());
        exit.end_maintenance().unwrap();
        assert!(
            exit.halted(),
            "a later fence release must not reopen starts after quit"
        );
        assert!(!exit.idle());

        let retired = RuntimeSupervisor::default();
        retired
            .shutdown_checked(Duration::from_millis(200))
            .unwrap();
        retired.retire();
        retired.end_maintenance().unwrap();
        assert!(
            retired.halted(),
            "installer handoff is permanent for this process"
        );
    }

    #[test]
    fn maintenance_stop_is_released_only_by_proven_cancellation() {
        let supervisor = RuntimeSupervisor::default();
        supervisor
            .shutdown_checked(Duration::from_millis(200))
            .unwrap();
        assert!(
            supervisor.halted(),
            "stop latch blocks starts until cancellation is proven"
        );
        supervisor.end_maintenance().unwrap();
        assert!(!supervisor.halted());
    }

    #[test]
    fn release_without_a_runtime_reopens_only_after_proof() {
        let supervisor = RuntimeSupervisor::default();
        supervisor.latch_stop();
        supervisor.release_maintenance().unwrap();
        assert!(!supervisor.halted(), "no runtime: no fence can be held");
    }

    #[cfg(unix)]
    #[test]
    fn owned_child_drop_is_bounded_and_unconfirmed_cleanup_blocks_idle() {
        let supervisor = RuntimeSupervisor::default();
        assert!(supervisor.idle());
        // TERM-ignoring child: the bounded drop must escalate, never hang.
        let mut stubborn = Command::new("/bin/sh");
        stubborn.args(["-c", "trap '' TERM; /bin/sleep 30"]);
        own_process_group(&mut stubborn);
        let started = Instant::now();
        drop(supervisor.own(stubborn.spawn().unwrap()));
        assert!(started.elapsed() < CHILD_CLEANUP + Duration::from_secs(2));
        assert!(supervisor.retained.lock().unwrap().is_empty());
        // A child whose cleanup was not confirmed is retained, never dropped.
        let mut sleeper = Command::new("/bin/sleep");
        sleeper.arg("30");
        own_process_group(&mut sleeper);
        supervisor
            .retained
            .lock()
            .unwrap()
            .push(sleeper.spawn().unwrap());
        assert!(!supervisor.idle(), "an unreaped owned child is not idle");
        assert!(reap_retained(
            &supervisor.retained,
            Instant::now() + Duration::from_secs(5)
        ));
        assert!(supervisor.idle());
    }

    #[test]
    fn an_old_reader_cannot_overwrite_a_newer_generation() {
        let current_gate = Mutex::new(None);
        let activity = Mutex::new(json!({}));
        let old = control::GenerationGate::new(1, 4);
        let new = control::GenerationGate::new(2, 4);
        *current_gate.lock().unwrap() = Some(old.clone());
        // Publication happens while the generation lock is still held, so a
        // replacement cannot be installed between check and write.
        let held = publish_if_current(
            &current_gate,
            &old,
            &activity,
            &|state| {
                *state = json!({"idle":true,"generation":1});
                Some(state.clone())
            },
            &|_| {
                assert!(
                    current_gate.try_lock().is_err(),
                    "emitted outside the transition"
                )
            },
        );
        assert!(held);
        *current_gate.lock().unwrap() = Some(new.clone());
        *activity.lock().unwrap() = json!({"idle":false,"state":"starting"});
        let stale = publish_if_current(
            &current_gate,
            &old,
            &activity,
            &|state| {
                *state = json!({"idle":true,"generation":1});
                Some(state.clone())
            },
            &|_| panic!("stale generation emitted"),
        );
        assert!(!stale);
        assert_eq!(activity.lock().unwrap()["state"], "starting");
    }

    #[test]
    fn every_stop_request_is_counted_so_a_restart_cannot_override_it() {
        let supervisor = RuntimeSupervisor::default();
        let restart = supervisor.latch_stop();
        let concurrent = supervisor.latch_stop();
        assert_ne!(restart, concurrent);
        assert_ne!(supervisor.stop_requests.load(Ordering::Acquire), restart);
    }

    #[test]
    fn manifest_paths_cannot_escape_the_artifact() {
        let root = Path::new("/artifact");
        assert!(inside(root, "node/bin/node").is_ok());
        for bad in [
            "",
            "/etc/passwd",
            "../x",
            "a/../../b",
            "a\\b",
            "a//b",
            "./a",
        ] {
            assert!(inside(root, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn vault_is_reachable_only_through_versioned_local_config_methods() {
        for id in ["deepseek", "a.b_c-1"] {
            assert!(vault::valid_provider(id));
        }
        for bad in ["", "../x", "a b", "pi-provider:x", "x".repeat(129).as_str()] {
            assert!(!vault::valid_provider(bad), "{bad}");
        }
        // Unconditional write/delete no longer exist on any path.
        for method in ["vault.read", "vault.write", "vault.delete", "vault.list"] {
            assert!(
                broker_core(method, &json!({ "account": "pi-provider:x", "value": "v" })).is_err(),
                "{method}"
            );
        }
        // Without a supervisor generation every config/vault method is refused
        // before touching the OS vault or filesystem.
        for method in [
            "config.begin",
            "config.secretRead",
            "vault.compareAndSet",
            "vault.credentialRead",
        ] {
            let error = broker_core(method, &json!({})).unwrap_err();
            assert!(error.starts_with("CONFIG_LOCAL_ONLY"), "{method}: {error}");
        }
    }

    #[test]
    fn broker_job_admission_is_its_own_live_permit_and_holds_the_drain() {
        let gate = control::GenerationGate::new(9, 2);
        let job = BrokerJob {
            message: json!({"type":"request","id":"r1","method":"config.current","params":{"x":1}}),
            permit: Arc::new(gate.admit().unwrap()),
        };
        let mut kept = None;
        let response = job.respond("gen-9", |method, params, admission| {
            assert_eq!((method, &params["x"]), ("config.current", &json!(1)));
            assert!(admission());
            gate.revoke();
            // The admission handed to the authority observes revoke at once.
            assert!(!admission());
            assert!(
                gate.admit().is_err(),
                "nothing new is admitted after revoke"
            );
            kept = Some(admission);
            Err(config_commit::E_REVOKED.into())
        });
        assert_eq!(
            (
                response["id"].as_str(),
                response["generation"].as_str(),
                response["ok"].as_bool()
            ),
            (Some("r1"), Some("gen-9"), Some(false))
        );
        assert!(
            !gate.wait_drained_until(Instant::now()),
            "job retained until dropped"
        );
        drop(job);
        // The admission owns a permit share (not a borrow): still owned work.
        assert!(!gate.wait_drained_until(Instant::now()));
        drop(kept);
        assert!(gate.wait_drained_until(Instant::now()));
    }

    #[test]
    fn tokens_are_long_and_url_safe() {
        let token = new_token().unwrap();
        assert!(token.len() >= 43);
        assert!(token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_ne!(token, new_token().unwrap());
    }

    #[test]
    fn remote_relay_never_exposes_the_vault_or_local_paths() {
        assert!(relayable("hub.request") && relayable("hub.identity"));
        for method in [
            "vault.read",
            "vault.list",
            "vault.write",
            "vault.compareAndSet",
            "vault.credentialRead",
            "config.begin",
            "config.secretPut",
            "config.secretRead",
            "config.current",
            "capabilities.prepare",
            "shell",
        ] {
            assert!(!relayable(method), "{method}");
        }
    }

    #[test]
    fn unknown_broker_methods_are_refused() {
        assert!(broker_core("shell.exec", &json!({})).is_err());
        assert!(broker_core("hub.request", &json!({ "path": "devices", "scope": "x" })).is_err());
    }
}
