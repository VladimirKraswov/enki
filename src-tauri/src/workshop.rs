//! App-owned development workspace. Contains public instructions, never secrets.
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{fs, path::Path, sync::Mutex};
static IO: Mutex<()> = Mutex::new(());
const PROMPT: &str = include_str!("../resources/workshop/AGENTS.md");
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
    // A model/user may refine its local instructions; never silently overwrite them.
    if read(&root.join("AGENTS.md"))?.is_none() {
        write(&root.join("AGENTS.md"), PROMPT)?;
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
    fn preserves_custom_instructions_and_rejects_wrong_source() {
        let temp = Temp::new();
        let p = temp.path().join("workshop");
        let first = prepare(&p, None).unwrap();
        assert!(p.join("AGENTS.md").exists());
        fs::write(p.join("AGENTS.md"), "owner edits").unwrap();
        assert_eq!(prepare(&p, None).unwrap().directory, first.directory);
        assert_eq!(
            fs::read_to_string(p.join("AGENTS.md")).unwrap(),
            "owner edits"
        );
        assert!(prepare(&p, Some(temp.path().to_str().unwrap())).is_err());
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
