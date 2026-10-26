//! A copy of the current executable applies a verified prepared release only
//! after the parent exits. The plan is private, bounded and hash-bound.
use super::{atomic, packet, read_json, root};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    artifact: PathBuf,
    target: PathBuf,
    version: String,
    hash: String,
    parent: u32,
}
fn tree_hash(path: &Path) -> Result<String, String> {
    fn walk(root: &Path, p: &Path, out: &mut Vec<u8>) -> Result<(), String> {
        let meta = fs::symlink_metadata(p).map_err(|e| e.to_string())?;
        let name = p
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if meta.file_type().is_symlink() {
            out.extend_from_slice(
                format!(
                    "{name}\0link:{}\n",
                    fs::read_link(p).map_err(|e| e.to_string())?.display()
                )
                .as_bytes(),
            );
        } else if meta.is_dir() {
            let mut items = fs::read_dir(p)
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .map(|e| e.path())
                .collect::<Vec<_>>();
            items.sort();
            for f in items {
                walk(root, &f, out)?;
            }
        } else {
            use sha2::{Digest, Sha256};
            use std::io::Read;
            let mut h = Sha256::new();
            let mut f = fs::File::open(p).map_err(|e| e.to_string())?;
            let mut buffer = [0u8; 65536];
            loop {
                let n = f.read(&mut buffer).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                h.update(&buffer[..n]);
            }
            out.extend_from_slice(format!("{name}\0{:x}\n", h.finalize()).as_bytes());
        }
        Ok(())
    }
    let mut out = vec![];
    walk(path, path, &mut out)?;
    Ok(packet::digest(&out))
}
impl Plan {
    pub fn create(artifact: &Path, version: &str) -> Result<Self, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        let target = exe
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .filter(|p| p.extension().is_some_and(|e| e == "app"))
            .ok_or("Обновление доступно только установленному приложению .app")?
            .to_path_buf();
        #[cfg(not(target_os = "macos"))]
        let target = std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .unwrap_or(exe);
        Ok(Self {
            artifact: artifact.into(),
            target,
            version: version.into(),
            hash: tree_hash(artifact)?,
            parent: std::process::id(),
        })
    }
}
pub fn launch(plan: Plan) -> Result<(), String> {
    if tree_hash(&plan.artifact)? != plan.hash {
        return Err("Подготовленный пакет изменился. Повторите подготовку.".into());
    }
    let dir = root()?.join(format!("apply-{}", std::process::id()));
    fs::create_dir(&dir).map_err(|e| e.to_string())?;
    crate::updates::private(&dir)?;
    let helper = dir.join(if cfg!(windows) { "apply.exe" } else { "apply" });
    fs::copy(std::env::current_exe().map_err(|e| e.to_string())?, &helper)
        .map_err(|e| e.to_string())?;
    let file = dir.join("plan.json");
    atomic(&file, &plan)?;
    let log = fs::File::create(dir.join("install.log")).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(helper);
    cmd.arg("--apply-update")
        .arg(file)
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    crate::process::hide_console(&mut cmd);
    crate::process::own_process_group(&mut cmd);
    cmd.spawn()
        .map_err(|e| format!("Не запущен установщик: {e}"))?;
    Ok(())
}
pub fn cli() -> Result<(), String> {
    let file = PathBuf::from(std::env::args_os().nth(2).ok_or("Missing update plan")?);
    let base = fs::canonicalize(root()?).map_err(|e| e.to_string())?;
    let file = fs::canonicalize(file).map_err(|e| e.to_string())?;
    if !file.starts_with(&base) || file.file_name().is_none_or(|n| n != "plan.json") {
        return Err("Invalid private update plan".into());
    }
    let plan: Plan = read_json(&file)?;
    let applied = apply(&plan);
    // The receipt is diagnostics: its failure is reported but never blocks
    // reopening, and it never claims a rollback that did not happen.
    let recorded = atomic(
        &base.join("last-install.json"),
        &applied.receipt(&plan.version),
    );
    if let Some(e) = applied.error() {
        eprintln!("{e}");
    }
    if let Err(e) = &recorded {
        eprintln!("last-install.json: {e}");
    }
    // Reopen the application that actually exists after this phase.
    reopen(applied.reopen_path(&plan.target))?;
    if applied.installed() {
        if let Some(build) = plan.artifact.ancestors().find(|p| {
            p.parent() == Some(base.as_path())
                && p.file_name().is_some_and(|n| {
                    n.to_string_lossy()
                        .strip_prefix("build-")
                        .is_some_and(packet::hash_ok)
                })
        }) {
            let _ = fs::remove_dir_all(build);
        }
    }
    match applied {
        Applied::Committed { .. } => Ok(()),
        Applied::NotCommitted(e) | Applied::Interrupted { error: e, .. } => Err(e),
    }
}

/// Where an application replacement ended. Only `Committed` means the new
/// bundle is installed; recovery reopens the bundle that actually exists.
#[derive(Debug, PartialEq, Eq)]
// `Interrupted` arises only from the macOS bundle rename sequence.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) enum Applied {
    /// Nothing was replaced; the installed application is untouched at its path.
    NotCommitted(String),
    /// The old bundle was moved aside and could not be put back: it is intact at
    /// `previous`, which is what must be reopened. The new bundle is not installed.
    Interrupted { previous: PathBuf, error: String },
    /// The new bundle is installed at `destination`; the old one is retained at
    /// `previous` (macOS). `warning`: bookkeeping AFTER the commit failed.
    Committed {
        destination: PathBuf,
        previous: Option<PathBuf>,
        warning: Option<String>,
    },
}
impl Applied {
    fn installed(&self) -> bool {
        matches!(self, Self::Committed { .. })
    }
    fn error(&self) -> Option<&str> {
        match self {
            Self::NotCommitted(e) | Self::Interrupted { error: e, .. } => Some(e.as_str()),
            Self::Committed { warning, .. } => warning.as_deref(),
        }
    }
    fn reopen_path<'a>(&'a self, target: &'a Path) -> &'a Path {
        match self {
            Self::NotCommitted(_) => target,
            Self::Interrupted { previous, .. } => previous,
            Self::Committed { destination, .. } => destination,
        }
    }
    fn receipt(&self, version: &str) -> serde_json::Value {
        let (phase, previous) = match self {
            Self::NotCommitted(_) => ("not_committed", None),
            Self::Interrupted { previous, .. } => ("interrupted", Some(previous)),
            Self::Committed { previous, .. } => ("committed", previous.as_ref()),
        };
        serde_json::json!({"version": version, "installed": self.installed(), "phase": phase,
            "error": self.error(), "previous": previous})
    }
}

/// Filesystem steps of a macOS bundle replacement (injectable for fault tests).
#[cfg(any(target_os = "macos", test))]
pub(crate) trait BundleOps {
    fn copy(&mut self, from: &Path, to: &Path) -> Result<(), String>;
    fn rename(&mut self, from: &Path, to: &Path) -> std::io::Result<()>;
    fn record_previous(&mut self, previous: &Path) -> Result<(), String>;
}

/// copy → target→previous → staging→destination (the commit) → previous record.
/// Every failure is classified by the phase it happened in; the old bundle is
/// never deleted.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn replace_bundle(
    ops: &mut impl BundleOps,
    artifact: &Path,
    target: &Path,
    destination: &Path,
    staging: &Path,
    previous: &Path,
) -> Applied {
    if let Err(e) = ops.copy(artifact, staging) {
        let _ = fs::remove_dir_all(staging);
        return Applied::NotCommitted(e);
    }
    if let Err(e) = ops.rename(target, previous) {
        let _ = fs::remove_dir_all(staging);
        return Applied::NotCommitted(format!("Нет права заменить приложение: {e}"));
    }
    if let Err(e) = ops.rename(staging, destination) {
        return match ops.rename(previous, target) {
            Ok(()) => {
                let _ = fs::remove_dir_all(staging);
                Applied::NotCommitted(format!(
                    "Новая версия не установлена: {e}. Прежнее приложение возвращено на место."
                ))
            }
            Err(restore) => Applied::Interrupted {
                previous: previous.into(),
                error: format!(
                    "Новая версия не установлена ({e}), и прежнее приложение не удалось вернуть на место ({restore}). Оно сохранено без изменений: {}",
                    previous.display()
                ),
            },
        };
    }
    // Committed. The previous bundle stays beside the installation for manual recovery.
    let warning = ops.record_previous(previous).err().map(|e| {
        format!(
            "Новая версия установлена, но запись о прежней версии не сохранена: {e}. Прежняя версия лежит в {}",
            previous.display()
        )
    });
    Applied::Committed {
        destination: destination.into(),
        previous: Some(previous.into()),
        warning,
    }
}

#[cfg(target_os = "macos")]
struct SystemBundle;
#[cfg(target_os = "macos")]
impl BundleOps for SystemBundle {
    fn copy(&mut self, from: &Path, to: &Path) -> Result<(), String> {
        let mut copy = Command::new("/usr/bin/ditto");
        copy.arg(from).arg(to);
        successful(&mut copy, Duration::from_secs(120))
    }
    fn rename(&mut self, from: &Path, to: &Path) -> std::io::Result<()> {
        fs::rename(from, to)
    }
    fn record_previous(&mut self, previous: &Path) -> Result<(), String> {
        atomic(
            &root()?.join("previous-app.json"),
            &serde_json::json!({ "path": previous }),
        )
    }
}
fn destination(p: &Plan) -> PathBuf {
    #[cfg(target_os = "macos")]
    if p.artifact.file_name().is_some_and(|n| n == "Enki.app")
        && p.target.file_name().is_some_and(|n| n == "Arvela.app")
    {
        return p.target.with_file_name("Enki.app");
    }
    p.target.clone()
}
fn apply(p: &Plan) -> Applied {
    let checked = (|| -> Result<fs::File, String> {
        semver::Version::parse(&p.version).map_err(|e| e.to_string())?;
        if p.parent == 0 || p.parent == std::process::id() {
            return Err("Invalid parent process".into());
        }
        if !fs::canonicalize(&p.artifact)
            .map_err(|e| e.to_string())?
            .starts_with(fs::canonicalize(root()?).map_err(|e| e.to_string())?)
            || tree_hash(&p.artifact)? != p.hash
        {
            return Err("Собранный пакет изменён".into());
        }
        wait_parent(p.parent)?;
        let lease = super::lease()?;
        if tree_hash(&p.artifact)? != p.hash {
            return Err("Пакет изменён после завершения приложения".into());
        }
        Ok(lease)
    })();
    let _lease = match checked {
        Ok(lease) => lease,
        Err(e) => return Applied::NotCommitted(e),
    };
    replace(p)
}
#[cfg(target_os = "macos")]
fn replace(p: &Plan) -> Applied {
    if p.target.extension().is_none_or(|e| e != "app") || p.target.is_symlink() {
        return Applied::NotCommitted("Invalid installed application".into());
    }
    let destination = destination(p);
    if destination != p.target && destination.exists() {
        return Applied::NotCommitted(
            "Enki.app уже существует. Установка не изменяла приложения.".into(),
        );
    }
    let staging = p
        .target
        .with_file_name(format!(".Enki-update-{}.app", std::process::id()));
    let previous = p
        .target
        .with_file_name(format!(".Enki-previous-{}.app", std::process::id()));
    if staging.exists() || previous.exists() {
        return Applied::NotCommitted("Installation staging already exists".into());
    }
    replace_bundle(
        &mut SystemBundle,
        &p.artifact,
        &p.target,
        &destination,
        &staging,
        &previous,
    )
}
#[cfg(not(target_os = "macos"))]
fn replace(p: &Plan) -> Applied {
    match replace_package(p) {
        Ok(()) => Applied::Committed {
            destination: destination(p),
            previous: None,
            warning: None,
        },
        Err(e) => Applied::NotCommitted(e),
    }
}
#[cfg(not(target_os = "macos"))]
fn replace_package(p: &Plan) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let destination = p.target.parent().ok_or("Missing install directory")?;
        let mut cmd = Command::new(&p.artifact);
        cmd.arg("/S").arg(format!("/D={}", destination.display()));
        successful(&mut cmd, Duration::from_secs(600))?;
    }
    #[cfg(target_os = "linux")]
    {
        if p.artifact.extension().is_some_and(|e| e == "AppImage") {
            replace_appimage(&p.artifact, &p.target, &root()?.join("previous.AppImage"))?;
        } else {
            let deb = p.artifact.extension().is_some_and(|e| e == "deb");
            if !deb && p.artifact.extension().is_none_or(|e| e != "rpm") {
                return Err("Unsupported Linux package".into());
            }
            let mut cmd = Command::new("/usr/bin/pkexec");
            cmd.arg(if deb { "/usr/bin/dpkg" } else { "/usr/bin/rpm" })
                .arg(if deb { "-i" } else { "-U" })
                .arg(&p.artifact);
            successful(&mut cmd, Duration::from_secs(600))?;
        }
    }
    Ok(())
}
/// Copy the new AppImage beside the installed one, keep a private copy of the
/// installed one, then rename over it (the commit). A failure before the
/// commit leaves the installed AppImage untouched and removes only the staging
/// file this call created, so it can never block every later update.
#[cfg(all(unix, any(target_os = "linux", test)))]
fn replace_appimage(artifact: &Path, target: &Path, previous: &Path) -> Result<(), String> {
    let staging = target.with_extension("update-partial");
    if fs::symlink_metadata(&staging).is_ok() {
        return Err("Installation staging already exists".into());
    }
    let result = (|| {
        use std::os::unix::fs::PermissionsExt;
        fs::copy(artifact, &staging).map_err(|e| e.to_string())?;
        fs::set_permissions(&staging, fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
        fs::copy(target, previous).map_err(|e| e.to_string())?;
        fs::rename(&staging, target).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}
fn successful(cmd: &mut Command, limit: Duration) -> Result<(), String> {
    let out = crate::process::output_with_timeout(cmd, limit, 65536)
        .map_err(|_| "Установщик не запустился или превысил время ожидания")?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Установщик завершился с кодом {:?}. Предыдущая версия сохранена.",
            out.status.code()
        ))
    }
}
#[cfg(unix)]
fn wait_parent(pid: u32) -> Result<(), String> {
    for _ in 0..600 {
        if unsafe { libc::kill(pid as i32, 0) } != 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("Приложение не завершилось за 60 секунд; установка отменена".into())
}
#[cfg(windows)]
fn wait_parent(pid: u32) -> Result<(), String> {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, id: u32) -> *mut c_void;
        fn WaitForSingleObject(handle: *mut c_void, ms: u32) -> u32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    const ERROR_INVALID_PARAMETER: i32 = 87;
    let handle = unsafe { OpenProcess(0x00100000, 0, pid) };
    if handle.is_null() {
        // No process has this id any more: the parent has already exited. The
        // update lease taken right after this wait is the second guard.
        if std::io::Error::last_os_error().raw_os_error() == Some(ERROR_INVALID_PARAMETER) {
            return Ok(());
        }
        return Err("Cannot observe parent exit".into());
    }
    let result = unsafe { WaitForSingleObject(handle, 60000) };
    unsafe { CloseHandle(handle) };
    if result == 0 {
        Ok(())
    } else {
        Err("Приложение не завершилось; установка отменена".into())
    }
}
fn reopen(target: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("/usr/bin/open");
        c.arg("-n").arg(target);
        c
    };
    #[cfg(not(target_os = "macos"))]
    let mut cmd = Command::new(target);
    crate::process::hide_console(&mut cmd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(target_os = "macos")]
    fn renamed_bundle_has_new_destination_without_overwriting_another_name() {
        let p = Plan {
            artifact: "/build/Enki.app".into(),
            target: "/Applications/Arvela.app".into(),
            version: "0.2.83".into(),
            hash: "a".repeat(64),
            parent: 1,
        };
        assert_eq!(destination(&p), Path::new("/Applications/Enki.app"));
        let custom = Plan {
            target: "/Applications/Custom.app".into(),
            ..p.clone()
        };
        assert_eq!(destination(&custom), custom.target);
        let bridge = Plan {
            artifact: "/build/Arvela.app".into(),
            ..p
        };
        assert_eq!(destination(&bridge), bridge.target);
    }
    /// Real renames in an own temporary directory; one chosen step fails.
    struct Faults {
        fail: &'static str,
        renames: usize,
    }
    impl BundleOps for Faults {
        fn copy(&mut self, from: &Path, to: &Path) -> Result<(), String> {
            if self.fail == "copy" {
                fs::create_dir(to).unwrap();
                return Err("copy failed".into());
            }
            fs::create_dir(to).map_err(|e| e.to_string())?;
            fs::copy(from.join("id"), to.join("id")).map_err(|e| e.to_string())?;
            Ok(())
        }
        fn rename(&mut self, from: &Path, to: &Path) -> std::io::Result<()> {
            self.renames += 1;
            let step = match self.renames {
                1 => "aside",
                2 => "commit",
                _ => "restore",
            };
            if self.fail == step || (self.fail == "commit+restore" && step != "aside") {
                return Err(std::io::Error::other(format!("{step} failed")));
            }
            fs::rename(from, to)
        }
        fn record_previous(&mut self, _previous: &Path) -> Result<(), String> {
            if self.fail == "record" {
                Err("disk full".into())
            } else {
                Ok(())
            }
        }
    }
    type Outcome = (PathBuf, Applied, PathBuf, PathBuf, PathBuf);
    fn bundle(fail: &'static str, rename_destination: bool) -> Outcome {
        let dir = std::env::temp_dir().join(format!(
            "enki-install-{fail}-{rename_destination}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("build/Enki.app")).unwrap();
        fs::write(dir.join("build/Enki.app/id"), b"new").unwrap();
        let name = if rename_destination {
            "Arvela.app"
        } else {
            "Enki.app"
        };
        let target = dir.join(name);
        fs::create_dir(&target).unwrap();
        fs::write(target.join("id"), b"old").unwrap();
        let destination = dir.join("Enki.app");
        let staging = dir.join(".Enki-update-1.app");
        let previous = dir.join(".Enki-previous-1.app");
        let mut ops = Faults { fail, renames: 0 };
        let artifact = dir.join("build/Enki.app");
        let applied = replace_bundle(
            &mut ops,
            &artifact,
            &target,
            &destination,
            &staging,
            &previous,
        );
        (dir, applied, target, destination, previous)
    }
    fn id(path: &Path) -> Option<String> {
        fs::read_to_string(path.join("id")).ok()
    }
    #[test]
    fn every_replacement_phase_is_classified_and_reopens_the_bundle_that_exists() {
        for rename_destination in [false, true] {
            // Before the commit: nothing changed, the installed app reopens.
            for fail in ["copy", "aside", "commit"] {
                let (dir, applied, target, destination, _) = bundle(fail, rename_destination);
                assert!(
                    matches!(applied, Applied::NotCommitted(_)),
                    "{fail}: {applied:?}"
                );
                assert!(!applied.installed());
                assert_eq!(id(&target).as_deref(), Some("old"), "{fail}");
                assert_eq!(applied.reopen_path(&target), target.as_path());
                if rename_destination {
                    assert!(!destination.exists(), "{fail}");
                }
                assert_eq!(applied.receipt("2.0.0")["phase"], "not_committed");
                fs::remove_dir_all(dir).unwrap();
            }
            // Commit failed AND the old bundle could not be put back: it is intact
            // at its hidden path, which is what is reopened; never "rolled back".
            let (dir, applied, target, _, previous) = bundle("commit+restore", rename_destination);
            assert!(
                matches!(&applied, Applied::Interrupted { .. }),
                "{applied:?}"
            );
            assert!(!target.exists());
            assert_eq!(id(&previous).as_deref(), Some("old"));
            assert_eq!(applied.reopen_path(&target), previous.as_path());
            assert_eq!(applied.receipt("2.0.0")["phase"], "interrupted");
            assert_eq!(applied.receipt("2.0.0")["installed"], false);
            fs::remove_dir_all(dir).unwrap();
            // Committed, previous-app record failed: installed with a warning; the
            // NEW destination reopens and the old bytes stay at the previous path.
            for fail in ["record", "none"] {
                let (dir, applied, target, destination, previous) =
                    bundle(fail, rename_destination);
                assert!(applied.installed(), "{fail}: {applied:?}");
                assert_eq!(id(&destination).as_deref(), Some("new"));
                assert_eq!(id(&previous).as_deref(), Some("old"));
                assert_eq!(applied.reopen_path(&target), destination.as_path());
                let receipt = applied.receipt("2.0.0");
                assert_eq!(receipt["phase"], "committed");
                assert_eq!(receipt["installed"], true);
                assert_eq!(receipt["previous"], previous.display().to_string());
                assert_eq!(applied.error().is_some(), fail == "record");
                if rename_destination {
                    assert!(
                        !target.exists(),
                        "the legacy name was moved aside, not overwritten"
                    );
                }
                fs::remove_dir_all(dir).unwrap();
            }
        }
    }
    #[test]
    #[cfg(unix)]
    fn a_failed_appimage_replacement_keeps_the_installed_file_and_never_blocks_retry() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "enki-appimage-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(dir.join("build")).unwrap();
        let artifact = dir.join("build/Enki.AppImage");
        let target = dir.join("Enki.AppImage");
        fs::write(&artifact, b"new").unwrap();
        fs::write(&target, b"old").unwrap();
        // The private previous copy cannot be written: nothing is committed.
        let unwritable = dir.join("missing/previous.AppImage");
        assert!(replace_appimage(&artifact, &target, &unwritable).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"old");
        assert!(
            !target.with_extension("update-partial").exists(),
            "own staging removed, so the next attempt is not refused"
        );
        // The retry commits: new bytes installed and executable, old ones kept.
        let previous = dir.join("previous.AppImage");
        replace_appimage(&artifact, &target, &previous).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(fs::read(&previous).unwrap(), b"old");
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o755
        );
        // A foreign staging file is never removed or overwritten.
        fs::write(target.with_extension("update-partial"), b"foreign").unwrap();
        assert!(replace_appimage(&artifact, &target, &previous).is_err());
        assert_eq!(
            fs::read(target.with_extension("update-partial")).unwrap(),
            b"foreign"
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn artifact_hash_detects_post_build_tampering() {
        let p = std::env::temp_dir().join(format!("arvela-artifact-{}", std::process::id()));
        fs::write(&p, b"one").unwrap();
        let before = tree_hash(&p).unwrap();
        fs::write(&p, b"two").unwrap();
        assert_ne!(before, tree_hash(&p).unwrap());
        fs::remove_file(p).unwrap();
    }
}
