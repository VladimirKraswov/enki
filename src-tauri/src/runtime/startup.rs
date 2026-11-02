//! Read-only startup diagnostics. Never verifies files, starts a process, or
//! exposes a bearer/credential. One attempt is shared by all native callers.
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Default)]
pub struct Startup {
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    run: u64,
    started: Option<Instant>,
    finished: Option<Instant>,
    phase_started: Option<Instant>,
    published: Option<Instant>,
    timestamp: u64,
    phase: &'static str,
    completed: usize,
    total: Option<usize>,
    error: Option<String>,
    failure_code: Option<&'static str>,
    bundled: Option<(String, String)>,
    stages: Vec<Value>,
    log: Option<PathBuf>,
}
fn active(phase: &str) -> bool {
    !matches!(phase, "" | "ready" | "failed" | "cancelled")
}
impl Startup {
    /// Remember whether this caller joined an attempt already in progress.
    pub fn observed(&self) -> (u64, bool) {
        self.state
            .lock()
            .map(|s| (s.run, active(s.phase)))
            .unwrap_or_default()
    }
    /// A concurrent follower receives the same failure. An explicit retry made
    /// AFTER failure is permitted to begin a fresh, bounded attempt.
    pub fn joined_failure(&self, observed: (u64, bool)) -> Option<String> {
        let s = self.state.lock().ok()?;
        if (s.run > observed.0 || observed.1) && matches!(s.phase, "failed" | "cancelled") {
            s.error.clone()
        } else {
            None
        }
    }
    pub fn begin(&self, log: Option<PathBuf>) {
        if let Ok(mut s) = self.state.lock() {
            let run = s.run + 1;
            *s = State {
                run,
                started: Some(Instant::now()),
                phase_started: Some(Instant::now()),
                timestamp: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|t| t.as_millis() as u64)
                    .unwrap_or(0),
                phase: "preparing",
                log,
                ..State::default()
            };
        }
    }
    pub fn progress(&self, phase: &'static str, completed: usize, total: Option<usize>) {
        if let Ok(mut s) = self.state.lock() {
            let changed = s.phase != phase;
            if !changed
                && s.published
                    .is_some_and(|at| at.elapsed() < Duration::from_millis(250))
                && total != Some(completed)
            {
                return;
            }
            if changed {
                if let Some(at) = s.phase_started {
                    let previous = s.phase;
                    s.stages.push(
                        json!({"phase":previous,"elapsedMs":at.elapsed().as_millis() as u64}),
                    );
                }
                s.phase_started = Some(Instant::now());
            }
            s.phase = phase;
            s.completed = completed;
            s.total = total;
            s.published = Some(Instant::now());
            if phase == "ready" {
                s.finished = Some(Instant::now());
            }
            // Phase boundaries only: no per-file disk writes during hashing.
            if changed {
                save(&s);
            }
        }
    }
    pub fn verified(&self, version: String, digest: String) {
        if let Ok(mut s) = self.state.lock() {
            s.bundled = Some((version, digest));
        }
    }
    pub fn failed(&self, error: &str, cancelled: bool) {
        if let Ok(mut s) = self.state.lock() {
            s.error = Some(error.chars().take(600).collect());
            s.failure_code = Some(if cancelled {
                "cancelled"
            } else if error.contains("превысила 15 минут") {
                "verification_timeout"
            } else if matches!(s.phase, "manifest" | "inventory" | "hashing") {
                if error.contains("hash mismatch") {
                    "artifact_hash_mismatch"
                } else if error.contains("cannot") || error.contains("unavailable") {
                    "artifact_io"
                } else {
                    "artifact_integrity"
                }
            } else if s.phase == "starting_node" {
                "node_start"
            } else if s.phase == "waiting_ready" {
                "node_readiness"
            } else {
                "runtime_setup"
            });
            if let Some(at) = s.phase_started {
                let phase = s.phase;
                s.stages
                    .push(json!({"phase":phase,"elapsedMs":at.elapsed().as_millis() as u64}));
            }
            s.phase = if cancelled { "cancelled" } else { "failed" };
            s.finished = Some(Instant::now());
            save(&s);
        }
    }
    pub fn snapshot(&self) -> Value {
        self.state
            .lock()
            .map(|s| snapshot(&s))
            .unwrap_or(Value::Null)
    }
}
fn snapshot(s: &State) -> Value {
    if s.started.is_none() {
        return Value::Null;
    }
    json!({"run":s.run,"phase":s.phase,"startedAt":s.timestamp,"nativeVersion":env!("CARGO_PKG_VERSION"),
        "elapsedMs":s.started.map(|t| s.finished.unwrap_or_else(Instant::now).saturating_duration_since(t).as_millis() as u64),
        "phaseElapsedMs":s.phase_started.map(|t| s.finished.unwrap_or_else(Instant::now).saturating_duration_since(t).as_millis() as u64),
        "completed":s.completed,"total":s.total,"error":s.error,"failureCode":s.failure_code,
        "bundled":s.bundled.as_ref().map(|b| &b.0),"artifactDigest":s.bundled.as_ref().map(|b| &b.1),"stages":s.stages})
}
fn save(s: &State) {
    if let Some(path) = &s.log {
        // Private app data, no paths, prompt text, control frames or environment.
        let mut value = snapshot(s);
        value.as_object_mut().unwrap().remove("error");
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
            options.custom_flags(0x00200000);
            if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_attributes() & 0x400 != 0) {
                return;
            }
        }
        if let Ok(mut file) = options.open(path) {
            if let Ok(meta) = file.metadata() {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return;
                    }
                }
                if !meta.is_file() {
                    return;
                }
                if meta.len() > 1024 * 1024 && file.set_len(0).is_err() {
                    return;
                }
                let _ = writeln!(file, "{value}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disk_report_keeps_failure_category_without_error_text_or_secrets() {
        let root = tempfile::tempdir().unwrap();
        let log = root.path().join("startup.log");
        let s = Startup::default();
        s.begin(Some(log.clone()));
        s.progress("hashing", 3, Some(100));
        s.failed(
            "artifact file cannot be read: private-path-and-token",
            false,
        );
        let raw = std::fs::read_to_string(log).unwrap();
        assert!(!raw.contains("private-path-and-token"));
        let report: Value = serde_json::from_str(raw.lines().last().unwrap()).unwrap();
        assert_eq!(report["failureCode"], "artifact_io");
        assert_eq!(report["completed"], 3);
        assert_eq!(report["total"], 100);
        assert!(report.get("error").is_none());
        assert!(report["stages"].as_array().unwrap().len() >= 2);
    }

    #[test]
    fn followers_share_failure_but_a_later_explicit_retry_can_start() {
        let s = Startup::default();
        let first = s.observed();
        s.begin(None);
        let follower = s.observed();
        s.failed("manifest mismatch", false);
        assert_eq!(
            s.joined_failure(first).as_deref(),
            Some("manifest mismatch")
        );
        assert_eq!(
            s.joined_failure(follower).as_deref(),
            Some("manifest mismatch")
        );
        assert_eq!(s.joined_failure(s.observed()), None);
        s.begin(None);
        s.progress("hashing", 10, Some(12));
        let report = s.snapshot();
        assert_eq!(report["run"], 2);
        assert_eq!(report["completed"], 10);
        assert!(report["error"].is_null());
    }
}
