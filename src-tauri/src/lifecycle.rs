//! Explicit application exit, independent of WebView health.
//!
//! Hiding the window (tray, close button) never stops agent work: the Enki
//! Runtime is a child of this native process, not of the WebView. Only an
//! explicit Quit (or an update install) drains the runtime with a bounded
//! deadline. Turns still running at the deadline are recorded by the runtime
//! as uncertain (shown and reconciled after the next start, never replayed)
//! and listed here for the "Требует внимания" panel.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::Manager;

const QUIT_DRAIN: Duration = Duration::from_secs(10);

#[derive(Clone, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InterruptedWork {
    session_id: String,
    directory: String,
    /// Stable runtime identity, so a report is only shown for the local host.
    endpoint: String,
}

#[derive(Default)]
pub struct Lifecycle {
    closing: AtomicBool,
    finished: AtomicBool,
}

impl Lifecycle {
    pub fn closing(&self) -> bool {
        self.closing.load(Ordering::Acquire)
    }
}

/// Parse the runtime's `drained` control message into a bounded report.
fn interrupted(drained: &Value) -> Vec<InterruptedWork> {
    if drained["type"] != "drained" {
        return vec![];
    }
    drained["interrupted"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .take(1024)
                .filter_map(|item| {
                    let session_id = item["sessionID"].as_str()?;
                    let directory = item["directory"].as_str().unwrap_or_default();
                    (!session_id.is_empty()
                        && session_id.len() <= 200
                        && session_id
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
                        && directory.len() <= 8192)
                        .then(|| InterruptedWork {
                            session_id: session_id.to_string(),
                            directory: directory.to_string(),
                            endpoint: "enki-runtime:local".into(),
                        })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn write_report(work: &[InterruptedWork]) {
    let Ok(root) = crate::paths::app_data_dir() else {
        return;
    };
    let dir = root.join("recovery");
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    if let Ok(body) = serde_json::to_vec(work) {
        let _ = std::fs::write(dir.join("last-quit.json"), body);
    }
}

pub fn request_exit(app: &tauri::AppHandle) -> bool {
    let state = app.state::<Lifecycle>();
    if state.finished.load(Ordering::Acquire) {
        return false;
    }
    if state.closing.swap(true, Ordering::AcqRel) {
        return true;
    }
    let app = app.clone();
    // No blocking work on the native UI thread.
    std::thread::spawn(move || {
        app.state::<crate::hub_updates::HubUpdates>()
            .build
            .shutdown();
        let supervisor = app
            .state::<crate::runtime::RuntimeSupervisor>()
            .inner()
            .clone();
        supervisor.shutdown(QUIT_DRAIN);
        write_report(&interrupted(&supervisor.activity()));
        app.state::<Lifecycle>()
            .finished
            .store(true, Ordering::Release);
        app.exit(0);
    });
    true
}

#[tauri::command]
pub fn quit_report(window: tauri::Window) -> Result<Vec<InterruptedWork>, String> {
    if window.label() != "main" {
        return Err("Main window only".into());
    }
    let path = crate::paths::app_data_dir()?.join("recovery/last-quit.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    if path.is_symlink() || std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > 2_000_000 {
        return Err("Invalid quit report".into());
    }
    // Reports from the OpenCode era had a different shape; they are obsolete.
    Ok(
        serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
            .unwrap_or_default(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn drained_report_keeps_only_valid_sessions() {
        let report = interrupted(&json!({
            "type": "drained",
            "interrupted": [
                { "sessionID": "0b7c2a8e-1111-4c1e-9a00-000000000001", "directory": "/w" },
                { "sessionID": "../foreign", "directory": "/w" },
                { "directory": "/w" }
            ]
        }));
        assert_eq!(report.len(), 1);
        assert_eq!(report[0].directory, "/w");
    }

    #[test]
    fn activity_without_drain_is_not_a_report() {
        assert!(interrupted(&json!({ "type": "activity", "idle": false })).is_empty());
        assert!(interrupted(&Value::Null).is_empty());
    }
}
