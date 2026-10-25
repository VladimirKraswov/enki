//! Windows transport paths outside per-process MSIX AppData redirection.
//! Only browser-owned data is copied; the legacy profile is never moved/deleted.
use std::path::PathBuf;

pub(super) fn command() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        static COPY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _copy = COPY_LOCK
            .lock()
            .map_err(|_| "MCP bridge copy lock failed.")?;
        let directory = super::root_dir()?
            .join("bridge")
            .join(env!("CARGO_PKG_VERSION"));
        super::files::private_dir(&directory)?;
        let destination = directory.join("enki.exe");
        if executable == destination {
            return Ok(destination);
        }
        let bytes = std::fs::read(&executable).map_err(|e| e.to_string())?;
        if destination.exists() {
            if std::fs::read(&destination).map_err(|e| e.to_string())? != bytes {
                return Err("MCP bridge for this version differs from Desktop; preserve it and reinstall a new version.".into());
            }
        } else {
            let temporary = directory.join(format!("bridge-{}.tmp", std::process::id()));
            std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
            std::fs::rename(&temporary, &destination).map_err(|e| e.to_string())?;
        }
        return Ok(destination);
    }
    #[cfg(not(target_os = "windows"))]
    Ok(executable)
}

pub(super) fn migrate(
    root: &std::path::Path,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let legacy = crate::paths::app_data_dir()?.join("browser-runtime");
        import(&legacy, root, check)?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (root, check);
    }
    Ok(())
}

#[cfg(any(target_os = "windows", test))]
fn copy_tree(
    source: &std::path::Path,
    destination: &std::path::Path,
    depth: usize,
    check: &impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    check()?;
    if depth > 32 {
        return Err("Browser migration directory nesting exceeds limit.".into());
    }
    std::fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(source).map_err(|e| e.to_string())? {
        check()?;
        let entry = entry.map_err(|e| e.to_string())?;
        // A browser cache junction at the top level is allowed (read-only
        // source); arbitrary links inside a profile/runtime are not followed.
        if entry.file_type().map_err(|e| e.to_string())?.is_symlink() {
            return Err("Browser migration refuses nested symbolic links.".into());
        }
        let target = destination.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &target, depth + 1, check)?;
        } else {
            std::fs::copy(entry.path(), target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(any(target_os = "windows", test))]
fn import(
    legacy: &std::path::Path,
    root: &std::path::Path,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    // Never merge/overwrite a profile already created by the shared runtime.
    if !legacy.is_dir()
        || ["profile", "current", "browsers"]
            .iter()
            .any(|n| root.join(n).exists())
    {
        return Ok(());
    }
    check()?;
    let stage = root.join(format!(
        "migration-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    ));
    std::fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let result = copy_and_publish(legacy, root, &stage, &check);
    if result.is_err() {
        // Only this call's own partial copy; the legacy source is never touched
        // and anything already published stays where it is.
        let _ = std::fs::remove_dir_all(&stage);
    }
    result
}

#[cfg(any(target_os = "windows", test))]
fn copy_and_publish(
    legacy: &std::path::Path,
    root: &std::path::Path,
    stage: &std::path::Path,
    check: &impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    for name in ["profile", "current", "browsers"] {
        let source = legacy.join(name);
        if name != "browsers"
            && std::fs::symlink_metadata(&source).is_ok_and(|m| m.file_type().is_symlink())
        {
            return Err("Browser migration refuses a linked profile or runtime.".into());
        }
        if source.is_dir() {
            copy_tree(&source, &stage.join(name), 0, check)?;
        }
    }
    // The manifest must refer to the copied cache, not its AppData alias.
    let manifest = stage.join("current/installed.json");
    if manifest.is_file() {
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if let Some(executable) = value["browserExecutable"].as_str() {
            let relative = std::path::Path::new(executable)
                .strip_prefix(legacy.join("browsers"))
                .map_err(|_| "Legacy Chromium manifest is outside its managed cache.")?;
            value["browserExecutable"] = serde_json::json!(root.join("browsers").join(relative));
            std::fs::write(
                &manifest,
                serde_json::to_vec(&value).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        }
    }
    check()?;
    for name in ["profile", "current", "browsers"] {
        if stage.join(name).exists() {
            std::fs::rename(stage.join(name), root.join(name)).map_err(|e| e.to_string())?;
        }
    }
    std::fs::remove_dir(stage).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "oc-browser-migration-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("legacy/profile")).unwrap();
        std::fs::create_dir_all(root.join("shared")).unwrap();
        std::fs::write(root.join("legacy/profile/fixture"), "preserved").unwrap();
        root
    }
    #[test]
    fn copies_profile_and_keeps_original_without_overwriting_shared_data() {
        let root = fixture();
        import(&root.join("legacy"), &root.join("shared"), || Ok(())).unwrap();
        assert_eq!(
            std::fs::read(root.join("legacy/profile/fixture")).unwrap(),
            b"preserved"
        );
        assert_eq!(
            std::fs::read(root.join("shared/profile/fixture")).unwrap(),
            b"preserved"
        );
        std::fs::write(root.join("shared/profile/fixture"), "new").unwrap();
        import(&root.join("legacy"), &root.join("shared"), || Ok(())).unwrap();
        assert_eq!(
            std::fs::read(root.join("shared/profile/fixture")).unwrap(),
            b"new"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancellation_does_not_publish_profile() {
        let root = fixture();
        assert!(import(&root.join("legacy"), &root.join("shared"), || Err(
            "cancelled".into()
        ))
        .is_err());
        assert!(!root.join("shared/profile").exists());
        assert!(root.join("legacy/profile/fixture").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn manifest_uses_shared_cache() {
        let root = fixture();
        std::fs::create_dir_all(root.join("legacy/current")).unwrap();
        let manifest =
            serde_json::json!({"browserExecutable":root.join("legacy/browsers/chrome.exe")});
        std::fs::write(
            root.join("legacy/current/installed.json"),
            manifest.to_string(),
        )
        .unwrap();
        import(&root.join("legacy"), &root.join("shared"), || Ok(())).unwrap();
        let result: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.join("shared/current/installed.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            PathBuf::from(result["browserExecutable"].as_str().unwrap()),
            root.join("shared").join("browsers").join("chrome.exe")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancellation_during_copy_keeps_original_and_does_not_publish() {
        let root = fixture();
        let calls = std::cell::Cell::new(0);
        let result = import(&root.join("legacy"), &root.join("shared"), || {
            calls.set(calls.get() + 1);
            if calls.get() >= 3 {
                Err("cancelled during copying".into())
            } else {
                Ok(())
            }
        });
        assert!(result.is_err());
        assert!(calls.get() >= 3);
        assert!(!root.join("shared/profile").exists());
        assert_eq!(
            std::fs::read(root.join("legacy/profile/fixture")).unwrap(),
            b"preserved"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_or_cancelled_import_leaves_no_partial_stage_behind() {
        let stages = |shared: &std::path::Path| {
            std::fs::read_dir(shared)
                .unwrap()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with("migration-"))
                .count()
        };
        // Cancelled in the middle of copying a profile.
        let root = fixture();
        std::fs::write(root.join("legacy/profile/second"), "x").unwrap();
        let calls = std::cell::Cell::new(0);
        assert!(import(&root.join("legacy"), &root.join("shared"), || {
            calls.set(calls.get() + 1);
            if calls.get() >= 3 {
                Err("cancelled".into())
            } else {
                Ok(())
            }
        })
        .is_err());
        assert_eq!(stages(&root.join("shared")), 0, "partial copy kept");
        assert!(root.join("legacy/profile/fixture").exists());
        // Refused after the copy (manifest outside the managed cache).
        std::fs::create_dir_all(root.join("legacy/current")).unwrap();
        std::fs::write(
            root.join("legacy/current/installed.json"),
            serde_json::json!({"browserExecutable": root.join("unmanaged/chrome.exe")}).to_string(),
        )
        .unwrap();
        assert!(import(&root.join("legacy"), &root.join("shared"), || Ok(())).is_err());
        assert_eq!(stages(&root.join("shared")), 0, "refused copy kept");
        // A later successful import is not blocked by any leftover.
        std::fs::remove_dir_all(root.join("legacy/current")).unwrap();
        import(&root.join("legacy"), &root.join("shared"), || Ok(())).unwrap();
        assert_eq!(
            std::fs::read(root.join("shared/profile/fixture")).unwrap(),
            b"preserved"
        );
        assert_eq!(stages(&root.join("shared")), 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn outside_cache_manifest_is_not_published() {
        let root = fixture();
        std::fs::create_dir_all(root.join("legacy/current")).unwrap();
        std::fs::write(
            root.join("legacy/current/installed.json"),
            serde_json::json!({
                "browserExecutable": root.join("unmanaged/chrome.exe")
            })
            .to_string(),
        )
        .unwrap();
        assert!(import(&root.join("legacy"), &root.join("shared"), || Ok(())).is_err());
        assert!(!root.join("shared/profile").exists());
        assert!(!root.join("shared/current").exists());
        assert!(root.join("legacy/profile/fixture").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn nested_link_is_not_followed_or_published() {
        let root = fixture();
        std::fs::create_dir_all(root.join("outside")).unwrap();
        std::fs::write(root.join("outside/fixture"), "outside").unwrap();
        std::os::unix::fs::symlink(root.join("outside"), root.join("legacy/profile/linked"))
            .unwrap();
        assert!(import(&root.join("legacy"), &root.join("shared"), || Ok(())).is_err());
        assert!(!root.join("shared/profile").exists());
        assert_eq!(
            std::fs::read(root.join("outside/fixture")).unwrap(),
            b"outside"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_command_and_migration_remain_unchanged() {
        let root = fixture();
        migrate(&root.join("shared"), || {
            Err("must not run on this OS".into())
        })
        .unwrap();
        assert!(!root.join("shared/profile").exists());
        assert_eq!(command().unwrap(), std::env::current_exe().unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }
}
