//! OS file locks fence profile ownership and native replacement. They release
//! automatically after crashes; no PID file can outlive its process.
use std::{fs, path::Path};

fn lock(root: &Path, name: &str, exclusive: bool) -> Result<fs::File, String> {
    crate::updates::private(root)?;
    let path = root.join(name);
    if path.is_symlink() {
        return Err("Небезопасный файл блокировки Enki".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let result = if exclusive {
        fs2::FileExt::try_lock_exclusive(&file)
    } else {
        fs2::FileExt::try_lock_shared(&file)
    };
    result.map_err(|_| "Enki уже запущена или устанавливает обновление".to_string())?;
    Ok(file)
}
pub fn desktop() -> Result<fs::File, String> {
    lock(&crate::paths::app_data_dir()?, "native-install.lock", false)
}
pub fn installer() -> Result<fs::File, String> {
    lock(&crate::paths::app_data_dir()?, "native-install.lock", true)
}
pub fn profile() -> Result<fs::File, String> {
    lock(
        &crate::paths::app_data_dir()?,
        "desktop-instance.lock",
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_and_desktop_exclude_each_other_and_release_on_drop() {
        let root = tempfile::tempdir().unwrap();
        let desktop = lock(root.path(), "install", false).unwrap();
        assert!(lock(root.path(), "install", true).is_err());
        drop(desktop);
        let installer = lock(root.path(), "install", true).unwrap();
        assert!(lock(root.path(), "install", false).is_err());
        drop(installer);
        assert!(lock(root.path(), "install", false).is_ok());
    }
    #[test]
    fn profile_lock_blocks_duplicates_but_separate_profiles_work() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let one = lock(first.path(), "instance", true).unwrap();
        assert!(lock(first.path(), "instance", true).is_err());
        assert!(lock(second.path(), "instance", true).is_ok());
        drop(one);
        assert!(lock(first.path(), "instance", true).is_ok());
    }
}
