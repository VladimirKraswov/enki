//! Signed Hub releases. Transport metadata never authorizes code execution.
pub mod assets;
mod build;
pub mod install;
mod native;
mod packet;
use assets::HotAssets;
pub(crate) use build::WITHHELD_ENV as PUBLISHER_SECRET_ENV;
use packet::{Envelope, FINGERPRINT};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::Manager;
#[derive(Default)]
pub struct HubUpdates {
    checked: Mutex<Option<Checked>>,
    busy: AtomicBool,
    pub build: Arc<build::Build>,
}
#[derive(Clone)]
struct Checked {
    channel: String,
    identity: String,
    kind: String,
    digest: String,
    version: String,
    fingerprint: String,
    notes: String,
    binary: Value,
}
/// A checked release is only worth reporting while it is newer than the UI
/// that is actually running. A hot activation reloads only the webview, so the
/// cached check of the just-applied release would otherwise keep the update
/// badge lit until the user pressed "проверить обновление" by hand.
fn checked_is_newer(c: &Checked, ui_version: &str) -> bool {
    match (
        semver::Version::parse(&c.version),
        semver::Version::parse(ui_version),
    ) {
        (Ok(v), Ok(current)) => v > current,
        _ => false,
    }
}
struct Gate<'a>(&'a AtomicBool);
impl Drop for Gate<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
pub(super) fn lease() -> Result<fs::File, String> {
    let path = root()?.join("update.lock");
    if path.is_symlink() {
        return Err("Unsafe update lock".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    fs2::FileExt::try_lock_exclusive(&file)
        .map_err(|_| "В другом экземпляре Enki уже выполняется обновление или сборка")?;
    Ok(file)
}
pub fn root() -> Result<PathBuf, String> {
    let p = crate::paths::app_data_dir()?.join("update-runtime");
    crate::updates::private(&p)?;
    Ok(p)
}
pub fn read_json<T: DeserializeOwned>(p: &Path) -> Result<T, String> {
    if p.is_symlink() || fs::metadata(p).map_err(|e| e.to_string())?.len() > 64 * 1024 * 1024 {
        return Err("Unsafe update cache".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(p)
        .map_err(|e| e.to_string())?
        .take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "Invalid update cache".into())
}
pub fn atomic<T: Serialize>(p: &Path, value: &T) -> Result<(), String> {
    if p.is_symlink() {
        return Err("Update file is a symbolic link".into());
    }
    let raw = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let tmp = p.with_extension(format!(
        "{}-{}.partial",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut f = options.open(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&raw)
            .and_then(|_| f.sync_all())
            .map_err(|e| e.to_string())?;
        // Windows rename cannot replace an existing file. ReplaceFileW below
        // preserves the atomic old-or-new contract rather than unlinking it.
        replace(&tmp, p)
    })();
    let _ = fs::remove_file(tmp);
    result
}
#[cfg(not(windows))]
fn replace(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|e| e.to_string())
}
#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) } == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}
fn checked(app: &tauri::AppHandle, channel: Option<&str>) -> Result<Checked, String> {
    let c = app
        .state::<HubUpdates>()
        .checked
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("Сначала проверьте обновления")?;
    if channel != Some(c.channel.as_str()) {
        return Err("Канал обновлений изменился. Проверьте обновления заново.".into());
    }
    if crate::hub::release_identity()? != c.identity {
        return Err("Подключение Hub изменилось. Проверьте обновления заново.".into());
    }
    Ok(c)
}
fn collect_cache(retained: &[String]) -> Result<(), String> {
    let mut files = fs::read_dir(root()?)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            !p.is_symlink()
                && p.file_stem()
                    .is_some_and(|n| packet::hash_ok(&n.to_string_lossy()))
                && p.extension().is_some_and(|e| e == "json")
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|p| std::cmp::Reverse(fs::metadata(p).and_then(|m| m.modified()).ok()));
    for path in files.iter().skip(8) {
        if !retained
            .iter()
            .any(|d| path.file_stem().is_some_and(|n| n == d.as_str()))
        {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
fn verified(c: &Checked) -> Result<packet::Verified, String> {
    let e: Envelope = read_json(&root()?.join(format!("{}.json", c.digest)))?;
    packet::verify(&e, &c.digest, &c.version, &c.kind, &c.fingerprint)
}
#[tauri::command]
pub async fn hub_update(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    action: String,
    channel: Option<String>,
    data: Option<String>,
    digest: Option<String>,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Main window only".into());
    }
    let state = app.state::<HubUpdates>();
    if action == "status" {
        let hot = app.state::<HotAssets>().status();
        let ui_version = hot["uiVersion"]
            .as_str()
            .unwrap_or(env!("CARGO_PKG_VERSION"))
            .to_owned();
        let mut cached = state.checked.lock().ok().and_then(|c| c.clone());
        if cached
            .as_ref()
            .is_some_and(|c| !checked_is_newer(c, &ui_version))
        {
            cached = None;
            if let Ok(mut guard) = state.checked.lock() {
                *guard = None;
            }
        }
        let downloaded = cached
            .as_ref()
            .is_some_and(|c| root().is_ok_and(|p| p.join(format!("{}.json", c.digest)).is_file()));
        return Ok(
            json!({"nativeVersion":env!("CARGO_PKG_VERSION"),"nativeFingerprint":FINGERPRINT,"hot":hot,"build":state.build.status(),"installation":read_json::<Value>(&root()?.join("last-install.json")).ok(),"release":cached.as_ref().map(|c|json!({"available":true,"version":c.version,"kind":c.kind,"channel":c.channel,"digest":c.digest,"notes":c.notes,"binary":{"state":c.binary["state"],"message":c.binary["message"]}})),"downloaded":downloaded}),
        );
    }
    if action == "ready" {
        app.state::<HotAssets>().ready(digest.as_deref())?;
        return Ok(json!({"ok":true}));
    }
    if action == "cancel" {
        state.build.cancel();
        return Ok(json!({"ok":true}));
    }
    if action == "prerequisites" {
        return tauri::async_runtime::spawn_blocking(build::prerequisites)
            .await
            .map_err(|e| e.to_string());
    }
    if state.busy.swap(true, Ordering::AcqRel) {
        return Err("Обновление уже обрабатывается".into());
    }
    let _gate = Gate(&state.busy);
    if matches!(action.as_str(), "build" | "download") {
        crate::updates::ensure_writable()?;
    }
    if tauri::is_dev()
        && matches!(
            action.as_str(),
            "activate" | "build" | "install" | "download"
        )
    {
        return Err(
            "Обновления устанавливаются только в собранной версии Enki, не в режиме разработки."
                .into(),
        );
    }
    let _lease = if matches!(action.as_str(), "check" | "build" | "download") {
        None
    } else {
        crate::updates::ensure_writable()?;
        Some(lease()?)
    };
    match action.as_str() {
        "check" => {
            if state.build.running() {
                return Err("Дождитесь завершения сборки".into());
            }
            let channel = channel.unwrap_or_else(|| "stable".into());
            if !matches!(channel.as_str(), "stable" | "preview") {
                return Err("Invalid channel".into());
            }
            *state.checked.lock().map_err(|e| e.to_string())? = None;
            let identity = crate::hub::release_identity()?;
            let id = identity.clone();
            let checked_channel = channel.clone();
            let head = tauri::async_runtime::spawn_blocking(move || {
                crate::hub::release_get(&channel, &id)
            })
            .await
            .map_err(|e| e.to_string())??;
            if head["available"] != true {
                return Ok(json!({"available":false}));
            }
            let version = head["version"]
                .as_str()
                .ok_or("Missing version")?
                .to_owned();
            let v = semver::Version::parse(&version).map_err(|_| "Invalid version")?;
            let current = app.state::<HotAssets>().status()["uiVersion"]
                .as_str()
                .ok_or("Missing current version")?
                .to_owned();
            if v <= semver::Version::parse(&current).map_err(|_| "Invalid current version")? {
                return Ok(json!({"available":false}));
            }
            let fp = head["nativeFingerprint"]
                .as_str()
                .ok_or("Missing compatibility identity")?
                .to_owned();
            if !packet::hash_ok(&fp) {
                return Err("Invalid compatibility identity".into());
            }
            let kind = if fp == FINGERPRINT { "hot" } else { "source" }.to_owned();
            let digest = head["artifacts"][&kind]["digest"]
                .as_str()
                .ok_or("Missing artifact")?
                .to_owned();
            if !packet::hash_ok(&digest) {
                return Err("Invalid artifact digest".into());
            }
            let notes: String = head["notes"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .take(4000)
                .collect();
            let binary = if kind == "source" {
                let (id, ch, v, f) = (
                    identity.clone(),
                    checked_channel.clone(),
                    version.clone(),
                    fp.clone(),
                );
                tauri::async_runtime::spawn_blocking(move || native::available(&id, &ch, &v, &f))
                    .await
                    .map_err(|e| e.to_string())?
            } else {
                Value::Null
            };
            let reply = json!({"available":true,"version":version,"kind":kind,"digest":digest,"notes":notes,"revision":head["revision"].as_str(),"binary":{"state":binary["state"],"message":binary["message"]}});
            *state.checked.lock().map_err(|e| e.to_string())? = Some(Checked {
                channel: checked_channel,
                identity,
                kind,
                digest,
                version,
                fingerprint: fp,
                notes,
                binary,
            });
            Ok(reply)
        }
        "download" => {
            let c = checked(&app, channel.as_deref())?;
            if c.kind == "source" {
                if c.binary["state"] != "ready" {
                    return Err("Готовый пакет пока недоступен. Повторите проверку позже или явно выберите локальную сборку.".into());
                }
                let package = native::verify(&c.binary, &c.version, &c.fingerprint)?;
                state.build.start_binary(package, c.version, c.digest)?;
                return Ok(json!({"started":true,"mode":"binary"}));
            }
            let _lease = lease()?;
            let cc = c.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let value =
                    crate::hub::release_get(&format!("artifacts/{}", cc.digest), &cc.identity)?;
                let e: Envelope =
                    serde_json::from_value(value).map_err(|_| "Invalid release envelope")?;
                packet::verify(&e, &cc.digest, &cc.version, &cc.kind, &cc.fingerprint)?;
                atomic(&root()?.join(format!("{}.json", cc.digest)), &e)
            })
            .await
            .map_err(|e| e.to_string())??;
            let mut retained = app.state::<HotAssets>().retained();
            retained.push(c.digest.clone());
            let _ = collect_cache(&retained);
            Ok(json!({"downloaded":true,"version":c.version,"kind":c.kind}))
        }
        "activate" => {
            let c = checked(&app, channel.as_deref())?;
            if c.kind != "hot" {
                return Err("Требуется локальная сборка".into());
            }
            let v = verified(&c)?;
            app.state::<HotAssets>().activate(&c.digest, v)?;
            // The release is applied now; keeping the cached check would flash
            // the badge again on the reloaded webview until a manual check.
            if let Ok(mut guard) = state.checked.lock() {
                *guard = None;
            }
            let hot = app.state::<HotAssets>().inner().clone();
            let app = app.clone();
            let digest = c.digest;
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(30));
                if hot.rollback_pending(&digest) == Ok(true) {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.reload();
                    }
                }
            });
            Ok(json!({"reload":true}))
        }
        "clear" => {
            state.build.clear()?;
            Ok(json!({"cleared":true}))
        }
        "build" => {
            let c = checked(&app, channel.as_deref())?;
            if c.kind != "source" {
                return Err("Этому обновлению сборка не нужна".into());
            }
            let cc = c.clone();
            let v = tauri::async_runtime::spawn_blocking(move || {
                let prereq = build::prerequisites();
                if prereq["available"] != true {
                    return Err(prereq["reason"]
                        .as_str()
                        .unwrap_or("Нет инструментов сборки")
                        .to_owned());
                }
                let e: Envelope = serde_json::from_value(crate::hub::release_get(
                    &format!("artifacts/{}", cc.digest),
                    &cc.identity,
                )?)
                .map_err(|_| "Некорректный пакет исходников")?;
                let verified =
                    packet::verify(&e, &cc.digest, &cc.version, &cc.kind, &cc.fingerprint)?;
                atomic(&root()?.join(format!("{}.json", cc.digest)), &e)?;
                Ok::<_, String>(verified)
            })
            .await
            .map_err(|e| e.to_string())??;
            state.build.start(v, c.digest.clone())?;
            Ok(json!({"started":true}))
        }
        "install" => {
            let c = checked(&app, channel.as_deref())?;
            if c.kind != "source" {
                return Err("Use hot update activation".into());
            }
            // Native maintenance gate blocks new native-owned actions throughout
            // the authoritative idle check, backup and installer handoff.
            let _maintenance = crate::updates::Maintenance::acquire(&app).await?;
            crate::updates::idle(&app).await?;
            let data = data.ok_or("Нет резервной копии состояния")?;
            tauri::async_runtime::spawn_blocking(move || crate::updates::backup(&data))
                .await
                .map_err(|e| e.to_string())??;
            if crate::hub::release_identity()? != c.identity {
                return Err("Подключение Hub изменилось. Установка отменена.".into());
            }
            let plan = state.build.prepared(&c.digest)?;
            // Stop our own idle runtime (checkpoint, no replay) before the old
            // bundle moves, so no child keeps the previous bundle's attribution.
            let supervisor = app
                .state::<crate::runtime::RuntimeSupervisor>()
                .inner()
                .clone();
            let stopping = supervisor.clone();
            // Checked drain + reap while native and runtime fences are held. An
            // error keeps ownership; dropping `_maintenance` then ends the fence
            // on the still-owned runtime (or reports it), never replaying work.
            tauri::async_runtime::spawn_blocking(move || {
                stopping.shutdown_checked(std::time::Duration::from_secs(20))
            })
            .await
            .map_err(|e| e.to_string())??;
            // launch() returns Err only before the helper process started:
            // proven cancellation, so the fences are released by Drop.
            install::launch(plan)?;
            supervisor.retire();
            std::mem::forget(_maintenance);
            // Exact owned agents have been checked idle. Exit preserves all
            // durable data; the external helper waits for this process to exit.
            app.exit(0);
            Ok(json!({"restarting":true}))
        }
        _ => Err("Unknown Hub update action".into()),
    }
}

/// Read-only operator diagnostic: exercises the same pinned Hub connection as
/// the updater without opening a window or touching an agent session.
pub fn cli_status() -> Result<(), String> {
    let identity = crate::hub::release_identity()?;
    let head = crate::hub::release_get("stable", &identity)?;
    let newer = head["version"]
        .as_str()
        .and_then(|v| semver::Version::parse(v).ok())
        .is_some_and(|v| {
            v > semver::Version::parse(env!("CARGO_PKG_VERSION")).expect("package version")
        });
    println!(
        "{}",
        json!({"connected":true,"nativeVersion":env!("CARGO_PKG_VERSION"),"nativeFingerprint":FINGERPRINT,"releaseVersion":head["version"],"available":head["available"]==true&&newer,"kind":if head["nativeFingerprint"]==FINGERPRINT{"hot"}else{"source"}})
    );
    Ok(())
}

#[cfg(test)]
mod checked_freshness_tests {
    use super::{checked_is_newer, Checked};
    fn checked(version: &str) -> Checked {
        Checked {
            channel: "stable".into(),
            identity: "id".into(),
            kind: "hot".into(),
            digest: "0".repeat(64),
            version: version.into(),
            fingerprint: "f".repeat(64),
            notes: String::new(),
            binary: serde_json::Value::Null,
        }
    }
    #[test]
    fn reports_only_releases_newer_than_the_running_ui() {
        assert!(checked_is_newer(&checked("0.2.72"), "0.2.71"));
        // Regression: after a hot activation only the webview reloads, so a
        // cached check of the just-applied version used to keep the update
        // badge lit until the user checked for updates manually.
        assert!(!checked_is_newer(&checked("0.2.71"), "0.2.71"));
        assert!(!checked_is_newer(&checked("0.2.70"), "0.2.71"));
        assert!(!checked_is_newer(&checked("not-a-version"), "0.2.71"));
        assert!(!checked_is_newer(&checked("0.2.72"), "not-a-version"));
    }
}
