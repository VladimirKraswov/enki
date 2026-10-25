//! Desktop-owned delivery receipts. Engine transcripts stay with their engine.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Operation {
    pub id: String,
    pub workspace: String,
    pub engine: String,
    pub session_id: String,
    pub directory: String,
    pub source: String,
    pub source_id: Option<String>,
    pub text: String,
    pub attachments: Option<serde_json::Value>,
    pub model: String,
    pub state: String,
    pub updated_at: i64,
    /// Exact ledger that received the send (`runtime:<hostId>`); absent on
    /// records of older engines, whose delivery a 2.0 ledger cannot disprove.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority: Option<String>,
}

fn connection(path: &Path) -> Result<Connection, String> {
    let parent = path.parent().ok_or("Invalid journal path")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    if path
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err("Journal cannot be a symbolic link".into());
    }
    let db = Connection::open(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, state TEXT NOT NULL, updated INTEGER NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, id TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS operation_workspace ON operations(workspace,updated);").map_err(|e| e.to_string())?;
    Ok(db)
}

fn transition(from: Option<&str>, to: &str) -> bool {
    matches!(
        (from, to),
        (None, "prepared")
            | (Some("prepared"), "dispatching" | "cancelled")
            | (
                Some("dispatching"),
                "accepted" | "uncertain" | "refused" | "cancelled"
            )
            | (Some("uncertain"), "accepted")
    )
}

fn write(path: &Path, record: Operation, expected: Option<String>) -> Result<(), String> {
    crate::updates::ensure_writable()?;
    if record.id.len() > 100
        || record.id.is_empty()
        || record.workspace.len() > 1024
        || record.text.len() > 1_000_000
        || record.session_id.is_empty()
        || record.session_id.len() > 200
        || record.directory.len() > 8192
        || !matches!(record.source.as_str(), "manual" | "queue" | "schedule")
        || record.model.len() > 512
        || record.engine.len() > 32
        || record.authority.as_ref().is_some_and(|a| a.len() > 128)
    {
        return Err("Invalid operation".into());
    }
    let body = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    if body.len() > 1_100_000 {
        return Err("Operation is too large".into());
    }
    let mut db = connection(path)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let old: Option<(String, String)> = tx
        .query_row(
            "SELECT state, body FROM operations WHERE id=?1",
            [&record.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if old.is_none() && record.source == "queue" && record.source_id.is_some() {
        let duplicate: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE workspace=?1 AND state IN ('dispatching','accepted','uncertain') AND json_extract(body,'$.source')='queue' AND json_extract(body,'$.sourceId')=?2)", params![record.workspace,record.source_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        if duplicate {
            return Err("Запрос уже отправлялся. Проверьте доставку в журнале.".into());
        }
    }
    if old.as_ref().map(|r| &r.0) != expected.as_ref()
        || !transition(expected.as_deref(), &record.state)
    {
        return Err("Operation changed; do not resend".into());
    }
    if let Some((_, value)) = old {
        let mut previous: Operation = serde_json::from_str(&value).map_err(|e| e.to_string())?;
        previous.state = record.state.clone();
        previous.updated_at = record.updated_at;
        if serde_json::to_string(&previous).map_err(|e| e.to_string())? != body {
            return Err("Operation identity or payload changed".into());
        }
    }
    tx.execute("INSERT INTO operations VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated=excluded.updated,body=excluded.body",
        params![record.id,record.workspace,record.state,record.updated_at,body]).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO events(id,state,at) VALUES(?1,?2,?3)",
        params![record.id, record.state, record.updated_at],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn list(path: &Path, workspace: &str) -> Result<Vec<Operation>, String> {
    let db = connection(path)?;
    let mut query = db.prepare("SELECT body FROM operations WHERE workspace=?1 ORDER BY CASE WHEN state IN ('prepared','dispatching','uncertain') THEN 0 ELSE 1 END, updated DESC LIMIT 500").map_err(|e| e.to_string())?;
    let result = query
        .query_map([workspace], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|value| {
            serde_json::from_str(&value.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect();
    result
}

#[tauri::command]
pub async fn operation_journal(
    window: tauri::Window,
    workspace: String,
    record: Option<Operation>,
    expected: Option<String>,
) -> Result<Vec<Operation>, String> {
    if window.label() != "main" || workspace.len() > 1024 {
        return Err("Not permitted".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::paths::app_data_dir()?.join("recovery/operations.sqlite");
        if let Some(record) = record {
            if record.workspace != workspace {
                return Err("Wrong workspace".into());
            }
            write(&path, record, expected)?;
        }
        list(&path, &workspace)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record() -> Operation {
        Operation {
            id: "msg_test".into(),
            workspace: "host-a".into(),
            engine: "opencode".into(),
            session_id: "chat-a".into(),
            directory: "/test".into(),
            source: "queue".into(),
            source_id: Some("q1".into()),
            text: "private draft".into(),
            attachments: None,
            model: "model".into(),
            state: "prepared".into(),
            updated_at: 1,
            authority: None,
        }
    }
    #[test]
    fn authority_is_part_of_the_immutable_identity_and_old_records_still_load() {
        let root = std::env::temp_dir().join(format!(
            "arvela-journal-authority-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = root.join("journal.sqlite");
        // A pre-authority body (written by an older Enki) still deserializes.
        let old: Operation = serde_json::from_str(r#"{"id":"msg_old","workspace":"host-a","engine":"opencode","sessionId":"ses_a","directory":"/test","source":"manual","sourceId":null,"text":"t","attachments":null,"model":"m","state":"uncertain","updatedAt":1}"#).unwrap();
        assert!(old.authority.is_none());
        let mut r = record();
        r.id = "msg_bound".into();
        r.authority = Some("runtime:00000000-0000-4000-8000-000000000000".into());
        write(&path, r.clone(), None).unwrap();
        r.state = "dispatching".into();
        write(&path, r.clone(), Some("prepared".into())).unwrap();
        // Rebinding a record to another ledger is an identity change.
        let mut other = r.clone();
        other.state = "uncertain".into();
        other.authority = None;
        assert!(write(&path, other, Some("dispatching".into())).is_err());
        assert_eq!(list(&path, "host-a").unwrap()[0].authority, r.authority);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn crash_receipt_is_durable_and_cannot_be_replayed_or_rebound() {
        let root = std::env::temp_dir().join(format!(
            "arvela-journal-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = root.join("journal.sqlite");
        let mut r = record();
        write(&path, r.clone(), None).unwrap();
        r.state = "dispatching".into();
        write(&path, r.clone(), Some("prepared".into())).unwrap();
        assert_eq!(list(&path, "host-a").unwrap()[0].state, "dispatching");
        assert!(list(&path, "host-b").unwrap().is_empty());
        assert!(write(&path, record(), None).is_err());
        r.state = "accepted".into();
        r.directory = "/other".into();
        assert!(write(&path, r.clone(), Some("dispatching".into())).is_err());
        r.directory = "/test".into();
        write(&path, r, Some("dispatching".into())).unwrap();
        assert!(write(&path, record(), Some("accepted".into())).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
