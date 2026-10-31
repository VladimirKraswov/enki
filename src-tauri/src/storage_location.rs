//! Owner-selected storage. A missing external disk must never create a second,
//! empty history on the internal disk. Explicit test profiles bypass this file.
use serde::Deserialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Location {
    version: u32,
    data_dir: PathBuf,
    storage_id: String,
}

fn small_file(path: &Path) -> Result<String, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("Хранилище Enki недоступно: {e}"))?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 4096 {
        return Err("Некорректный файл расположения хранилища Enki".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err(
                "Файл расположения Enki должен быть закрыт для других пользователей".into(),
            );
        }
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

pub fn parent(home: &Path) -> Result<Option<PathBuf>, String> {
    let file = home.join(".config/enki/storage-location.json");
    match fs::symlink_metadata(&file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
        Ok(_) => {}
    }
    let location: Location = serde_json::from_str(&small_file(&file)?)
        .map_err(|e| format!("Некорректное расположение Enki: {e}"))?;
    let root = &location.data_dir;
    if location.version != 1
        || !root.is_absolute()
        || root.file_name().and_then(|n| n.to_str()) != Some("enki")
        || location.storage_id.len() != 36
        || root
            .components()
            .any(|p| matches!(p, std::path::Component::ParentDir))
    {
        return Err("Некорректное расположение хранилища Enki".into());
    }
    // No mkdir and no fallback: also reject symlinks anywhere in the selected
    // path. The marker prevents silently accepting another disk at this mount.
    let canonical = fs::canonicalize(root)
        .map_err(|_| "Подключите внешний диск с данными Enki; внутреннее хранилище не создано")?;
    if canonical != *root
        || !root.is_dir()
        || small_file(&root.join(".enki-storage-id"))?.trim() != location.storage_id
    {
        return Err("Выбранное хранилище Enki не прошло проверку идентичности".into());
    }
    Ok(root.parent().map(Path::to_path_buf))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "enki-storage-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            Self(fs::canonicalize(root).unwrap())
        }
        fn private(&self, path: &Path, text: &str) {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
            }
        }
        fn configure(&self) -> PathBuf {
            let data = self.0.join("external/enki");
            fs::create_dir_all(&data).unwrap();
            let id = "12345678-1234-1234-1234-123456789012";
            self.private(&data.join(".enki-storage-id"), id);
            self.private(
                &self.0.join(".config/enki/storage-location.json"),
                &serde_json::json!({"version":1,"data_dir":data,"storage_id":id}).to_string(),
            );
            data
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn default_profile_is_unchanged() {
        let f = Fixture::new();
        assert_eq!(parent(&f.0).unwrap(), None);
    }
    #[test]
    fn selected_storage_survives_restart_and_refuses_absent_disk() {
        let f = Fixture::new();
        let data = f.configure();
        assert_eq!(parent(&f.0).unwrap(), data.parent().map(Path::to_path_buf));
        assert_eq!(parent(&f.0).unwrap(), data.parent().map(Path::to_path_buf));
        fs::rename(data.parent().unwrap(), f.0.join("unmounted")).unwrap();
        assert!(parent(&f.0).is_err());
        assert!(!data.exists());
    }
    #[test]
    fn wrong_disk_and_malformed_configuration_fail_closed() {
        let f = Fixture::new();
        let data = f.configure();
        f.private(&data.join(".enki-storage-id"), "different");
        assert!(parent(&f.0).is_err());
        f.private(&f.0.join(".config/enki/storage-location.json"), "{}");
        assert!(parent(&f.0).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn link_or_public_configuration_is_refused() {
        use std::os::unix::{fs::symlink, fs::PermissionsExt};
        let f = Fixture::new();
        let data = f.configure();
        let original = f.0.join("original");
        fs::rename(&data, &original).unwrap();
        symlink(&original, &data).unwrap();
        assert!(parent(&f.0).is_err());
        fs::remove_file(&data).unwrap();
        fs::rename(&original, &data).unwrap();
        fs::set_permissions(
            f.0.join(".config/enki/storage-location.json"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(parent(&f.0).is_err());
    }
}
