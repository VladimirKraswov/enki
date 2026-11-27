//! OS file locks fence profile ownership and native replacement. They release
//! automatically after crashes; no PID file can outlive its process.
use std::{fs, io, path::Path};

#[derive(Debug)]
enum LockError {
    Busy,
    Other(String),
}

impl LockError {
    fn message(self) -> String {
        match self {
            Self::Busy => "Enki уже запущена или устанавливает обновление".into(),
            Self::Other(error) => error,
        }
    }
}

fn lock(root: &Path, name: &str, exclusive: bool) -> Result<fs::File, LockError> {
    crate::updates::private(root).map_err(LockError::Other)?;
    let path = root.join(name);
    if path.is_symlink() {
        return Err(LockError::Other("Небезопасный файл блокировки Enki".into()));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(path)
        .map_err(|e| LockError::Other(e.to_string()))?;
    let result = if exclusive {
        fs2::FileExt::try_lock_exclusive(&file)
    } else {
        fs2::FileExt::try_lock_shared(&file)
    };
    result.map_err(|error| {
        if error.kind() == io::ErrorKind::WouldBlock {
            LockError::Busy
        } else {
            LockError::Other(error.to_string())
        }
    })?;
    Ok(file)
}
pub fn desktop() -> Result<fs::File, String> {
    lock(&crate::paths::app_data_dir()?, "native-install.lock", false).map_err(LockError::message)
}
pub fn installer() -> Result<fs::File, String> {
    lock(&crate::paths::app_data_dir()?, "native-install.lock", true).map_err(LockError::message)
}
/// A second app process is a normal activation race, not a fatal setup error.
/// `None` means another Enki already owns this profile; filesystem failures
/// remain errors so a damaged or inaccessible data directory is never ignored.
pub fn profile_startup() -> Result<Option<fs::File>, String> {
    profile_startup_at(&crate::paths::app_data_dir()?)
}

fn profile_startup_at(root: &Path) -> Result<Option<fs::File>, String> {
    match lock(root, "desktop-instance.lock", true) {
        Ok(file) => Ok(Some(file)),
        Err(LockError::Busy) => Ok(None),
        Err(LockError::Other(error)) => Err(error),
    }
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
        assert!(matches!(
            lock(first.path(), "instance", true),
            Err(LockError::Busy)
        ));
        assert!(lock(second.path(), "instance", true).is_ok());
        drop(one);
        assert!(lock(first.path(), "instance", true).is_ok());
    }

    #[test]
    fn duplicate_launch_is_a_normal_skip_instead_of_a_setup_failure() {
        let root = tempfile::tempdir().unwrap();
        let owner = lock(root.path(), "desktop-instance.lock", true).unwrap();

        assert!(profile_startup_at(root.path()).unwrap().is_none());

        drop(owner);
        assert!(profile_startup_at(root.path()).unwrap().is_some());
    }
}
