//! The managed runtime on disk: pinned resources, installation validation,
//! private directories, atomic replacement and the cross-process lock.
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub(super) const VERSION: &str = "0.0.83";
/// The official MCP SDK version pinned by `package-lock.json`.
pub(super) const SDK_VERSION: &str = "1.32.0";

/// Dependency inputs. A change here requires a fresh, lockfile-verified `npm ci`.
pub(super) const DEPENDENCIES: &[(&str, &str)] = &[
    (
        "package.json",
        include_str!("../../resources/browser/package.json"),
    ),
    (
        "package-lock.json",
        include_str!("../../resources/browser/package-lock.json"),
    ),
];

/// Desktop-owned scripts. A newer Desktop refreshes these in place, so a
/// script-only change never downloads packages or Chromium again.
/// The agent-side browser tools are bundled into the Enki Runtime itself.
pub(super) const SCRIPTS: &[(&str, &str)] = &[
    (
        "session.mjs",
        include_str!("../../resources/browser/session.mjs"),
    ),
    (
        "actions.mjs",
        include_str!("../../resources/browser/actions.mjs"),
    ),
    (
        "preferences.mjs",
        include_str!("../../resources/browser/preferences.mjs"),
    ),
    (
        "stealth.mjs",
        include_str!("../../resources/browser/stealth.mjs"),
    ),
    ("view.mjs", include_str!("../../resources/browser/view.mjs")),
    (
        "daemon.mjs",
        include_str!("../../resources/browser/daemon.mjs"),
    ),
    (
        "proxy.mjs",
        include_str!("../../resources/browser/proxy.mjs"),
    ),
    (
        "setup.mjs",
        include_str!("../../resources/browser/setup.mjs"),
    ),
    (
        "skills/desktop-browser/SKILL.md",
        include_str!("../../resources/browser/SKILL.md"),
    ),
];

pub fn root_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    return windows_root_dir(
        crate::paths::profile_override()?.as_deref(),
        crate::paths::user_home,
    );
    #[cfg(not(target_os = "windows"))]
    Ok(crate::paths::app_data_dir()?.join("browser-runtime"))
}

/// Windows selection, compiled everywhere so it is tested on every host.
/// An explicit (already validated) profile owns its own root and is decided
/// BEFORE the user-home lookup, which is then never consulted. Without one,
/// MSIX redirects AppData independently for the Desktop and an external
/// engine, so their transport and persistent profile share the outside-MSIX
/// `.enki` (legacy `.opencode-desktop`) root exactly as before.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn windows_root_dir(
    profile: Option<&Path>,
    home: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    if let Some(profile) = profile {
        return Ok(profile.join("browser-runtime"));
    }
    Ok(
        crate::migration::resolve_named(&home()?, ".opencode-desktop", ".enki")?
            .join("browser-runtime"),
    )
}

pub fn support_dir() -> Result<PathBuf, String> {
    Ok(root_dir()?.join("current"))
}

pub(super) fn private_dir(path: &Path) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Каталог браузера не должен быть символической ссылкой.".into());
    }
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn package_version(current: &Path, package: &str) -> Option<String> {
    let value = read_json(
        &current
            .join("node_modules")
            .join(package)
            .join("package.json"),
    )?;
    value["version"].as_str().map(str::to_owned)
}

fn matches_resources(current: &Path, resources: &[(&str, &str)]) -> bool {
    resources.iter().all(|(name, content)| {
        fs::read_to_string(current.join(name)).ok().as_deref() == Some(*content)
    })
}

/// Packages, lockfile and Chromium match this Desktop build. Desktop-owned
/// scripts may still be from an older build (see [`refresh_scripts`]).
pub(super) fn dependencies_installed(current: &Path) -> bool {
    if fs::symlink_metadata(current).is_ok_and(|m| m.file_type().is_symlink()) {
        return false;
    }
    let browser = read_json(&current.join("installed.json")).is_some_and(|manifest| {
        manifest["version"] == VERSION
            && manifest["browserExecutable"].as_str().is_some_and(|exe| {
                let exe = PathBuf::from(exe);
                exe.is_absolute()
                    && exe.is_file()
                    && current
                        .parent()
                        .is_some_and(|root| exe.starts_with(root.join("browsers")))
            })
    });
    browser
        && package_version(current, "@playwright/mcp").as_deref() == Some(VERSION)
        && package_version(current, "@modelcontextprotocol/sdk").as_deref() == Some(SDK_VERSION)
        && matches_resources(current, DEPENDENCIES)
}

/// Exactly what this Desktop build ships: dependencies and every script.
pub(super) fn installed_at(current: &Path) -> bool {
    dependencies_installed(current) && matches_resources(current, SCRIPTS)
}

/// Write every pinned resource into a fresh staging directory.
pub(super) fn write_resources(staging: &Path) -> Result<(), String> {
    for (name, content) in DEPENDENCIES.iter().chain(SCRIPTS) {
        let destination = staging.join(name);
        if let Some(parent) = destination.parent() {
            private_dir(parent)?;
        }
        fs::write(destination, content).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Bring Desktop-owned scripts up to date without touching packages/Chromium.
/// Each file is replaced atomically. Callers hold the lifecycle lock and have
/// stopped the daemon, which would otherwise keep running the old script.
pub(super) fn refresh_scripts(current: &Path) -> Result<(), String> {
    for (name, content) in SCRIPTS {
        let destination = current.join(name);
        if fs::read_to_string(&destination).ok().as_deref() == Some(*content) {
            continue;
        }
        if let Some(parent) = destination.parent() {
            private_dir(parent)?;
        }
        replace_file(&destination, content.as_bytes())?;
    }
    Ok(())
}

/// Write a private sibling file, then rename it over the destination.
/// `fs::rename` replaces an existing file on every supported platform
/// (MoveFileExW with MOVEFILE_REPLACE_EXISTING on Windows), so the destination
/// is never missing, unlike delete-then-rename.
pub(super) fn replace_file(destination: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = destination
        .file_name()
        .ok_or("Некорректный путь файла браузера.")?;
    let mut temporary_name = name.to_os_string();
    temporary_name.push(format!(".{}.tmp", std::process::id()));
    let temporary = destination.with_file_name(temporary_name);
    let result = write_private(&temporary, bytes)
        .and_then(|_| fs::rename(&temporary, destination).map_err(|e| e.to_string()));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())
}

/// Interpreter recorded for the stdio MCP proxy that engines launch.
pub(super) fn recorded_node(current: &Path) -> Option<PathBuf> {
    let manifest = read_json(&current.join("installed.json"))?;
    manifest["nodeProgram"].as_str().map(PathBuf::from)
}

/// Record the verified interpreter the daemon runs with, so proxies launched
/// later by the Enki Runtime use the same one. The manifest holds no secrets.
pub(super) fn record_node(current: &Path, node: &Path) -> Result<(), String> {
    let node = node.to_str().ok_or("Путь к Node.js должен быть в UTF-8.")?;
    let path = current.join("installed.json");
    let mut manifest = read_json(&path)
        .filter(Value::is_object)
        .ok_or("Манифест браузера повреждён. Переустановите инструменты в настройках Desktop.")?;
    if manifest["nodeProgram"].as_str() == Some(node) {
        return Ok(());
    }
    manifest["nodeProgram"] = json!(node);
    replace_file(
        &path,
        &serde_json::to_vec(&manifest).map_err(|e| e.to_string())?,
    )
}

/// Cross-process lifecycle lock for install/start. Another Desktop process
/// holding it gets `busy` instead of a second installer or daemon.
pub(super) fn lifecycle_lock(root: &Path, busy: &str) -> Result<fs::File, String> {
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("owner.lock"))
        .map_err(|e| e.to_string())?;
    lock.try_lock_exclusive().map_err(|_| busy.to_owned())?;
    Ok(lock)
}

pub(super) fn staging_dir(root: &Path) -> PathBuf {
    root.join(format!("staging-{}", std::process::id()))
}

/// Remove installer leftovers from interrupted runs (crash, forced exit).
/// Only called with the lifecycle lock held, so no installer is using them.
/// Symbolic links are never followed.
pub(super) fn remove_stale_staging(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let staging = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with("staging-"));
        if staging && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Promote a verified staging directory to `current`. The previous runtime is
/// kept only until the swap has succeeded, and restored if it fails.
pub(super) fn promote(root: &Path, staging: &Path, current: &Path) -> Result<(), String> {
    let rollback = root.join("previous");
    if fs::symlink_metadata(&rollback).is_ok() {
        fs::remove_dir_all(&rollback).map_err(|e| e.to_string())?;
    }
    if fs::symlink_metadata(current).is_ok() {
        fs::rename(current, &rollback).map_err(|e| e.to_string())?;
    }
    if let Err(error) = fs::rename(staging, current) {
        if fs::symlink_metadata(&rollback).is_ok() {
            let _ = fs::rename(&rollback, current);
        }
        return Err(error.to_string());
    }
    // Running proxies already loaded their scripts. If a file is still locked
    // on Windows, the next installation removes the leftover instead.
    let _ = fs::remove_dir_all(&rollback);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn embedded_scripts_cover_every_relative_import_of_the_embedded_daemon() {
        // A daemon import that is not shipped in SCRIPTS would crash the
        // packaged browser runtime with ERR_MODULE_NOT_FOUND at startup.
        let daemon = SCRIPTS
            .iter()
            .find(|(name, _)| *name == "daemon.mjs")
            .map(|(_, content)| *content)
            .expect("daemon.mjs is embedded");
        let mut missing = Vec::new();
        // Covers static and dynamic imports written with either quote style.
        for quote in ['\'', '"'] {
            let pattern = format!("{quote}./");
            let mut from = 0;
            while let Some(pos) = daemon[from..].find(&pattern) {
                let start = from + pos + 3;
                let rest = &daemon[start..];
                let Some(end) = rest.find(quote) else { break };
                let imported = &rest[..end];
                if imported.ends_with(".mjs") && !SCRIPTS.iter().any(|(name, _)| *name == imported)
                {
                    missing.push(imported.to_owned());
                }
                from = start + end;
            }
        }
        assert!(
            missing.is_empty(),
            "daemon imports missing from SCRIPTS: {missing:?}"
        );
    }

    fn temp(tag: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "browser-files-{tag}-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Windows branch, exercised on every host with fixture homes only: an
    /// explicit profile wins over the owner's shared `.enki` root and the home
    /// lookup is never consulted, even when it would itself be a conflict.
    #[test]
    fn windows_explicit_profile_root_beats_the_shared_user_home_root() {
        let base = temp("win-profile");
        let home = base.join("owner-home");
        fs::create_dir_all(home.join(".enki/browser-runtime")).unwrap();
        fs::create_dir_all(home.join(".opencode-desktop")).unwrap();
        let profile = base.join("profile-a");
        fs::create_dir_all(&profile).unwrap();
        let consulted = std::cell::Cell::new(false);
        let root = windows_root_dir(Some(profile.as_path()), || {
            consulted.set(true);
            Ok(home.clone())
        })
        .unwrap();
        assert_eq!(root, profile.join("browser-runtime"));
        assert!(
            !consulted.get(),
            "explicit profile must not look at user home"
        );
        assert!(!root.starts_with(&home));
        // capabilities::root (and Hub config/ready/token beneath it) derive from
        // root_dir().parent() on Windows: that is now the profile itself.
        assert_eq!(root.parent(), Some(profile.as_path()));
        let other = base.join("profile-b");
        assert_ne!(
            windows_root_dir(Some(other.as_path()), || Ok(home.clone())).unwrap(),
            root
        );
        fs::remove_dir_all(&base).unwrap();
    }

    /// Without a profile the shared outside-MSIX policy is byte-for-byte the
    /// old one: `.enki` when fresh or current, legacy `.opencode-desktop` when
    /// only it exists, and an explicit error for two different stores.
    #[test]
    fn windows_default_root_keeps_the_shared_outside_msix_route() {
        let base = temp("win-default");
        let home = base.join("home");
        fs::create_dir_all(&home).unwrap();
        let pick = || windows_root_dir(None, || Ok(home.clone()));
        assert_eq!(pick().unwrap(), home.join(".enki/browser-runtime"));
        fs::create_dir_all(home.join(".opencode-desktop")).unwrap();
        assert_eq!(
            pick().unwrap(),
            home.join(".opencode-desktop/browser-runtime")
        );
        fs::create_dir_all(home.join(".enki")).unwrap();
        assert!(pick().is_err(), "two different stores must not be guessed");
        fs::remove_dir_all(home.join(".opencode-desktop")).unwrap();
        assert_eq!(pick().unwrap(), home.join(".enki/browser-runtime"));
        let missing = windows_root_dir(None, || Err("USERPROFILE недоступен".into()));
        assert_eq!(missing, Err("USERPROFILE недоступен".to_string()));
        fs::remove_dir_all(&base).unwrap();
    }

    /// A fake but structurally complete runtime: packages, manifest, Chromium
    /// path and all pinned resources. Nothing is downloaded or executed.
    fn complete_runtime(root: &Path) -> PathBuf {
        let current = root.join("current");
        write_resources(&current).unwrap();
        let browser = root.join("browsers/chromium/chrome");
        fs::create_dir_all(browser.parent().unwrap()).unwrap();
        fs::write(&browser, "").unwrap();
        for (package, version) in [
            ("@playwright/mcp", VERSION),
            ("@modelcontextprotocol/sdk", SDK_VERSION),
        ] {
            let dir = current.join("node_modules").join(package);
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("package.json"),
                json!({ "version": version }).to_string(),
            )
            .unwrap();
        }
        fs::write(
            current.join("installed.json"),
            json!({ "version": VERSION, "browserExecutable": browser }).to_string(),
        )
        .unwrap();
        current
    }

    #[test]
    fn script_only_changes_are_refreshed_without_a_new_dependency_install() {
        let root = temp("refresh");
        let current = complete_runtime(&root);
        assert!(installed_at(&current));
        fs::write(current.join("proxy.mjs"), "// older Desktop build").unwrap();
        fs::remove_file(current.join("session.mjs")).unwrap();
        assert!(!installed_at(&current));
        assert!(dependencies_installed(&current));
        refresh_scripts(&current).unwrap();
        assert!(installed_at(&current));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_changed_lockfile_requires_a_full_install() {
        let root = temp("lockfile");
        let current = complete_runtime(&root);
        fs::write(current.join("package-lock.json"), "{}").unwrap();
        assert!(!dependencies_installed(&current));
        assert!(!installed_at(&current));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn node_recording_replaces_the_manifest_and_keeps_other_fields() {
        let root = temp("manifest");
        let current = complete_runtime(&root);
        let node = root.join("node");
        record_node(&current, &node).unwrap();
        assert_eq!(recorded_node(&current), Some(node));
        assert!(installed_at(&current));
        let leftovers = fs::read_dir(&current)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_staging_is_removed_but_runtime_data_is_kept() {
        let root = temp("staging");
        for kept in ["current", "profile", "browsers", "workspace"] {
            fs::create_dir_all(root.join(kept)).unwrap();
        }
        fs::create_dir_all(root.join("staging-1/node_modules")).unwrap();
        fs::create_dir_all(root.join("staging-999999")).unwrap();
        remove_stale_staging(&root);
        assert!(!root.join("staging-1").exists());
        assert!(!root.join("staging-999999").exists());
        for kept in ["current", "profile", "browsers", "workspace"] {
            assert!(root.join(kept).is_dir(), "{kept}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn promotion_swaps_the_runtime_and_drops_the_rollback_copy() {
        let root = temp("promote");
        let current = root.join("current");
        let staging = root.join("staging-test");
        fs::create_dir_all(&current).unwrap();
        fs::write(current.join("marker"), "old").unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("marker"), "new").unwrap();
        promote(&root, &staging, &current).unwrap();
        assert_eq!(fs::read_to_string(current.join("marker")).unwrap(), "new");
        assert!(!staging.exists());
        assert!(!root.join("previous").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
