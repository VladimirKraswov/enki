//! Per-OS locations for configuration and app-owned data.
//!
//! Two different owners are involved and they must not be confused:
//!
//! - **OpenCode's** configuration (`opencode.jsonc`). We do not get to decide where
//!   it lives — the separately installed engine does. Writing to a path the engine
//!   never reads would silently discard the user's settings, so resolution is
//!   *evidence first*: an existing directory always wins over a guess.
//! - **This app's** own data (projectless chat workspaces, the computer-control
//!   gate). We own it, but an installed release already has files there, so an
//!   existing directory still wins — an upgrade must not orphan previous chats.
//!
//! Only when nothing exists yet does the platform default apply: on Linux
//! `XDG_CONFIG_HOME` / `XDG_DATA_HOME` (absolute values only, per the XDG spec),
//! on macOS always `$HOME/.config` and `$HOME/.local/share`, byte-for-byte what
//! every verified 0.2.x build used.
//!
//! On Windows OpenCode itself still reports `%USERPROFILE%\.config\opencode`,
//! while Desktop-owned state belongs under `%LOCALAPPDATA%\enki` (legacy root is migrated at startup).

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[cfg(test)]
mod profile_isolation_tests;

/// One OS-vault service family. Without an explicit profile the shipped
/// literal `legacy` service is used byte for byte; with ENKI_PROFILE_DIR it is
/// `dev.enki.profile.<SHA256(canonical root)>.<suffix>` — the exact historical
/// provider-vault form. A profile never probes, migrates or falls back to the
/// legacy service, and an invalid profile is an error, never the default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SecretNamespace {
    pub legacy: &'static str,
    pub suffix: &'static str,
}

/// Hub device key (`endpoint`) and cached model-admin key (`endpoint#model-admin`).
pub const HUB_SECRETS: SecretNamespace = SecretNamespace {
    legacy: "dev.local.opencodedesktop.hub",
    suffix: "hub",
};
/// Shared MCP credentials (`{scopeKey}/{serverId}`); the image generator key
/// is intentionally the same `global/enki-images` entry of this namespace.
pub const SHARED_MCP_SECRETS: SecretNamespace = SecretNamespace {
    legacy: "dev.local.opencodedesktop.shared-mcp",
    suffix: "shared-mcp",
};
/// Model-control keys (normalized loopback origin).
pub const MODEL_CONTROL_SECRETS: SecretNamespace = SecretNamespace {
    legacy: "dev.local.opencodedesktop.model-control",
    suffix: "model-control",
};

impl SecretNamespace {
    /// Service for the current process profile.
    pub fn service(&self) -> Result<String, String> {
        self.service_from(profile_override())
    }
    /// A failed profile resolution stays a failure: no default fallback.
    pub fn service_from(&self, profile: Result<Option<PathBuf>, String>) -> Result<String, String> {
        Ok(self.service_for(profile?.as_deref()))
    }
    /// `profile` must already be the canonical physical root.
    pub fn service_for(&self, profile: Option<&Path>) -> String {
        match profile {
            None => self.legacy.to_string(),
            Some(root) => format!(
                "dev.enki.profile.{:x}.{}",
                Sha256::digest(root.to_string_lossy().as_bytes()),
                self.suffix
            ),
        }
    }
}

/// Explicit independent installation/profile for acceptance and development.
/// It never redirects HOME or discovers/migrates the owner's existing profile.
pub fn profile_override() -> Result<Option<PathBuf>, String> {
    let Some(value) = std::env::var_os("ENKI_PROFILE_DIR") else {
        return Ok(None);
    };
    validate_profile_root(PathBuf::from(value), &user_home()?).map(Some)
}

/// Validate, create (0700 on Unix) and canonicalize an explicit profile root.
/// `home` is injected so the policy is testable without process environment.
pub fn validate_profile_root(root: PathBuf, home: &Path) -> Result<PathBuf, String> {
    if !root.is_absolute()
        || root.parent().is_none()
        || root == home
        || root
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("ENKI_PROFILE_DIR должен указывать на отдельный абсолютный каталог".into());
    }
    let mut prefix = PathBuf::new();
    for part in root.components() {
        prefix.push(part);
        match std::fs::symlink_metadata(&prefix) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                return Err("Путь отдельного профиля содержит ссылку или файл".into())
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err("Не удалось проверить путь отдельного профиля".into()),
        }
    }
    std::fs::create_dir_all(&root).map_err(|_| "Не удалось создать отдельный профиль")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Не удалось защитить отдельный профиль")?;
    }
    let physical =
        std::fs::canonicalize(&root).map_err(|_| "Каталог отдельного профиля недоступен")?;
    if physical == std::fs::canonicalize(home).map_err(|_| "Домашний каталог недоступен")?
    {
        return Err("Отдельный профиль не может совпадать с домашним каталогом".into());
    }
    Ok(physical)
}

pub fn user_home() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let variable = "USERPROFILE";
    #[cfg(not(target_os = "windows"))]
    let variable = "HOME";
    let home =
        PathBuf::from(std::env::var_os(variable).ok_or_else(|| format!("{variable} недоступен"))?);
    if !home.is_absolute() {
        return Err(format!("{variable} должен быть абсолютным путём"));
    }
    Ok(home)
}

/// The HOME that automatic discovery may inspect: user-level tool installs
/// (Node shims and version managers, `~/.cargo/bin`) and the informational
/// skill catalog (`~/.agents`, `~/.pi/agent`). An explicit ENKI_PROFILE_DIR is
/// an isolated installation: it inspects nothing below the owner's HOME
/// (bundled tools, fixed system locations and explicitly configured absolute
/// paths still apply). An invalid profile fails closed instead of falling back
/// to the owner's discovery.
pub fn discovery_home() -> Result<Option<PathBuf>, String> {
    discovery_home_for(profile_override(), user_home())
}

/// [`discovery_home`] with injected inputs (testable without process env).
pub fn discovery_home_for(
    profile: Result<Option<PathBuf>, String>,
    home: Result<PathBuf, String>,
) -> Result<Option<PathBuf>, String> {
    Ok(match profile? {
        Some(_) => None,
        None => home.ok(),
    })
}

/// An XDG variable is only honoured when it is a non-empty absolute path, as the
/// spec requires. A relative value must be ignored, not joined onto the cwd.
fn xdg_override(variable: &str) -> Option<PathBuf> {
    let path = PathBuf::from(std::env::var_os(variable)?);
    path.is_absolute().then_some(path)
}

/// Candidate roots in preference order. macOS deliberately offers only the home
/// location so an installed release keeps resolving exactly as it did before.
fn candidates(variable: &str, fallback: &str) -> Result<Vec<PathBuf>, String> {
    let home = user_home()?.join(fallback);
    if cfg!(target_os = "linux") {
        if let Some(xdg) = xdg_override(variable) {
            // Both are plausible: the engine may predate the XDG variable being set.
            return Ok(if xdg == home {
                vec![home]
            } else {
                vec![xdg, home]
            });
        }
    }
    Ok(vec![home])
}

/// Pick the first candidate that already contains `leaf`; otherwise the first
/// candidate, which is where a fresh install will create it.
fn resolve(variable: &str, fallback: &str, leaf: &str) -> Result<PathBuf, String> {
    let roots = candidates(variable, fallback)?;
    let existing = roots.iter().map(|r| r.join(leaf)).find(|p| p.is_dir());
    Ok(existing.unwrap_or_else(|| roots[0].join(leaf)))
}

/// Root of this application's own data (chat workspaces, computer-control gate).
pub fn app_data_dir() -> Result<PathBuf, String> {
    if let Some(profile) = profile_override()? {
        return Ok(profile);
    }
    crate::migration::resolve(&app_data_parent()?)
}
/// Shared parent of the default data directory (where `enki`/`opencode-desktop`
/// live and where startup migration runs). Default profile only.
pub fn app_data_parent() -> Result<PathBuf, String> {
    refuse_profile_parent(profile_override()?.as_deref())?;
    #[cfg(target_os = "windows")]
    {
        let root =
            PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA недоступен")?);
        if !root.is_absolute() {
            return Err("LOCALAPPDATA должен быть абсолютным путём".into());
        }
        Ok(root)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let roots = candidates("XDG_DATA_HOME", ".local/share")?;
        Ok(roots
            .iter()
            .find(|p| p.join("enki").exists() || p.join("opencode-desktop").exists())
            .unwrap_or(&roots[0])
            .clone())
    }
}

/// An explicit profile IS its data root and has no shared parent: handing out
/// the profile's parent would let a caller create or migrate data next to the
/// isolated profile, outside it (and possibly beside the owner's data).
fn refuse_profile_parent(profile: Option<&Path>) -> Result<(), String> {
    match profile {
        Some(_) => Err("Отдельный профиль не имеет общего каталога данных".into()),
        None => Ok(()),
    }
}

/// Path used *on the remote machine* by the SSH chat-workspace helper. It is a
/// literal, not a local resolution: the remote host has its own HOME and may not
/// be the same OS, and existing remote chats already live here.
pub const REMOTE_CHATS_SUBPATH: &str = ".local/share/enki/chats";

/// Legacy OpenCode history database location, opened read-only for import.
///
/// Evidence-first on purpose: if the database already lives under
/// `$HOME/.local/share/opencode` while `XDG_DATA_HOME` points elsewhere, the
/// XDG path would name a database that does not hold the user's history.
/// Default profile only: an explicit profile never opens the owner's history.
pub fn opencode_data_dir() -> Result<PathBuf, String> {
    refuse_profile_parent(profile_override()?.as_deref())?;
    resolve("XDG_DATA_HOME", ".local/share", "opencode")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::sync::{Mutex, MutexGuard};

    /// `set_var` is process-global; these tests must not run concurrently.
    static ENV: Mutex<()> = Mutex::new(());
    fn lock() -> MutexGuard<'static, ()> {
        ENV.lock().unwrap_or_else(|e| e.into_inner())
    }

    struct Scoped(&'static str, Option<std::ffi::OsString>);
    impl Scoped {
        fn set(name: &'static str, value: Option<&Path>) -> Self {
            let previous = std::env::var_os(name);
            match value {
                Some(path) => std::env::set_var(name, path),
                None => std::env::remove_var(name),
            }
            Scoped(name, previous)
        }
    }
    impl Drop for Scoped {
        fn drop(&mut self) {
            match self.1.take() {
                Some(previous) => std::env::set_var(self.0, previous),
                None => std::env::remove_var(self.0),
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn temp_dir(tag: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "ocdesktop-paths-{tag}-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_explicit_profile_never_exposes_a_shared_parent() {
        let profile = std::env::temp_dir().join("enki-profile-fixture");
        assert!(refuse_profile_parent(Some(&profile)).is_err());
        assert!(refuse_profile_parent(None).is_ok());
    }

    #[test]
    fn discovery_never_inspects_the_owner_home_under_a_profile_and_fails_closed() {
        let home = std::env::temp_dir().join("enki-discovery-owner-home");
        let profile = std::env::temp_dir().join("enki-discovery-profile");
        assert_eq!(
            discovery_home_for(Ok(None), Ok(home.clone())),
            Ok(Some(home.clone()))
        );
        // A missing HOME only disables HOME-based discovery.
        assert_eq!(discovery_home_for(Ok(None), Err("HOME".into())), Ok(None));
        assert_eq!(
            discovery_home_for(Ok(Some(profile)), Ok(home.clone())),
            Ok(None)
        );
        assert_eq!(
            discovery_home_for(Err("invalid profile".into()), Ok(home)),
            Err("invalid profile".to_string())
        );
    }

    #[test]
    fn only_absolute_xdg_values_are_honoured() {
        let _guard = lock();
        const VAR: &str = "OCDESKTOP_TEST_XDG_DIR";
        assert_eq!(xdg_override("OCDESKTOP_TEST_UNSET_VARIABLE"), None);
        // A relative or empty value must be ignored, not joined onto the cwd.
        for ignored in ["", "relative/path", ".."] {
            let _scoped = Scoped::set(VAR, Some(Path::new(ignored)));
            assert_eq!(xdg_override(VAR), None, "{ignored:?}");
        }
        let absolute = std::env::temp_dir().join("custom-xdg");
        let _scoped = Scoped::set(VAR, Some(&absolute));
        assert_eq!(xdg_override(VAR), Some(absolute));
    }

    /// The bug this guards: legacy history lives in `$HOME/.local/share/opencode`,
    /// the user exports `XDG_DATA_HOME` for some other tool, and the importer
    /// silently looks for a database that does not exist.
    #[test]
    #[cfg(target_os = "linux")]
    fn an_existing_legacy_history_wins_over_an_unused_xdg_location() {
        let _guard = lock();
        let root = temp_dir("existing");
        let home = root.join("home");
        let xdg = root.join("xdg");
        fs::create_dir_all(home.join(".local/share/opencode")).unwrap();
        fs::create_dir_all(&xdg).unwrap();
        let _home = Scoped::set("HOME", Some(&home));
        let _data = Scoped::set("XDG_DATA_HOME", Some(&xdg));
        assert_eq!(
            opencode_data_dir().unwrap(),
            home.join(".local/share/opencode")
        );
        // Once the XDG location exists it is authoritative again.
        fs::create_dir_all(xdg.join("opencode")).unwrap();
        assert_eq!(opencode_data_dir().unwrap(), xdg.join("opencode"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn a_fresh_linux_install_creates_under_xdg() {
        let _guard = lock();
        let root = temp_dir("fresh");
        let home = root.join("home");
        let xdg = root.join("xdg");
        fs::create_dir_all(&home).unwrap();
        let _home = Scoped::set("HOME", Some(&home));
        let _data = Scoped::set("XDG_DATA_HOME", Some(&xdg));
        assert_eq!(app_data_dir().unwrap(), xdg.join("enki"));
        fs::remove_dir_all(&root).unwrap();
    }

    /// Without XDG variables the result must be identical to the shipped 0.2.x
    /// behaviour on both platforms.
    #[test]
    #[cfg(not(target_os = "windows"))]
    fn without_xdg_variables_both_platforms_use_the_home_layout() {
        let _guard = lock();
        let root = temp_dir("home-only");
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        let _home = Scoped::set("HOME", Some(&home));
        let _config = Scoped::set("XDG_CONFIG_HOME", None);
        let _data = Scoped::set("XDG_DATA_HOME", None);
        assert_eq!(
            opencode_data_dir().unwrap(),
            home.join(".local/share/opencode")
        );
        assert_eq!(app_data_dir().unwrap(), home.join(".local/share/enki"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_remote_helper_path_stays_relative_to_the_remote_home() {
        assert!(!REMOTE_CHATS_SUBPATH.starts_with('/'));
        assert!(REMOTE_CHATS_SUBPATH.ends_with("/chats"));
    }
}
