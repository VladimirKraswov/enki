//! One-way app-owned directory migration; engine databases are never touched.
//! Rename within one parent (no partial copy), retain an alias for absolute paths
//! already persisted by OpenCode/Pi, and record intent before touching the source.
use std::{
    fs,
    path::{Path, PathBuf},
};

fn alias(target: &Path, link: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    return std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    {
        // junction::create can leave an empty directory when DeviceIoControl
        // fails. Stage it away from the old path so rollback stays possible.
        let staging = link.with_file_name(format!(
            ".enki-link-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(std::io::Error::other)?
                .as_nanos()
        ));
        let result = junction::create(target, &staging).and_then(|_| fs::rename(&staging, link));
        if result.is_err() {
            let _ = fs::remove_dir(&staging);
        }
        result
    }
}
fn is_alias(path: &Path) -> bool {
    #[cfg(windows)]
    if junction::exists(path).unwrap_or(false) {
        return true;
    }
    path.is_symlink()
}
fn same(left: &Path, right: &Path) -> bool {
    fs::canonicalize(left)
        .ok()
        .zip(fs::canonicalize(right).ok())
        .is_some_and(|(a, b)| a == b)
}
fn io(e: std::io::Error) -> String {
    format!("Миграция данных Enki: {e}")
}

/// Read-only resolution also serves MCP helpers of an old running installation.
/// Never silently select a fresh empty tree when there are two different stores.
pub fn resolve(parent: &Path) -> Result<PathBuf, String> {
    resolve_named(parent, "opencode-desktop", "enki")
}
pub fn resolve_named(parent: &Path, legacy: &str, current: &str) -> Result<PathBuf, String> {
    let old = parent.join(legacy);
    let new = parent.join(current);
    if is_alias(&new) {
        return Err("Каталог данных Enki не должен быть ссылкой".into());
    }
    if old.exists() && new.exists() && !same(&old, &new) {
        return Err(format!("Обнаружены два разных каталога данных: {current} и {legacy}. Данные сохранены; требуется устранить конфликт перед миграцией."));
    }
    Ok(if new.exists() || !old.exists() {
        new
    } else {
        old
    })
}

/// Only the GUI startup calls this, before loading assets or starting agents.
/// An OS advisory lock survives neither a crash nor reboot, so recovery is safe.
pub fn initialize(parent: &Path) -> Result<PathBuf, String> {
    initialize_named(parent, "opencode-desktop", "enki")
}
pub fn initialize_named(parent: &Path, legacy: &str, current: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(parent).map_err(io)?;
    let lock = parent.join(".enki-migration.lock");
    if lock.is_symlink() {
        return Err("Небезопасная блокировка миграции".into());
    }
    let mut opts = fs::OpenOptions::new();
    opts.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let guard = opts.open(lock).map_err(io)?;
    fs2::FileExt::try_lock_exclusive(&guard)
        .map_err(|_| "Миграция Enki уже выполняется в другом процессе")?;
    migrate(parent, legacy, current)
}
fn migrate(parent: &Path, legacy: &str, current: &str) -> Result<PathBuf, String> {
    migrate_with_alias(parent, legacy, current, alias)
}
fn migrate_with_alias(
    parent: &Path,
    legacy: &str,
    current: &str,
    make_alias: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<PathBuf, String> {
    let old = parent.join(legacy);
    let new = parent.join(current);
    let resolved = resolve_named(parent, legacy, current)?;
    let marker = parent.join(format!(".{current}-migration-v1"));
    if marker.is_symlink() {
        return Err("Небезопасный журнал миграции".into());
    }
    if old.exists() && new.exists() {
        return Ok(resolved);
    }
    if is_alias(&old) {
        return Err(
            "Исходный каталог миграции является посторонней или повреждённой ссылкой".into(),
        );
    }
    if old.exists() {
        if !old.is_dir() {
            return Err("Исходный путь данных не является каталогом".into());
        }
        // Never move a live desktop's working directories, even when its agents
        // appear idle. The updater waits for the previous parent to exit first.
        ensure_stopped(&old)?;
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        if !marker.exists() {
            let file = opts.open(&marker).map_err(io)?;
            file.sync_all().map_err(io)?;
        } else {
            let meta = fs::symlink_metadata(&marker).map_err(io)?;
            if !meta.is_file() || meta.len() != 0 {
                return Err("Неизвестный журнал миграции; файл не изменён".into());
            }
        }
        sync_parent(parent)?;
        fs::rename(&old, &new).map_err(io)?;
        if let Err(error) = make_alias(&new, &old) {
            fs::rename(&new, &old).map_err(|rollback| {
                format!(
                    "Миграция Enki: {error}; восстановление: {rollback}. Данные сохранены в {}",
                    new.display()
                )
            })?;
            return Err(io(error));
        }
        sync_parent(parent)?;
    } else if marker.is_file() && new.is_dir() {
        // Crash between rename and alias: finish the recorded operation.
        make_alias(&new, &old).map_err(io)?;
        sync_parent(parent)?;
    } else {
        fs::create_dir_all(&new).map_err(io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&new, fs::Permissions::from_mode(0o700)).map_err(io)?;
        }
    }
    Ok(new)
}
fn sync_parent(parent: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(io)?;
    }
    #[cfg(windows)]
    {
        let _ = parent;
    }
    Ok(())
}
fn ensure_stopped(root: &Path) -> Result<(), String> {
    let descriptor = root.join("agent-control/control.json");
    if descriptor.is_symlink() {
        return Err("Небезопасное описание работающего приложения".into());
    }
    let Ok(meta) = fs::metadata(&descriptor) else {
        return Ok(());
    };
    if meta.len() > 65536 {
        return Err("Повреждённое описание работающего приложения".into());
    }
    let value: serde_json::Value = serde_json::from_slice(&fs::read(&descriptor).map_err(io)?)
        .map_err(|_| "Не удалось проверить предыдущий процесс Enki")?;
    #[cfg(unix)]
    if let Some(pid) = value["pid"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= i32::MAX as u64)
    {
        let alive = unsafe { libc::kill(pid as i32, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
        if alive {
            return Err(
                "Сначала завершите предыдущий экземпляр приложения. Миграция не изменяла данные."
                    .into(),
            );
        }
    }
    #[cfg(windows)]
    {
        let _ = value;
    } // Agent Control is Unix-only.
    Ok(())
}

/// Bundle alias for MCP commands already registered by an earlier installation.
/// It never replaces another installation. The updater already retained that
/// installation in its private previous-app record before opening this one.
pub fn installation_alias() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe().map_err(io)?;
        if let Some(bundle) = exe
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .filter(|p| p.file_name().is_some_and(|n| n == "Enki.app"))
        {
            let old = bundle.with_file_name("Arvela.app");
            if fs::symlink_metadata(&old).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
                alias(bundle, &old).map_err(io)?;
            }
        }
    }
    Ok(())
}

/// Upgrade only byte-identical bundled defaults. Owner-authored instructions
/// and third-party skills are preserved, including their historical wording.
fn refresh_text(path: &Path, known: &[&str], current: &str) -> Result<bool, String> {
    use sha2::{Digest, Sha256};
    let meta = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(io(e)),
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 1024 * 1024 {
        return Ok(false);
    }
    let previous = fs::read(path).map_err(io)?;
    let digest = format!("{:x}", Sha256::digest(&previous));
    if !known.contains(&digest.as_str()) {
        return Ok(false);
    }
    let parent = path.parent().ok_or("Нет каталога инструкций")?;
    if parent.is_symlink() {
        return Ok(false);
    }
    let temp = parent.join(format!(
        ".enki-default-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    ));
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let result = (|| {
        use std::io::Write;
        let mut file = opts.open(&temp).map_err(io)?;
        file.write_all(current.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(io)?;
        drop(file);
        if fs::read(path).map_err(io)? != previous {
            return Err("Инструкции изменились во время миграции; файл сохранён".into());
        }
        fs::rename(&temp, path).map_err(io)?;
        sync_parent(parent)?;
        Ok(true)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
pub fn bundled_defaults(root: &Path) -> Result<(), String> {
    refresh_text(
        &root.join("computer/skill/SKILL.md"),
        &[
            "a5f1e54c3e5c519eee9e4cb47b57b65b2453576aff9ae30bf7e6dff338b217c4",
            "cc664d8b2c32418aa4a39cd50f76b8f06fed5d73e2f6520e711424954973060d",
            "d6ff3c009f580e8d73ee152f227a382e8e185b5d1ddba2b05e03decfb5731551",
            "d855db58432bed92cc039a80f452ce91210706d8bc339cde4878ca46864e7acc",
        ],
        include_str!("../resources/computer/SKILL.md"),
    )?;
    refresh_text(
        &root.join("workshop/AGENTS.md"),
        &[
            "035cddd80f11e1fb046ea03481fe367b2301cb401e3c0f8d874c6ad689bdbcbe",
            "d0ad8129c61e6093e94ee9bb94693b13caf51c1d284e98e8d5dc7837d2c2d9d3",
            // Pre-2.0 default (OpenCode/Pi dual-engine wording).
            "df288d25bf19a30f00b96324e3fbfe14d8dac7df24dbfd34a49e5daf102f0dce",
        ],
        include_str!("../resources/workshop/AGENTS.md"),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    fn fixture() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "enki-migration-{}-{}-{}",
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }
    #[test]
    fn alias_failure_rolls_back_and_next_attempt_preserves_bytes() {
        let p = fixture();
        fs::create_dir(p.join("opencode-desktop")).unwrap();
        fs::write(p.join("opencode-desktop/data"), b"keep").unwrap();
        assert!(
            migrate_with_alias(&p, "opencode-desktop", "enki", |_, _| Err(
                std::io::Error::new(std::io::ErrorKind::PermissionDenied, "injected")
            ))
            .is_err()
        );
        assert_eq!(fs::read(p.join("opencode-desktop/data")).unwrap(), b"keep");
        assert!(!p.join("enki").exists());
        initialize(&p).unwrap();
        assert_eq!(fs::read(p.join("enki/data")).unwrap(), b"keep");
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn foreign_nonempty_journal_is_not_truncated() {
        let p = fixture();
        fs::create_dir(p.join("opencode-desktop")).unwrap();
        fs::write(p.join(".enki-migration-v1"), b"owner content").unwrap();
        assert!(initialize(&p).is_err());
        assert_eq!(
            fs::read(p.join(".enki-migration-v1")).unwrap(),
            b"owner content"
        );
        assert!(p.join("opencode-desktop").is_dir());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn defaults_upgrade_only_known_unchanged_bytes() {
        use sha2::{Digest, Sha256};
        let p = fixture();
        let file = p.join("AGENTS.md");
        fs::write(&file, b"previous bundled default").unwrap();
        let hash = format!("{:x}", Sha256::digest(b"previous bundled default"));
        assert!(refresh_text(&file, &[&hash], "Enki default").unwrap());
        assert_eq!(fs::read_to_string(&file).unwrap(), "Enki default");
        fs::write(&file, b"owner custom instructions").unwrap();
        assert!(!refresh_text(&file, &[&hash], "Enki default").unwrap());
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "owner custom instructions"
        );
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn rename_preserves_bytes_paths_permissions_and_is_idempotent() {
        let p = fixture();
        let old = p.join("opencode-desktop");
        fs::create_dir_all(old.join("chats/session")).unwrap();
        fs::write(old.join("chats/session/archive.zip"), [0, 255, 23, 42]).unwrap();
        let new = initialize(&p).unwrap();
        assert_eq!(new, p.join("enki"));
        assert!(is_alias(&old));
        assert_eq!(
            fs::read(old.join("chats/session/archive.zip")).unwrap(),
            [0, 255, 23, 42]
        );
        fs::write(new.join("new"), b"after").unwrap();
        assert_eq!(initialize(&p).unwrap(), new);
        assert_eq!(fs::read(old.join("new")).unwrap(), b"after");
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn collision_preserves_both_stores_and_fails_closed() {
        let p = fixture();
        for n in ["enki", "opencode-desktop"] {
            fs::create_dir(p.join(n)).unwrap();
            fs::write(p.join(n).join("data"), n).unwrap();
        }
        assert!(initialize(&p).is_err());
        for n in ["enki", "opencode-desktop"] {
            assert_eq!(fs::read_to_string(p.join(n).join("data")).unwrap(), n);
        }
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn interrupted_rename_is_recovered_without_copying_or_empty_store() {
        let p = fixture();
        fs::create_dir(p.join("enki")).unwrap();
        fs::write(p.join("enki/data"), b"keep").unwrap();
        fs::write(p.join(".enki-migration-v1"), b"").unwrap();
        initialize(&p).unwrap();
        assert_eq!(fs::read(p.join("opencode-desktop/data")).unwrap(), b"keep");
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn fresh_install_has_only_enki_store() {
        let p = fixture();
        assert_eq!(initialize(&p).unwrap(), p.join("enki"));
        assert!(!p.join("opencode-desktop").exists());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    #[cfg(unix)]
    fn live_parent_or_untrusted_link_never_moves_data() {
        let p = fixture();
        let old = p.join("opencode-desktop");
        fs::create_dir_all(old.join("agent-control")).unwrap();
        fs::write(
            old.join("agent-control/control.json"),
            format!("{{\"pid\":{}}}", std::process::id()),
        )
        .unwrap();
        assert!(initialize(&p).is_err());
        assert!(!p.join("enki").exists());
        fs::remove_dir_all(&old).unwrap();
        std::os::unix::fs::symlink(p.join("outside"), &old).unwrap();
        assert!(initialize(&p).is_err());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn concurrent_migration_is_rejected() {
        let p = fixture();
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(p.join(".enki-migration.lock"))
            .unwrap();
        fs2::FileExt::lock_exclusive(&lock).unwrap();
        assert!(initialize(&p).is_err());
        drop(lock);
        initialize(&p).unwrap();
        fs::remove_dir_all(p).unwrap();
    }
}
