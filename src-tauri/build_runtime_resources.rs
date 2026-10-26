//! Tauri copies over an existing Cargo resource directory; it does not remove
//! files deleted by a newer runtime. Seed an exact verified tree before that
//! copy, including when the directory was restored from a build cache.
#[cfg(not(test))]
use crate::artifact;
#[cfg(test)]
use crate::runtime::artifact;
use std::{fs, path::Path, time::SystemTime};

pub fn synchronize(source: &Path, profile: &Path) -> Result<(), String> {
    let source = if source.is_absolute() {
        source.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(source)
    };
    let verified = artifact::verify(
        &source,
        artifact::Expected {
            contract: Some(1),
            entry: Some("app/dist/main.js"),
            ..Default::default()
        },
    )?;
    let profile = fs::canonicalize(profile).map_err(|e| e.to_string())?;
    let destination = profile.join("agent-runtime");
    if source.starts_with(&destination) || destination.starts_with(&source) {
        return Err("Runtime source and build output overlap".into());
    }
    let stamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let stage = profile.join(format!(
        ".enki-runtime-stage-{}-{stamp}",
        std::process::id()
    ));
    let previous = profile.join(format!(
        ".enki-runtime-previous-{}-{stamp}",
        std::process::id()
    ));
    fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let result = (|| {
        for relative in verified
            .manifest
            .files
            .keys()
            .map(String::as_str)
            .chain(std::iter::once("runtime-manifest.json"))
        {
            let target = stage.join(relative);
            fs::create_dir_all(target.parent().ok_or("Invalid runtime file")?)
                .map_err(|e| e.to_string())?;
            fs::copy(source.join(relative), target).map_err(|e| e.to_string())?;
        }
        artifact::verify(
            &stage,
            artifact::Expected {
                manifest_sha256: Some(&verified.manifest_sha256),
                ..Default::default()
            },
        )?;
        let old = match fs::symlink_metadata(&destination) {
            Ok(meta) => {
                if !meta.is_dir()
                    || meta.is_symlink()
                    || fs::canonicalize(&destination).map_err(|e| e.to_string())? != destination
                {
                    return Err("Runtime build destination must be a physical directory".into());
                }
                fs::rename(&destination, &previous)
                    .map_err(|e| format!("Runtime build resources are busy: {e}"))?;
                true
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(e.to_string()),
        };
        if let Err(error) = fs::rename(&stage, &destination) {
            if old {
                fs::rename(&previous, &destination).map_err(|restore| format!("Runtime promotion failed ({error}); restore failed ({restore}); saved at {}", previous.display()))?;
            }
            return Err(error.to_string());
        }
        // A fully verifying former artifact is a disposable build output.
        // Unknown extra files are retained outside the bundled directory.
        if old {
            if artifact::verify(&previous, Default::default()).is_ok() {
                if let Err(e) = fs::remove_dir_all(&previous) {
                    eprintln!("Saved old build resources at {}: {e}", previous.display());
                }
            } else {
                eprintln!(
                    "Quarantined stale build resources at {}",
                    previous.display()
                );
            }
        }
        Ok(())
    })();
    if stage.exists() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    fn fixture() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "enki-resource-sync-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }
    fn source(base: &Path, bytes: &[u8]) -> std::path::PathBuf {
        let root = base.join("prepared");
        fs::create_dir_all(root.join("node/bin")).unwrap();
        fs::create_dir_all(root.join("app/dist")).unwrap();
        fs::write(root.join("node/bin/node"), b"owned-node-fixture").unwrap();
        fs::write(root.join("app/dist/main.js"), bytes).unwrap();
        let manifest = serde_json::json!({"schema":1,"version":"0.85.1-0123456789abcdef","contract":1,"node":"node/bin/node","entry":"app/dist/main.js","files":{
            "node/bin/node":format!("{:x}",Sha256::digest(b"owned-node-fixture")),"app/dist/main.js":format!("{:x}",Sha256::digest(bytes))}});
        fs::write(
            root.join("runtime-manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        root
    }
    #[test]
    fn cached_deleted_files_cannot_reappear_in_the_runtime_resource() {
        let base = fixture();
        let src = source(&base, b"new");
        let profile = base.join("release");
        fs::create_dir(&profile).unwrap();
        synchronize(&src, &profile).unwrap();
        let output = profile.join("agent-runtime");
        fs::create_dir_all(output.join("app/node_modules/removed-package")).unwrap();
        fs::write(
            output.join("app/node_modules/removed-package/old.js"),
            b"STALE",
        )
        .unwrap();
        assert!(artifact::verify(&output, Default::default())
            .unwrap_err()
            .contains("inventory differs"));
        fs::write(profile.join("other-application.txt"), b"PRESERVE").unwrap();
        synchronize(&src, &profile).unwrap();
        assert!(!output.join("app/node_modules/removed-package").exists());
        assert!(artifact::verify(&output, Default::default()).is_ok());
        assert_eq!(
            fs::read(profile.join("other-application.txt")).unwrap(),
            b"PRESERVE"
        );
        let previous = fs::read_dir(&profile)
            .unwrap()
            .flatten()
            .find(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(".enki-runtime-previous-")
            })
            .unwrap()
            .path();
        assert_eq!(
            fs::read(previous.join("app/node_modules/removed-package/old.js")).unwrap(),
            b"STALE"
        );
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn corrupt_source_leaves_previous_output_untouched() {
        let base = fixture();
        let src = source(&base, b"valid");
        let profile = base.join("debug");
        fs::create_dir(&profile).unwrap();
        synchronize(&src, &profile).unwrap();
        fs::write(src.join("app/dist/main.js"), b"tampered").unwrap();
        assert!(synchronize(&src, &profile).is_err());
        assert_eq!(
            fs::read(profile.join("agent-runtime/app/dist/main.js")).unwrap(),
            b"valid"
        );
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    #[cfg(unix)]
    fn linked_output_is_never_followed_or_replaced() {
        let base = fixture();
        let src = source(&base, b"valid");
        let profile = base.join("release");
        fs::create_dir(&profile).unwrap();
        let outside = base.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep"), b"KEEP").unwrap();
        std::os::unix::fs::symlink(&outside, profile.join("agent-runtime")).unwrap();
        assert!(synchronize(&src, &profile).is_err());
        assert!(profile.join("agent-runtime").is_symlink());
        assert_eq!(fs::read(outside.join("keep")).unwrap(), b"KEEP");
        fs::remove_dir_all(base).unwrap();
    }
}
