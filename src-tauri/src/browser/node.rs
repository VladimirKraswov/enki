//! Which Node.js may run the managed browser. Only a user-configured absolute
//! path or a fixed list of well-known absolute locations is considered: PATH
//! and the working directory never choose the interpreter.
use crate::process::{output_with_timeout, RunError};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const MINIMUM_MAJOR: u32 = 20;
const MISSING: &str =
    "Для браузера нужен Node.js 20+; установите Node.js или задайте его абсолютный путь.";
const TOO_OLD: &str = "Браузеру нужен Node.js версии 20 или новее.";
/// Bound on how many discovered interpreters are version-probed.
const MAX_PROBES: usize = 8;
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

fn executable(path: &Path) -> bool {
    if !path.is_absolute() || !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Version-manager layout `<base>/<version>/<suffix>`, newest version first.
/// Directory reads are bounded; unparsable names are ignored.
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn versioned(base: &Path, suffix: &str) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(base) else {
        return Vec::new();
    };
    let mut found: Vec<(Vec<u32>, PathBuf)> = entries
        .flatten()
        .take(256)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            Some((parse_version(&name)?, entry.path().join(suffix)))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, path)| path).collect()
}

#[cfg_attr(target_os = "windows", allow(dead_code))]
fn parse_version(name: &str) -> Option<Vec<u32>> {
    let parts = name
        .trim_start_matches('v')
        .split('.')
        .map(|part| part.parse().ok())
        .collect::<Option<Vec<u32>>>()?;
    (!parts.is_empty()).then_some(parts)
}

/// One lazily evaluated group of absolute candidates. A group is evaluated
/// only when every earlier candidate failed, so a qualifying bundled Node
/// means no HOME path is ever stat'ed and no version-manager tree is read.
type Group = Box<dyn FnOnce() -> Vec<PathBuf>>;

/// Groups in preference order: the verified interpreter bundled with the Enki
/// Runtime, user-level shims, system/package manager installs, then version
/// managers (nvm, fnm, mise, asdf). A system Node that is too old does not
/// hide a newer version-manager install. `home` is None under an explicit
/// profile (see [`crate::paths::discovery_home`]).
fn groups(bundled: Option<PathBuf>, home: Option<PathBuf>) -> Vec<Group> {
    let mut out: Vec<Group> = vec![Box::new(move || bundled.into_iter().collect())];
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = home.clone() {
            out.push(Box::new(move || {
                vec![home.join(".local/bin/node"), home.join(".volta/bin/node")]
            }));
        }
        out.push(Box::new(|| {
            [
                "/opt/homebrew/bin/node",
                "/usr/local/bin/node",
                "/usr/bin/node",
            ]
            .into_iter()
            .map(PathBuf::from)
            .collect()
        }));
        if let Some(home) = home {
            out.push(Box::new(move || {
                let mut found = versioned(&home.join(".nvm/versions/node"), "bin/node");
                found.extend(versioned(
                    &home.join(".local/share/fnm/node-versions"),
                    "installation/bin/node",
                ));
                #[cfg(target_os = "macos")]
                found.extend(versioned(
                    &home.join("Library/Application Support/fnm/node-versions"),
                    "installation/bin/node",
                ));
                found.extend(versioned(
                    &home.join(".local/share/mise/installs/node"),
                    "bin/node",
                ));
                found.extend(versioned(&home.join(".asdf/installs/nodejs"), "bin/node"));
                found
            }));
        }
    }
    #[cfg(target_os = "windows")]
    {
        out.push(Box::new(|| {
            ["ProgramFiles", "ProgramW6432"]
                .into_iter()
                .filter_map(|variable| std::env::var_os(variable).map(PathBuf::from))
                .map(|root| root.join(r"nodejs\node.exe"))
                .collect()
        }));
        if let Some(home) = home {
            out.push(Box::new(move || {
                // nvm-windows points this variable at the active version's
                // directory inside the user's profile.
                let mut found: Vec<PathBuf> = std::env::var_os("NVM_SYMLINK")
                    .map(|active| PathBuf::from(active).join("node.exe"))
                    .into_iter()
                    .collect();
                found.push(home.join(r"AppData\Local\Programs\nodejs\node.exe"));
                found.push(home.join(r"scoop\apps\nodejs\current\node.exe"));
                found.push(home.join(r"scoop\apps\nodejs-lts\current\node.exe"));
                found
            }));
        }
        out.push(Box::new(|| {
            vec![PathBuf::from(r"C:\Program Files\nodejs\node.exe")]
        }));
    }
    out
}

/// First candidate that exists and reports a supported version. At most
/// `MAX_PROBES` interpreters are executed; duplicates are probed once.
fn select(
    groups: Vec<Group>,
    exists: impl Fn(&Path) -> bool,
    mut probe: impl FnMut(&Path) -> Result<u32, String>,
) -> Result<PathBuf, String> {
    let mut seen = std::collections::HashSet::new();
    let (mut probes, mut too_old) = (0, false);
    'groups: for group in groups {
        for candidate in group() {
            if !candidate.is_absolute() || !seen.insert(candidate.clone()) || !exists(&candidate) {
                continue;
            }
            if probes == MAX_PROBES {
                break 'groups;
            }
            probes += 1;
            match probe(&candidate) {
                Ok(major) if major >= MINIMUM_MAJOR => return Ok(candidate),
                Ok(_) => too_old = true,
                Err(_) => {}
            }
        }
    }
    Err(if too_old { TOO_OLD } else { MISSING }.to_string())
}

fn major_version(node: &Path) -> Result<u32, String> {
    let mut command = Command::new(node);
    command.arg("--version");
    let output =
        output_with_timeout(&mut command, PROBE_TIMEOUT, 256).map_err(|error| match error {
            RunError::TimedOut => {
                "Проверка Node.js превысила 5 секунд. Проверьте указанный путь.".to_string()
            }
            RunError::Spawn(_) => "Не удалось запустить Node.js.".to_string(),
        })?;
    if !output.status.success() {
        return Err("Не удалось проверить Node.js.".into());
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|major| major.parse().ok())
        .ok_or_else(|| "Не удалось определить версию Node.js.".to_string())
}

/// A configured interpreter must itself qualify; auto-discovery returns the
/// first candidate that runs and is new enough (see [`groups`]).
pub fn node_program(configured: Option<&str>) -> Result<PathBuf, String> {
    if let Some(value) = configured.map(str::trim).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(value);
        if !executable(&path) {
            return Err("Укажите абсолютный путь к исполняемому Node.js.".into());
        }
        return if major_version(&path)? >= MINIMUM_MAJOR {
            Ok(path)
        } else {
            Err(TOO_OLD.into())
        };
    }
    select(
        groups(
            crate::runtime::known_bundled_node(),
            crate::paths::discovery_home()?,
        ),
        executable,
        major_version,
    )
}

fn npm_beside(node: &Path) -> Option<PathBuf> {
    let parent = node.parent()?;
    let canonical = fs::canonicalize(node).unwrap_or_else(|_| node.to_path_buf());
    let actual = canonical.parent().unwrap_or(parent);
    [
        parent.join("node_modules/npm/bin/npm-cli.js"),
        parent.join("../lib/node_modules/npm/bin/npm-cli.js"),
        actual.join("node_modules/npm/bin/npm-cli.js"),
        actual.join("../lib/node_modules/npm/bin/npm-cli.js"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

/// The real interpreter behind a shim (Volta and similar managers): Node
/// reports its own executable, which keeps npm discovery path-free.
fn real_executable(node: &Path) -> Option<PathBuf> {
    let mut command = Command::new(node);
    command.args(["-p", "process.execPath"]);
    let output = output_with_timeout(&mut command, PROBE_TIMEOUT, 4096).ok()?;
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    (output.status.success() && path.is_absolute()).then_some(path)
}

pub(crate) fn npm_cli(node: &Path) -> Result<PathBuf, String> {
    npm_beside(node)
        .or_else(|| real_executable(node).as_deref().and_then(npm_beside))
        .or_else(|| {
            [
                "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
                "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
                "/usr/share/nodejs/npm/bin/npm-cli.js",
                "/usr/lib/node_modules/npm/bin/npm-cli.js",
            ]
            .map(PathBuf::from)
            .into_iter()
            .find(|path| path.is_file())
        })
        .ok_or_else(|| "Node.js найден, но npm не найден. Установите Node.js вместе с npm.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_path(relative: &str) -> PathBuf {
        std::env::temp_dir()
            .join("enki-node-logical-fixture")
            .join(relative)
    }

    #[test]
    fn version_manager_directories_are_ordered_newest_first() {
        let root = std::env::temp_dir().join(format!(
            "browser-node-versions-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for name in [
            "v18.20.1", "v22.3.0", "v22.12.0", "v20.0.0", "system", "lts",
        ] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        let found: Vec<_> = versioned(&root, "bin/node")
            .into_iter()
            .map(|path| path.strip_prefix(&root).unwrap().to_path_buf())
            .collect();
        assert_eq!(
            found,
            ["v22.12.0", "v22.3.0", "v20.0.0", "v18.20.1"]
                .map(|name| Path::new(name).join("bin/node"))
        );
        fs::remove_dir_all(root).unwrap();
    }

    /// Own fixture HOME with a newer version-manager install; never the
    /// process HOME.
    fn fixture_home(tag: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!(
            "browser-node-home-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(home.join(".nvm/versions/node/v24.1.0/bin")).unwrap();
        fs::write(home.join(".nvm/versions/node/v24.1.0/bin/node"), b"fixture").unwrap();
        home
    }

    fn evaluate(groups: Vec<Group>) -> Vec<PathBuf> {
        groups.into_iter().flat_map(|group| group()).collect()
    }

    #[test]
    fn every_candidate_is_absolute() {
        let home = fixture_home("absolute");
        let bundled = home.join("bundled/node");
        for candidate in evaluate(groups(Some(bundled), Some(home.clone()))) {
            assert!(candidate.is_absolute(), "{}", candidate.display());
        }
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_qualifying_bundled_node_never_evaluates_owner_discovery() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let walked = Arc::new(AtomicBool::new(false));
        let flag = walked.clone();
        let bundled = fixture_path("enki/node/bin/node");
        let chosen = select(
            vec![
                Box::new({
                    let bundled = bundled.clone();
                    move || vec![bundled]
                }),
                Box::new(move || {
                    flag.store(true, Ordering::SeqCst);
                    vec![fixture_path("home/.nvm/versions/node/v24.1.0/bin/node")]
                }),
            ],
            |_| true,
            |_| Ok(24),
        );
        assert_eq!(chosen.unwrap(), bundled);
        assert!(!walked.load(Ordering::SeqCst), "later group was evaluated");

        // Normal discovery is kept: an unusable bundled Node falls through.
        let user = fixture_path("home/.nvm/versions/node/v24.1.0/bin/node");
        let mut probed = Vec::new();
        let chosen = select(
            vec![
                Box::new(|| vec![fixture_path("enki/node/bin/node")]),
                Box::new({
                    let user = user.clone();
                    move || vec![user]
                }),
            ],
            |_| true,
            |path| {
                probed.push(path.to_path_buf());
                Ok(if path == user { 24 } else { 18 })
            },
        );
        assert_eq!(chosen.unwrap(), user);
        assert_eq!(probed.len(), 2);
    }

    #[test]
    fn production_groups_put_the_bundled_node_first_and_stat_no_home_path_after_it() {
        let home = fixture_home("lazy");
        let bundled = fixture_path("enki/node/bin/node");
        let mut first = groups(Some(bundled.clone()), Some(home.clone()));
        assert_eq!(first.remove(0)(), vec![bundled.clone()]);
        let asked = std::cell::RefCell::new(Vec::new());
        let chosen = select(
            groups(Some(bundled.clone()), Some(home.clone())),
            |path| {
                asked.borrow_mut().push(path.to_path_buf());
                true
            },
            |_| Ok(24),
        );
        assert_eq!(chosen.unwrap(), bundled);
        assert_eq!(asked.into_inner(), vec![bundled]);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn an_explicit_profile_never_discovers_under_the_owner_home() {
        let home = fixture_home("profile");
        // Without a profile the user's version manager is normal discovery.
        let owner = crate::paths::discovery_home_for(Ok(None), Ok(home.clone())).unwrap();
        assert_eq!(owner.as_deref(), Some(home.as_path()));
        let owner_candidates = evaluate(groups(None, owner));
        assert!(owner_candidates.iter().any(|path| path.starts_with(&home)));
        #[cfg(not(target_os = "windows"))]
        assert!(owner_candidates.contains(&home.join(".nvm/versions/node/v24.1.0/bin/node")));
        // An isolated profile considers no path below the owner's HOME.
        let profile =
            crate::paths::discovery_home_for(Ok(Some(fixture_path("profile"))), Ok(home.clone()))
                .unwrap();
        assert!(profile.is_none());
        let isolated = evaluate(groups(None, profile));
        assert!(
            isolated.iter().all(|path| !path.starts_with(&home)),
            "{isolated:?}"
        );
        // An invalid profile fails closed; it never falls back to the owner.
        assert_eq!(
            crate::paths::discovery_home_for(Err("invalid profile".into()), Ok(home.clone())),
            Err("invalid profile".to_string())
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn probing_is_bounded_and_duplicates_are_probed_once() {
        let same = fixture_path("node");
        let mut probes = 0;
        let result = select(
            vec![
                Box::new({
                    let same = same.clone();
                    move || vec![same.clone(), same]
                }),
                Box::new(|| {
                    (0..20)
                        .map(|i| fixture_path(&format!("old-{i}/node")))
                        .collect()
                }),
                Box::new(|| vec![PathBuf::from("relative/node")]),
            ],
            |_| true,
            |_| {
                probes += 1;
                Ok(18)
            },
        );
        assert_eq!(result.unwrap_err(), TOO_OLD);
        assert_eq!(probes, MAX_PROBES);
    }

    #[test]
    #[cfg(unix)]
    fn an_old_configured_node_is_refused_with_a_version_message() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("browser-node-old-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let script = root.join("node");
        fs::write(&script, "#!/bin/sh\necho v18.20.1\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(node_program(script.to_str()).unwrap_err(), TOO_OLD);
        fs::write(&script, "#!/bin/sh\necho v22.12.0\n").unwrap();
        assert_eq!(node_program(script.to_str()).unwrap(), script);
        fs::remove_dir_all(root).unwrap();
    }
}
