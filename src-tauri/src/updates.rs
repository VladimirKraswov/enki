//! Signed artifacts only. Native maintenance gate remains closed through backup
//! and installation; checks/downloads may run while agents are working.
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
static MAINTENANCE: AtomicBool = AtomicBool::new(false);
#[derive(Default)]
pub struct Updates {
    release: Mutex<Option<Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
    busy: AtomicBool,
}
pub fn ensure_writable() -> Result<(), String> {
    if MAINTENANCE.load(Ordering::Acquire) {
        Err("Устанавливается обновление. Новые задания временно остановлены.".into())
    } else {
        Ok(())
    }
}
struct ReleaseGate;
pub(crate) struct Maintenance {
    gate: Option<ReleaseGate>,
    supervisor: crate::runtime::RuntimeSupervisor,
}
impl Maintenance {
    pub(crate) async fn acquire(app: &tauri::AppHandle) -> Result<Self, String> {
        if MAINTENANCE.swap(true, Ordering::AcqRel) {
            return Err("Уже выполняется обслуживание".into());
        }
        let gate = ReleaseGate;
        let supervisor = app
            .state::<crate::runtime::RuntimeSupervisor>()
            .inner()
            .clone();
        let check = supervisor.clone();
        tauri::async_runtime::spawn_blocking(move || check.begin_maintenance())
            .await
            .map_err(|_| "Проверка обслуживания прервана")??;
        Ok(Self {
            gate: Some(gate),
            supervisor,
        })
    }
}
impl Drop for Maintenance {
    fn drop(&mut self) {
        let Some(gate) = self.gate.take() else {
            return;
        };
        let supervisor = self.supervisor.clone();
        // Keep both gates held until the same owned runtime acknowledges end,
        // or until that exact runtime is stopped and reaped (its fence ends
        // with it). If neither is proven, the native gate is never reopened
        // over a possibly held fence. Never runs on the native UI thread.
        std::thread::spawn(move || match supervisor.release_maintenance() {
            Ok(()) => drop(gate),
            Err(_) => std::mem::forget(gate),
        });
    }
}

impl Drop for ReleaseGate {
    fn drop(&mut self) {
        MAINTENANCE.store(false, Ordering::Release);
    }
}
fn main(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Main window only".into())
    }
}
fn backup_root() -> Result<PathBuf, String> {
    let p = crate::paths::app_data_dir()?.join("update-backups");
    private(&p)?;
    Ok(p)
}
pub(crate) fn private(p: &Path) -> Result<(), String> {
    if p.is_symlink() {
        return Err("Backup cannot be a symbolic link".into());
    }
    fs::create_dir_all(p).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(p, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn snapshot(dir: &Path, data: &str) -> Result<(), String> {
    if data.len() > 200_000_000 {
        return Err("Резервная копия превышает 200 МБ".into());
    }
    let v: Value = serde_json::from_str(data).map_err(|e| e.to_string())?;
    if v["schema"] != 1 || !v["prefs"].is_object() || !v["attachments"].is_array() {
        return Err("Invalid backup data".into());
    }
    private(dir)?;
    let temp = dir.join("data.partial");
    fs::write(&temp, data).map_err(|e| e.to_string())?;
    // FlushFileBuffers requires write access on Windows, even after fs::write.
    fs::OpenOptions::new()
        .read(true)
        .write(cfg!(target_os = "windows"))
        .open(&temp)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    fs::rename(temp, dir.join("data.json")).map_err(|e| e.to_string())
}
pub(crate) fn backup(data: &str) -> Result<String, String> {
    let id = format!(
        "backup-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis()
    );
    let dir = backup_root()?.join(&id);
    snapshot(&dir, data)?;
    let journal = crate::paths::app_data_dir()?.join("recovery/operations.sqlite");
    if journal.exists() {
        let db = rusqlite::Connection::open(&journal).map_err(|e| e.to_string())?;
        db.busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        db.execute(
            "VACUUM INTO ?1",
            [dir.join("operations.sqlite").to_string_lossy().as_ref()],
        )
        .map_err(|e| e.to_string())?;
    }
    fs::write(dir.join("version.txt"), env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
    Ok(id)
}
/// Authoritative idle: the runtime itself reports no running turn, no pending
/// user answer and no queue item in flight. An unknown state is not idle.
pub(crate) async fn idle(app: &tauri::AppHandle) -> Result<(), String> {
    let supervisor = app
        .state::<crate::runtime::RuntimeSupervisor>()
        .inner()
        .clone();
    let idle = tauri::async_runtime::spawn_blocking(move || supervisor.idle())
        .await
        .map_err(|e| e.to_string())?;
    if idle {
        Ok(())
    } else {
        Err("Агент Enki ещё работает или ждёт вашего ответа. Установка отложена.".into())
    }
}
fn saved_path(id: &str) -> Result<PathBuf, String> {
    if !id.starts_with("backup-")
        || id.len() > 60
        || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("Invalid backup".into());
    }
    let dir = backup_root()?.join(id);
    if dir.is_symlink() {
        return Err("Invalid backup path".into());
    }
    Ok(dir)
}
#[tauri::command]
pub async fn app_update(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    action: String,
    channel: Option<String>,
    data: Option<String>,
    backup_id: Option<String>,
) -> Result<Value, String> {
    main(&window)?;
    let state = app.state::<Updates>();
    if state.busy.swap(true, Ordering::AcqRel) {
        return Err("Операция обновления уже выполняется".into());
    }
    let result = perform(&app, &action, channel.as_deref(), data, backup_id).await;
    state.busy.store(false, Ordering::Release);
    result
}
async fn perform(
    app: &tauri::AppHandle,
    action: &str,
    channel: Option<&str>,
    data: Option<String>,
    backup_id: Option<String>,
) -> Result<Value, String> {
    let state = app.state::<Updates>();
    match action {
        "check" => {
            let channel = channel.unwrap_or("stable");
            if !matches!(channel, "stable" | "preview") {
                return Err("Invalid update channel".into());
            }
            *state.release.lock().map_err(|e| e.to_string())? = None;
            *state.bytes.lock().map_err(|e| e.to_string())? = None;
            let url=format!("https://raw.githubusercontent.com/VladimirKraswov/enki/main/updates/{channel}.json");
            let update = app
                .updater_builder()
                .endpoints(vec![url.parse().map_err(|_| "Invalid feed")?])
                .map_err(|e| e.to_string())?
                .timeout(Duration::from_secs(120))
                .build()
                .map_err(|e| e.to_string())?
                .check()
                .await
                .map_err(|e| e.to_string())?;
            if let Some(ref u) = update {
                if u.download_url.scheme() != "https"
                    || u.download_url.host_str() != Some("github.com")
                    || ![
                        "/VladimirKraswov/enki/releases/download/",
                        "/VladimirKraswov/arvela/releases/download/",
                    ]
                    .iter()
                    .any(|prefix| u.download_url.path().starts_with(prefix))
                {
                    return Err("Неизвестный источник обновления".into());
                }
            }
            let reply = update
                .as_ref()
                .map(|u| json!({"version":u.version,"notes":u.body,"available":true}))
                .unwrap_or(json!({"available":false}));
            *state.release.lock().map_err(|e| e.to_string())? = update;
            Ok(reply)
        }
        "download" => {
            let update = state
                .release
                .lock()
                .map_err(|e| e.to_string())?
                .clone()
                .ok_or("Сначала проверьте обновления")?;
            let bytes = download(app, &update).await?;
            *state.bytes.lock().map_err(|e| e.to_string())? = Some(bytes);
            Ok(json!({"downloaded":true,"version":update.version}))
        }
        "backups" => {
            let mut items = vec![];
            for e in fs::read_dir(backup_root()?)
                .map_err(|e| e.to_string())?
                .flatten()
                .take(1000)
            {
                if !e.path().is_symlink() && e.path().join("data.json").is_file() {
                    items.push(json!({"id":e.file_name().to_string_lossy(),"version":fs::read_to_string(e.path().join("version.txt")).unwrap_or_default()}));
                }
            }
            items.sort_by(|a, b| b["id"].as_str().cmp(&a["id"].as_str()));
            Ok(json!(items))
        }
        "backup" | "restore" | "install" => {
            let _maintenance = Maintenance::acquire(app).await?;
            idle(app).await?;
            let data = data.ok_or("Нет текущей резервной копии")?;
            let id = tauri::async_runtime::spawn_blocking(move || backup(&data))
                .await
                .map_err(|e| e.to_string())??;
            if action == "backup" {
                return Ok(json!({"id":id}));
            }
            if action == "restore" {
                let dir = saved_path(&backup_id.ok_or("Выберите копию")?)?;
                let path = dir.join("data.json");
                if path.is_symlink()
                    || fs::metadata(&path).map_err(|e| e.to_string())?.len() > 200_000_000
                {
                    return Err("Invalid backup".into());
                }
                let saved: Value =
                    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                return Ok(json!({"beforeRestore":id,"data":saved}));
            }
            let update = state
                .release
                .lock()
                .map_err(|e| e.to_string())?
                .clone()
                .ok_or("Нет обновления")?;
            let bytes = state
                .bytes
                .lock()
                .map_err(|e| e.to_string())?
                .take()
                .ok_or("Сначала загрузите обновление")?;
            // Keep the currently installed Mac bundle for manual binary recovery.
            #[cfg(target_os = "macos")]
            {
                let exe = std::env::current_exe().map_err(|e| e.to_string())?;
                let bundle = exe
                    .ancestors()
                    .find(|p| p.extension().is_some_and(|x| x == "app"))
                    .ok_or("Установка доступна из пакета приложения")?
                    .to_path_buf();
                let target = saved_path(&id)?.join("Enki.app");
                // A bundle copy takes seconds: never on an async worker thread.
                let status = tauri::async_runtime::spawn_blocking(move || {
                    std::process::Command::new("/usr/bin/ditto")
                        .arg(bundle)
                        .arg(target)
                        .stdin(std::process::Stdio::null())
                        .status()
                })
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?;
                if !status.success() {
                    return Err("Не удалось сохранить предыдущую версию приложения".into());
                }
            }
            let supervisor = app
                .state::<crate::runtime::RuntimeSupervisor>()
                .inner()
                .clone();
            let stopping = supervisor.clone();
            tauri::async_runtime::spawn_blocking(move || {
                stopping.shutdown_checked(Duration::from_secs(20))
            })
            .await
            .map_err(|_| "Остановка ядра прервана")??;
            // On an install error Drop of `_maintenance` ends the fences and
            // permits reconnecting; bundle integrity after a failed Tauri
            // install is the updater plugin's contract, not verified here.
            tauri::async_runtime::spawn_blocking(move || {
                update.install(bytes).map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())??;
            supervisor.retire();
            std::mem::forget(_maintenance);
            app.restart();
        }
        _ => Err("Unknown update action".into()),
    }
}
// Tauri/minisign format, with the signed version required. Bounded streaming
// avoids allocating an unbounded HTTP response before signature verification.
pub(crate) fn verify(bytes: &[u8], signature: &str, version: &str) -> Result<(), String> {
    use base64::Engine;
    let decode = |s: &str| -> Result<String, String> {
        String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(s.trim())
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    };
    let key = minisign_verify::PublicKey::decode(&decode(include_str!("../updater.pub"))?)
        .map_err(|e| e.to_string())?;
    let signature =
        minisign_verify::Signature::decode(&decode(signature)?).map_err(|e| e.to_string())?;
    key.verify(bytes, &signature, true)
        .map_err(|e| e.to_string())?;
    let signed = signature
        .trusted_comment()
        .split('\t')
        .find_map(|s| s.strip_prefix("version:"));
    if signed != Some(version) {
        return Err("Версия не соответствует подписи пакета".into());
    }
    Ok(())
}
async fn download(app: &tauri::AppHandle, update: &Update) -> Result<Vec<u8>, String> {
    const MAX: usize = 512 * 1024 * 1024;
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(update.download_url.clone())
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;
    let total = response.content_length();
    if total.is_some_and(|n| n > MAX as u64) {
        return Err("Пакет превышает 512 МБ".into());
    }
    let mut bytes = Vec::new();
    let mut last = std::time::Instant::now();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if chunk.len() > MAX.saturating_sub(bytes.len()) {
            return Err("Пакет превышает 512 МБ".into());
        }
        bytes.extend_from_slice(&chunk);
        if last.elapsed() > Duration::from_millis(200) {
            let _ = app.emit(
                "app-update-progress",
                json!({"received":bytes.len(),"total":total}),
            );
            last = std::time::Instant::now();
        }
    }
    verify(&bytes, &update.signature, &update.version)?;
    Ok(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Opt-in release artifact signature verification using ARVELA_VERIFY_ARTIFACT"]
    fn verify_release_artifact() {
        let path = std::env::var("ARVELA_VERIFY_ARTIFACT").expect("artifact path");
        verify(
            &fs::read(&path).unwrap(),
            &fs::read_to_string(format!("{path}.sig")).unwrap(),
            env!("CARGO_PKG_VERSION"),
        )
        .unwrap();
    }
    #[test]
    fn signature_rejects_tampering_and_manifest_version_substitution() {
        let data = include_bytes!("../test-fixtures/update.txt");
        let sig = include_str!("../test-fixtures/update.txt.sig");
        verify(data, sig, "0.2.53").unwrap();
        assert!(verify(b"changed", sig, "0.2.53").is_err());
        assert!(verify(data, sig, "9.9.9").is_err());
    }
    #[test]
    fn backup_is_complete_or_absent_and_rejects_invalid_payload() {
        let p = std::env::temp_dir().join(format!(
            "arvela-backup-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        assert!(snapshot(&p, "{}").is_err());
        assert!(!p.exists());
        let body = r#"{"schema":1,"prefs":{"drafts":{"s":"keep me"}},"attachments":[]}"#;
        snapshot(&p, body).unwrap();
        assert_eq!(fs::read_to_string(p.join("data.json")).unwrap(), body);
        assert!(!p.join("data.partial").exists());
        fs::remove_dir_all(p).unwrap();
    }
}
