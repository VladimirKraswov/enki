//! App-owned development workspace. Contains public instructions, never secrets.
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{fs, path::Path, sync::Mutex};
static IO: Mutex<()> = Mutex::new(());
const PROMPT: &str = include_str!("../resources/workshop/AGENTS.md");
/// App-owned delivery-policy frame inside the workshop instructions. The user
/// may rewrite everything outside the markers; the framed block itself follows
/// the shipped application and is replaced verbatim on update.
const POLICY_BEGIN: &str = "<!-- enki:delivery-policy:begin -->";
const POLICY_END: &str = "<!-- enki:delivery-policy:end -->";
fn app_policy(prompt: &str) -> Option<String> {
    let begin = prompt.find(POLICY_BEGIN)?;
    let end = prompt[begin..].find(POLICY_END)?;
    Some(prompt[begin..begin + end + POLICY_END.len()].to_string())
}
/// Returns the new file content when the app-owned block must appear or be
/// refreshed. A file without the frame is treated as user-refined
/// instructions: the frame is appended, never replacing the owner's text.
/// An unterminated (user-altered) frame is left untouched.
fn sync_app_policy(existing: &str, policy: &str) -> Option<String> {
    match existing.find(POLICY_BEGIN) {
        None => Some(format!("{}\n\n{}\n", existing.trim_end(), policy)),
        Some(begin) => {
            let end = existing[begin..].find(POLICY_END)?;
            let current = &existing[begin..begin + end + POLICY_END.len()];
            if current == policy {
                None
            } else {
                Some(format!(
                    "{}{}{}",
                    &existing[..begin],
                    policy,
                    &existing[begin + end + POLICY_END.len()..]
                ))
            }
        }
    }
}
/// After an update restart the workshop may be resumed without the UI opening
/// its panel again; refresh RUNTIME.json/WORKSPACE.json from the shipped
/// native version so the agent never reads a stale runtime contract.
pub fn refresh_existing() -> Result<(), String> {
    let root = crate::paths::app_data_dir()?.join("workshop");
    if !root.join("WORKSPACE.json").is_file() {
        return Ok(());
    }
    let _lock = IO.lock().map_err(|e| e.to_string())?;
    prepare(&root, None).map(|_| ())
}
pub fn cli() -> Result<(), String> {
    crate::updates::ensure_writable()?;
    let _lock = IO.lock().map_err(|e| e.to_string())?;
    let candidate = std::env::args().nth(2);
    let workspace = prepare(
        &crate::paths::app_data_dir()?.join("workshop"),
        candidate.as_deref(),
    )?;
    println!(
        "{}",
        serde_json::to_string(&workspace).map_err(|e| e.to_string())?
    );
    Ok(())
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub directory: String,
    pub source_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_directory: Option<String>,
}
fn read(path: &Path) -> Result<Option<String>, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 128 * 1024 {
        return Err("Небезопасный файл мастерской.".into());
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|e| e.to_string())
}
fn write(path: &Path, text: &str) -> Result<(), String> {
    let _ = read(path)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temporary = path.with_extension(format!("workshop-{}-{stamp}.tmp", std::process::id()));
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&temporary).map_err(|e| e.to_string())?;
    use std::io::Write;
    let result = (|| {
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result.map_err(|e| e.to_string())
}
fn source(path: &Path) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    let package: serde_json::Value =
        serde_json::from_str(&read(&path.join("package.json")).ok()??).ok()?;
    let config: serde_json::Value =
        serde_json::from_str(&read(&path.join("src-tauri/tauri.conf.json")).ok()??).ok()?;
    (matches!(package["name"].as_str(), Some("enki" | "arvela"))
        && config["identifier"] == "dev.local.opencodedesktop")
        .then(|| {
            fs::canonicalize(path)
                .unwrap_or_else(|_| path.to_path_buf())
                .to_string_lossy()
                .to_string()
        })
}
fn prepare(root: &Path, candidate: Option<&str>) -> Result<Workspace, String> {
    if fs::symlink_metadata(root).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Каталог мастерской не должен быть symlink.".into());
    }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let previous = read(&root.join("WORKSPACE.json"))?
        .and_then(|v| serde_json::from_str::<Workspace>(&v).ok());
    let source_directory = if let Some(c) = candidate {
        Some(source(Path::new(c)).ok_or("В папке нет исходников Enki с правильным identifier.")?)
    } else {
        previous
            .and_then(|v| v.source_directory)
            .and_then(|v| source(Path::new(&v)))
            .or_else(|| source(&root.join("source")))
            .or_else(|| {
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .and_then(source)
            })
    };
    // A model/user may refine its local instructions; only the framed
    // app-owned delivery policy is refreshed automatically.
    match read(&root.join("AGENTS.md"))? {
        None => write(&root.join("AGENTS.md"), PROMPT)?,
        Some(existing) => {
            if let Some(policy) = app_policy(PROMPT) {
                if let Some(next) = sync_app_policy(&existing, &policy) {
                    write(&root.join("AGENTS.md"), &next)?;
                }
            }
        }
    }
    let legacy_directory = root
        .parent()
        .filter(|p| p.file_name().is_some_and(|n| n == "enki"))
        .map(|p| p.with_file_name("opencode-desktop").join("workshop"))
        .filter(|p| {
            fs::canonicalize(p)
                .ok()
                .zip(fs::canonicalize(root).ok())
                .is_some_and(|(a, b)| a == b)
        })
        .map(|p| p.to_string_lossy().to_string());
    let workspace = Workspace {
        legacy_directory,
        directory: root.to_string_lossy().to_string(),
        source_directory,
    };
    write(
        &root.join("WORKSPACE.json"),
        &serde_json::to_string_pretty(&workspace).map_err(|e| e.to_string())?,
    )?;
    write(&root.join("RUNTIME.json"), &json!({"nativeVersion":env!("CARGO_PKG_VERSION"),"platform":std::env::consts::OS,"hubEndpoint":crate::hub::workshop_endpoint(),"releaseCommand":"npm run release:local -- stable","nativeExecutable":std::env::current_exe().ok(),"publication":"paired-device-or-local-operator","instructionsSource":"src-tauri/resources/workshop/AGENTS.md"}).to_string())?;
    Ok(workspace)
}
#[tauri::command]
pub async fn workshop_prepare(
    source_directory: Option<String>,
    server_home: String,
) -> Result<Workspace, String> {
    crate::updates::ensure_writable()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = IO.lock().map_err(|e| e.to_string())?;
        let local = fs::canonicalize(crate::paths::user_home()?).map_err(|e| e.to_string())?;
        if fs::canonicalize(&server_home).ok().as_ref() != Some(&local) {
            return Err(
                "Среда выполнения работает на другой машине. Мастерская доступна только на этом компьютере.".into(),
            );
        }
        prepare(
            &crate::paths::app_data_dir()?.join("workshop"),
            source_directory.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "enki-workshop-{}-{}-{}",
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn legacy_workshop_alias_is_returned_only_for_the_same_real_directory() {
        let temp = Temp::new();
        let canonical = temp.path().join("enki/workshop");
        fs::create_dir_all(&canonical).unwrap();
        let legacy = temp.path().join("opencode-desktop");
        std::os::unix::fs::symlink(temp.path().join("enki"), &legacy).unwrap();
        assert_eq!(
            prepare(&canonical, None).unwrap().legacy_directory,
            Some(legacy.join("workshop").to_string_lossy().to_string())
        );
        fs::remove_file(&legacy).unwrap();
        fs::create_dir_all(legacy.join("workshop")).unwrap();
        assert!(prepare(&canonical, None)
            .unwrap()
            .legacy_directory
            .is_none());
    }
    #[tokio::test]
    async fn remote_filesystem_is_rejected_before_workspace_preparation() {
        let temp = Temp::new();
        assert!(
            workshop_prepare(None, temp.path().to_string_lossy().to_string())
                .await
                .is_err()
        );
    }
    #[test]
    fn syncs_the_framed_delivery_policy_and_preserves_owner_text() {
        let temp = Temp::new();
        let p = temp.path().join("workshop");
        let first = prepare(&p, None).unwrap();
        assert!(p.join("AGENTS.md").exists());
        fs::write(p.join("AGENTS.md"), "owner edits").unwrap();
        assert_eq!(prepare(&p, None).unwrap().directory, first.directory);
        let synced = fs::read_to_string(p.join("AGENTS.md")).unwrap();
        assert!(synced.starts_with("owner edits\n"));
        assert!(synced.contains(POLICY_BEGIN) && synced.contains("desktop_updates"));
        prepare(&p, None).unwrap();
        assert_eq!(fs::read_to_string(p.join("AGENTS.md")).unwrap(), synced);
        // A stale frame from an older application is replaced verbatim while
        // owner text around it survives; an unterminated user frame is left.
        let policy = app_policy(PROMPT).unwrap();
        fs::write(
            p.join("AGENTS.md"),
            format!("keep\n\n{POLICY_BEGIN}\nstale policy\n{POLICY_END}\ntail\n"),
        )
        .unwrap();
        prepare(&p, None).unwrap();
        let refreshed = fs::read_to_string(p.join("AGENTS.md")).unwrap();
        assert!(refreshed.starts_with("keep\n\n"));
        assert!(refreshed.ends_with("\ntail\n"));
        assert!(refreshed.contains(&policy) && !refreshed.contains("stale policy"));
        let broken = format!("x\n{POLICY_BEGIN} altered by owner");
        fs::write(p.join("AGENTS.md"), &broken).unwrap();
        prepare(&p, None).unwrap();
        assert_eq!(fs::read_to_string(p.join("AGENTS.md")).unwrap(), broken);
        assert!(prepare(&p, Some(temp.path().to_str().unwrap())).is_err());
    }
    #[test]
    fn reentry_refreshes_the_runtime_contract_after_an_update() {
        let temp = Temp::new();
        let p = temp.path().join("workshop");
        prepare(&p, None).unwrap();
        fs::write(p.join("RUNTIME.json"), "{\"nativeVersion\":\"0.0.1\"}").unwrap();
        prepare(&p, None).unwrap();
        let runtime = fs::read_to_string(p.join("RUNTIME.json")).unwrap();
        assert!(runtime.contains(env!("CARGO_PKG_VERSION")));
        assert!(!runtime.contains("0.0.1"));
    }
    #[cfg(unix)]
    #[test]
    fn rejects_linked_workspace_and_instruction_target() {
        use std::os::unix::fs::symlink;
        let temp = Temp::new();
        let p = temp.path().join("workshop");
        let target = temp.path().join("elsewhere");
        fs::create_dir(&target).unwrap();
        symlink(&target, &p).unwrap();
        assert!(prepare(&p, None).is_err());
        fs::remove_file(&p).unwrap();
        fs::create_dir(&p).unwrap();
        let secret = target.join("secret");
        fs::write(&secret, "retained").unwrap();
        symlink(&secret, p.join("AGENTS.md")).unwrap();
        assert!(prepare(&p, None).is_err());
        assert_eq!(fs::read_to_string(secret).unwrap(), "retained");
    }
}
