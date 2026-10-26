//! Compilation runs only in a fresh signed snapshot, never in an owner project.
use super::{
    install::Plan,
    packet::{self, Verified},
    root,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
#[path = "../../native_fingerprint.rs"]
mod native_fingerprint;

/// Publisher credentials an owner shell may carry (current and legacy names,
/// as scripts/releases/operator.mjs sets them). The app never needs them: the
/// GUI removes them from its own environment at startup (lib.rs) and every
/// build stage removes them again, so no downloaded source's npm/build script,
/// runtime, tool or MCP child can inherit them.
pub(crate) const WITHHELD_ENV: [&str; 5] = [
    "ENKI_HUB_ADMIN_TOKEN",
    "ARVELA_HUB_ADMIN_TOKEN",
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PATH",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
];

/// A device source build compiles with at most two jobs (an explicit `1` is
/// kept) so an update cannot saturate the owner's machine. Cargo reads the
/// variable in every stage, including the Tauri CLI's own `cargo build`.
fn build_jobs(inherited: Option<&str>) -> &'static str {
    match inherited.map(str::trim) {
        Some("1") => "1",
        _ => "2",
    }
}
pub struct Build {
    state: Mutex<Value>,
    cancel: AtomicBool,
    running: AtomicBool,
    prepared: Mutex<Option<(String, Plan)>>,
}
impl Default for Build {
    fn default() -> Self {
        Self {
            state: Mutex::new(json!({"stage":"idle"})),
            cancel: AtomicBool::new(false),
            running: AtomicBool::new(false),
            prepared: Mutex::new(None),
        }
    }
}
impl Build {
    pub fn status(&self) -> Value {
        let mut state = self
            .state
            .lock()
            .map(|s| s.clone())
            .unwrap_or(json!({"stage":"error","error":"Build state unavailable"}));
        state["digest"] = self
            .prepared
            .lock()
            .ok()
            .and_then(|p| p.as_ref().map(|(digest, _)| json!(digest)))
            .unwrap_or(Value::Null);
        if let Some(started) = state["startedAt"].as_u64() {
            let end = state["finishedAt"].as_u64().unwrap_or_else(now_ms);
            state["elapsedSeconds"] = json!(end.saturating_sub(started) / 1000);
        }
        if let Some(log) = state["logPath"].as_str() {
            let status = Path::new(log).with_file_name(".enki-build-cache-status.json");
            let cache = fs::metadata(&status)
                .ok()
                .filter(|m| m.len() < 4096)
                .and_then(|_| fs::read(&status).ok())
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
            state["logBytes"] = json!(fs::metadata(log).map(|m| m.len()).unwrap_or(0));
            if let Some(cache) = cache {
                state["cache"] = cache;
            }
        }
        state
    }
    pub fn running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Release);
    }
    pub fn shutdown(&self) {
        self.cancel();
        let start = Instant::now();
        while self.running() && start.elapsed() < Duration::from_secs(12) {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    pub fn start(self: &Arc<Self>, v: Verified, digest: String) -> Result<(), String> {
        let lease = super::lease()?;
        if self.running.swap(true, Ordering::AcqRel) {
            return Err("Сборка уже выполняется".into());
        }
        self.cancel.store(false, Ordering::Release);
        *self.prepared.lock().map_err(|e| e.to_string())? = None;
        self.set(json!({"stage":"preparing","version":v.packet.version,"mode":"source"}));
        let this = self.clone();
        std::thread::spawn(move || {
            let _lease = lease;
            let result = this.compile(v, &digest);
            match result {
                Ok(plan) => {
                    *this.prepared.lock().unwrap_or_else(|e| e.into_inner()) = Some((digest, plan));
                    this.set(json!({"stage":"ready"}));
                }
                Err(e) => this.set(json!({"stage":"error","error":e})),
            }
            this.running.store(false, Ordering::Release);
        });
        Ok(())
    }
    pub(super) fn start_binary(
        self: &Arc<Self>,
        package: super::native::Package,
        version: String,
        digest: String,
    ) -> Result<(), String> {
        let lease = super::lease()?;
        if self.running.swap(true, Ordering::AcqRel) {
            return Err("Обновление уже подготавливается".into());
        }
        self.cancel.store(false, Ordering::Release);
        *self.prepared.lock().map_err(|e| e.to_string())? = None;
        self.set(json!({"stage":"preparing","version":version,"mode":"binary"}));
        let this = self.clone();
        std::thread::spawn(move || {
            let _lease = lease;
            let result = (|| {
                let directory = fresh_attempt(&root()?, &digest)?;
                super::native::prepare(&this, &package, &version, &directory)
            })();
            match result {
                Ok(plan) => {
                    *this.prepared.lock().unwrap_or_else(|e| e.into_inner()) = Some((digest, plan));
                    this.set(json!({"stage":"ready"}));
                }
                Err(e) => this.set(json!({"stage":"error","error":e})),
            }
            this.running.store(false, Ordering::Release);
        });
        Ok(())
    }
    pub(super) fn check_cancel(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Acquire) {
            Err("Подготовка обновления отменена".into())
        } else {
            Ok(())
        }
    }
    pub(super) fn set(&self, value: Value) {
        if let Ok(mut s) = self.state.lock() {
            if value["stage"] == "preparing" || value["stage"] == "idle" {
                *s = value;
                if s["stage"] == "preparing" {
                    s["startedAt"] = json!(now_ms());
                }
            } else if let Some(fields) = value.as_object() {
                for (key, value) in fields {
                    s[key] = value.clone();
                }
                if s["stage"] == "ready" || s["stage"] == "error" {
                    s["finishedAt"] = json!(now_ms());
                }
            }
        }
    }
    pub fn prepared(&self, digest: &str) -> Result<Plan, String> {
        self.prepared
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .filter(|(d, _)| d == digest)
            .map(|(_, p)| p.clone())
            .ok_or("Сначала соберите выбранное обновление".into())
    }
    fn compile(&self, v: Verified, digest: &str) -> Result<Plan, String> {
        validate_identity(&v)?;
        let tools = Tools::find()?;
        let directory = fresh_attempt(&root()?, digest)?;
        packet::extract(&v.files, &directory)?;
        if native_fingerprint::fingerprint(&directory.join("src-tauri"))?
            != v.packet.native_fingerprint
        {
            return Err("Состав исходников не соответствует нативной версии".into());
        }
        let log = directory.join("build.log");
        self.set(json!({"logPath":log}));
        // Best-effort acceleration. Missing Hub support never blocks compilation.
        let cache_file = directory.join(".enki-build-cache.json");
        let cache = crate::hub::build_cache_lease()
            .ok()
            .filter(|value| super::atomic(&cache_file, value).is_ok());
        struct SecretFile(PathBuf);
        impl Drop for SecretFile {
            fn drop(&mut self) {
                let _ = fs::remove_file(&self.0);
            }
        }
        let _cache_file_guard = SecretFile(cache_file.clone());
        self.set(json!({"cache": {"state":if cache.is_some() {"preparing"} else {"unavailable"}}}));
        for (stage, args, limit) in [
            (
                "dependencies",
                vec!["ci", "--no-audit", "--no-fund"],
                Duration::from_secs(15 * 60),
            ),
            // Pinned Node.js + Pi SDK runtime artifact, verified against
            // runtime-lock.json and the agent package-lock (fails closed).
            ("runtime", runtime_args(), Duration::from_secs(20 * 60)),
            ("compiling", build_args(), Duration::from_secs(40 * 60)),
        ] {
            self.set(json!({"stage":stage,"version":v.packet.version}));
            let mut cmd = Command::new(&tools.node);
            cmd.arg(&tools.npm)
                .args(args)
                .current_dir(&directory)
                .env("PATH", &tools.path)
                .env("CARGO_TARGET_DIR", directory.join("src-tauri/target"))
                .env(
                    "CARGO_BUILD_JOBS",
                    build_jobs(std::env::var("CARGO_BUILD_JOBS").ok().as_deref()),
                )
                .env_remove("TAURI_CONFIG")
                .env_remove("CARGO_BUILD_TARGET")
                .env_remove("ENKI_BUILD_JOB_RUNNER");
            cmd.env_remove("ENKI_BUILD_CACHE_CONFIG");
            if stage == "compiling" && cache.is_some() {
                cmd.env("ENKI_BUILD_CACHE_CONFIG", &cache_file);
            }
            // Windows runtime preparation compiles its own native Job runner
            // from this authenticated packet (scripts/runtime/build-runner.mjs)
            // before any job; no installed or packet-supplied executable is
            // passed, so older installed builders drive the same path.
            for key in WITHHELD_ENV {
                cmd.env_remove(key);
            }
            self.run(&mut cmd, &log, limit).map_err(|error| {
                let phase = match stage {
                    "dependencies" => "Установка зависимостей",
                    "runtime" => "Подготовка компонентов Enki",
                    _ => "Компиляция приложения",
                };
                format!("{phase}: {error}")
            })?;
        }
        let artifact = artifact(&directory)?;
        let plan = Plan::create(&artifact, &v.packet.version)?;
        super::atomic(&directory.join("install-plan.json"), &plan)?;
        Ok(plan)
    }
    pub(super) fn run(&self, cmd: &mut Command, log: &Path, limit: Duration) -> Result<(), String> {
        let out = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
            .map_err(|e| e.to_string())?;
        cmd.stdin(Stdio::null())
            .stdout(out.try_clone().map_err(|e| e.to_string())?)
            .stderr(out);
        crate::process::hide_console(cmd);
        // Windows: created suspended and resumed only inside its kill-on-close
        // Job; Unix: own process group. Never attach after the child is running.
        let mut tree = crate::process::OwnedTree::spawn(cmd)
            .map_err(|e| format!("Не удалось запустить сборку: {e}"))?;
        let start = Instant::now();
        loop {
            // Observed without reaping, so the whole owned tree is settled
            // (Job / pinned process group) before the primary is released.
            if tree.primary_exited().map_err(|e| e.to_string())? {
                let settled = tree.settle(Duration::from_secs(10));
                let Some(status) = settled.status.filter(|_| settled.complete) else {
                    return Err(format!(
                        "Процессы сборки не завершились полностью. Лог: {}",
                        log.display()
                    ));
                };
                if status.success() {
                    return Ok(());
                }
                return Err(format!(
                    "Сборка завершилась с кодом {:?}. {} Лог: {}",
                    status.code(),
                    failure_detail(log),
                    log.display()
                ));
            }
            let cancelled = self.cancel.load(Ordering::Acquire);
            if cancelled
                || start.elapsed() > limit
                || fs::metadata(log).is_ok_and(|m| m.len() > 8 * 1024 * 1024)
            {
                // Bounded: TERM grace, then the whole owned tree is killed.
                let settled = tree.stop(Duration::from_secs(2), Duration::from_secs(10));
                if !settled.complete {
                    return Err(format!(
                        "Сборку не удалось остановить полностью. Лог: {}",
                        log.display()
                    ));
                }
                return Err(if cancelled {
                    "Сборка отменена".into()
                } else {
                    format!("Превышено время или размер лога. Лог: {}", log.display())
                });
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    pub fn clear(&self) -> Result<(), String> {
        if self.running() {
            return Err("Сначала отмените сборку".into());
        }
        for entry in fs::read_dir(root()?).map_err(|e| e.to_string())? {
            let p = entry.map_err(|e| e.to_string())?.path();
            if p.file_name().is_some_and(|n| {
                n.to_string_lossy()
                    .strip_prefix("build-")
                    .is_some_and(packet::hash_ok)
            }) && !p.is_symlink()
            {
                fs::remove_dir_all(p).map_err(|e| e.to_string())?;
            }
        }
        *self.prepared.lock().map_err(|e| e.to_string())? = None;
        self.set(json!({"stage":"idle"}));
        Ok(())
    }
}

/// Read-only, bounded prerequisite probe. The UI only offers an explicit source
/// build when this passes; a download failure can never trigger compilation.
pub(super) fn prerequisites() -> Value {
    let result = (|| -> Result<(), String> {
        let tools = Tools::find()?;
        let mut cmd;
        #[cfg(target_os = "macos")]
        {
            cmd = Command::new("/usr/bin/xcrun");
            cmd.args(["--find", "clang"]);
        }
        #[cfg(target_os = "linux")]
        {
            cmd = Command::new("pkg-config");
            cmd.args([
                "--exists",
                "gtk+-3.0",
                "webkit2gtk-4.1",
                "libsoup-3.0",
                "openssl",
                "ayatana-appindicator3-0.1",
            ]);
        }
        #[cfg(target_os = "windows")]
        {
            let base = std::env::var_os("ProgramFiles(x86)")
                .ok_or("Не найдены Visual Studio Build Tools")?;
            cmd = Command::new(
                PathBuf::from(base).join("Microsoft Visual Studio/Installer/vswhere.exe"),
            );
            cmd.args([
                "-latest",
                "-products",
                "*",
                "-requires",
                "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
                "-property",
                "installationPath",
            ]);
        }
        cmd.env("PATH", tools.path);
        let out = crate::process::output_with_timeout(&mut cmd, Duration::from_secs(10), 4096)
            .map_err(|_| "Не найдены системные инструменты сборки Tauri")?;
        if !out.status.success() || (cfg!(windows) && out.stdout.is_empty()) {
            return Err("Не установлены системные зависимости Tauri. Можно дождаться готового пакета GitHub.".into());
        }
        Ok(())
    })();
    match result {
        Ok(()) => json!({"available":true}),
        Err(e) => json!({"available":false,"reason":e}),
    }
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn failure_detail(log: &Path) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let read = || -> std::io::Result<String> {
        let mut file = fs::File::open(log)?;
        let length = file.metadata()?.len();
        file.seek(SeekFrom::Start(length.saturating_sub(8192)))?;
        let mut bytes = Vec::new();
        file.take(8192).read_to_end(&mut bytes)?;
        let text = String::from_utf8_lossy(&bytes);
        Ok(text
            .lines()
            .rev()
            .find(|line| {
                line.starts_with("runtime:prepare:")
                    || line.starts_with("npm error code ")
                    || line.starts_with("error: ")
            })
            .unwrap_or("")
            .chars()
            .take(500)
            .collect())
    };
    read().unwrap_or_default()
}
/// An explicit retry gets a fresh verified source tree. Prior diagnostics remain
/// available until the owner clears builds; partial node_modules are never reused.
fn attempt_name() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(format!(
        "attempt-{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}
fn fresh_attempt(root: &Path, digest: &str) -> Result<PathBuf, String> {
    if !packet::hash_ok(digest) {
        return Err("Некорректный идентификатор сборки".into());
    }
    let parent = root.join(format!("build-{digest}"));
    if parent.is_symlink() || (parent.exists() && !parent.is_dir()) {
        return Err("Папка сборки занята посторонним файлом; он сохранён".into());
    }
    fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    Ok(parent.join(attempt_name()?))
}
fn validate_identity(v: &Verified) -> Result<(), String> {
    for name in [
        "package.json",
        "package-lock.json",
        "src-tauri/tauri.conf.json",
    ] {
        let value: Value =
            serde_json::from_slice(v.files.get(name).ok_or("Missing source manifest")?)
                .map_err(|_| "Invalid source manifest")?;
        if value["version"] != v.packet.version {
            return Err("Версии манифестов не совпадают".into());
        }
        if name == "src-tauri/tauri.conf.json"
            && (value["identifier"] != "dev.local.opencodedesktop"
                || !matches!(value["productName"].as_str(), Some("Arvela" | "Enki")))
        {
            return Err("Источник меняет идентификатор приложения".into());
        }
    }
    let cargo = std::str::from_utf8(
        v.files
            .get("src-tauri/Cargo.toml")
            .ok_or("Missing Cargo manifest")?,
    )
    .map_err(|_| "Invalid Cargo manifest")?;
    if !cargo.contains(&format!("version = \"{}\"", v.packet.version))
        || !(cargo.contains("name = \"arvela\"") || cargo.contains("name = \"enki\""))
    {
        return Err("Invalid native package identity".into());
    }
    Ok(())
}
fn runtime_platform() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "darwin-arm64";
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "win32-x64";
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "linux-x64";
    #[allow(unreachable_code)]
    "unsupported"
}
fn runtime_args() -> Vec<&'static str> {
    vec![
        "run",
        "runtime:prepare",
        "--",
        "--platform",
        runtime_platform(),
    ]
}
fn build_args() -> Vec<&'static str> {
    let mut args = platform_args();
    args.extend([
        "--config",
        "src-tauri/tauri.runtime.conf.json",
        "--ci",
        "--",
        "--locked",
    ]);
    args
}
fn platform_args() -> Vec<&'static str> {
    #[cfg(target_os = "macos")]
    return vec![
        "run",
        "tauri",
        "--",
        "build",
        "--bundles",
        "app",
        "--config",
        r#"{"bundle":{"macOS":{"signingIdentity":"-"}}}"#,
    ];
    #[cfg(target_os = "windows")]
    return vec!["run", "tauri", "--", "build", "--bundles", "nsis"];
    #[cfg(target_os = "linux")]
    return vec![
        "run",
        "tauri",
        "--",
        "build",
        "--bundles",
        if std::env::var_os("APPIMAGE").is_some() {
            "appimage"
        } else if Path::new("/usr/bin/dpkg").exists() {
            "deb"
        } else {
            "rpm"
        },
    ];
}
fn artifact(dir: &Path) -> Result<PathBuf, String> {
    let root = dir.join("src-tauri/target/release/bundle");
    #[cfg(target_os = "macos")]
    {
        let candidates: Vec<_> = ["macos/Enki.app", "macos/Arvela.app"]
            .into_iter()
            .map(|p| root.join(p))
            .filter(|p| p.is_dir())
            .collect();
        if candidates.len() == 1 {
            Ok(candidates[0].clone())
        } else {
            Err("Не найден единственный пакет приложения".into())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        #[cfg(target_os = "windows")]
        let (sub, suffix) = ("nsis", ".exe");
        #[cfg(target_os = "linux")]
        let (sub, suffix) = if std::env::var_os("APPIMAGE").is_some() {
            ("appimage", ".AppImage")
        } else if Path::new("/usr/bin/dpkg").exists() {
            ("deb", ".deb")
        } else {
            ("rpm", ".rpm")
        };
        let candidates: Vec<_> = fs::read_dir(root.join(sub))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .is_some_and(|s| s.to_string_lossy().ends_with(suffix))
            })
            .collect();
        if candidates.len() != 1 {
            return Err("Не найден единственный установочный пакет".into());
        }
        Ok(candidates[0].clone())
    }
}
struct Tools {
    node: PathBuf,
    npm: PathBuf,
    path: std::ffi::OsString,
}
impl Tools {
    fn find() -> Result<Self, String> {
        let mut dirs = std::env::var_os("PATH")
            .map(|s| std::env::split_paths(&s).collect::<Vec<_>>())
            .unwrap_or_default();
        if let Ok(home) = crate::paths::user_home() {
            dirs.extend([home.join(".cargo/bin"), home.join(".local/bin")]);
        }
        #[cfg(unix)]
        dirs.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ]);
        #[cfg(windows)]
        if let Some(p) = std::env::var_os("ProgramFiles") {
            dirs.push(PathBuf::from(p).join("nodejs"));
        }
        let path = std::env::join_paths(&dirs).map_err(|e| e.to_string())?;
        let locate = |name: &str| -> Result<PathBuf, String> {
            let name = if cfg!(windows) {
                format!("{name}.exe")
            } else {
                name.into()
            };
            dirs.iter().map(|d|d.join(&name)).find(|p|p.is_file()).ok_or(format!("Не установлен {name}. Подготовьте Node.js/npm, Rust/Cargo и зависимости Tauri для вашей ОС."))
        };
        let node = locate("node")?;
        for tool in ["node", "cargo", "rustc"] {
            let mut c = Command::new(locate(tool)?);
            c.arg("--version").env("PATH", &path);
            let out = crate::process::output_with_timeout(&mut c, Duration::from_secs(10), 4096)
                .map_err(|_| format!("{tool}: не удалось проверить инфраструктуру сборки"))?;
            if !out.status.success() {
                return Err(format!(
                    "{tool} недоступен. Проверьте инфраструктуру сборки."
                ));
            }
        }
        let npm = if cfg!(windows) {
            node.parent()
                .ok_or("Missing Node parent")?
                .join("node_modules/npm/bin/npm-cli.js")
        } else {
            dirs.iter()
                .map(|d| d.join("npm"))
                .find(|p| p.is_file())
                .and_then(|p| fs::canonicalize(p).ok())
                .ok_or("Не установлен npm")?
        };
        if !npm.is_file() {
            return Err("Не найден npm-cli.js рядом с Node.js".into());
        }
        Ok(Self { node, npm, path })
    }
}

#[cfg(test)]
pub(super) fn source_fingerprint_for_test(v: &Verified) -> Result<String, String> {
    validate_identity(v)?;
    let dir = std::env::temp_dir().join(format!(
        "arvela-signed-source-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    ));
    packet::extract(&v.files, &dir)?;
    let result = native_fingerprint::fingerprint(&dir.join("src-tauri"));
    let _ = fs::remove_dir_all(dir);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retry_preserves_diagnostics_and_extracts_into_a_fresh_attempt() {
        let root =
            std::env::temp_dir().join(format!("enki-retry-test-{}", attempt_name().unwrap()));
        fs::create_dir(&root).unwrap();
        let digest = "a".repeat(64);
        let previous = root.join(format!("build-{digest}"));
        fs::create_dir(&previous).unwrap();
        fs::write(previous.join("build.log"), "network failure").unwrap();
        let first = fresh_attempt(&root, &digest).unwrap();
        let second = fresh_attempt(&root, &digest).unwrap();
        assert_ne!(first, second);
        assert!(!first.exists());
        assert_eq!(
            fs::read_to_string(previous.join("build.log")).unwrap(),
            "network failure"
        );
        assert!(fresh_attempt(&root, "../foreign").is_err());
        fs::write(
            previous.join("build.log"),
            "progress\nruntime:prepare: connection to nodejs.org failed\n",
        )
        .unwrap();
        assert!(failure_detail(&previous.join("build.log")).contains("nodejs.org"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn build_status_keeps_version_log_and_elapsed_after_failure() {
        let build = Build::default();
        build.set(json!({"stage":"preparing","version":"2.0.6"}));
        build.set(json!({"stage":"runtime","logPath":"test.log"}));
        build.set(json!({"stage":"error","error":"network unavailable"}));
        let status = build.status();
        assert_eq!(status["version"], "2.0.6");
        assert_eq!(status["logPath"], "test.log");
        assert!(status["elapsedSeconds"].is_u64());
        build.set(json!({"stage":"preparing","version":"2.0.7"}));
        assert!(build.status()["error"].is_null());
        assert!(build.status()["logPath"].is_null());
    }
    #[test]
    fn status_is_renderable_before_any_build() {
        assert_eq!(Build::default().status()["stage"], "idle");
    }
    #[test]
    fn cargo_build_is_locked_and_noninteractive() {
        let args = build_args();
        assert!(args.ends_with(&["--ci", "--", "--locked"]));
    }
    #[test]
    fn device_builds_bundle_the_verified_runtime_artifact() {
        let args = build_args();
        let at = args
            .iter()
            .position(|a| *a == "src-tauri/tauri.runtime.conf.json")
            .unwrap();
        assert_eq!(args[at - 1], "--config");
        assert_eq!(runtime_args()[..2], ["run", "runtime:prepare"]);
    }
    #[test]
    fn device_builds_are_capped_at_two_jobs() {
        let inherited = [
            None,
            Some(""),
            Some("0"),
            Some("2"),
            Some("16"),
            Some("-1"),
            Some("x"),
        ];
        for value in inherited {
            assert_eq!(build_jobs(value), "2", "{value:?}");
        }
        assert_eq!(build_jobs(Some("1")), "1", "an explicit lower cap is kept");
    }
    #[test]
    fn current_and_legacy_publisher_credentials_are_withheld() {
        // Exactly the secret names scripts/releases/operator.mjs exports.
        let operator = include_str!("../../../scripts/releases/operator.mjs");
        for key in [
            "ENKI_HUB_ADMIN_TOKEN",
            "ARVELA_HUB_ADMIN_TOKEN",
            "TAURI_SIGNING_PRIVATE_KEY_PATH",
            "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
        ] {
            let exported = format!("{key}:");
            assert!(operator.contains(&exported), "{key} is exported");
            assert!(WITHHELD_ENV.contains(&key), "{key} is withheld");
        }
        assert!(WITHHELD_ENV.contains(&"TAURI_SIGNING_PRIVATE_KEY"));
    }
}
