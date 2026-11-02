//! Record boundary and bounded batches for the durable Hub outbox.
use serde_json::{json, Value};

// Apply privacy at enqueue, queue read and final HTTP send, including older queued cards.
pub(super) fn strip_text(r: &mut Value) {
    if r.get("workshopLog").is_some() {
        return;
    }
    if let Some(o) = r.as_object_mut() {
        o.insert("text".into(), json!(""));
        o.insert("title".into(), json!(""));
        o.remove("assessment");
    }
}
pub(super) fn upload_batch(pending: &[Value]) -> Vec<Value> {
    let mut bytes = 2;
    pending
        .iter()
        .take(20)
        .take_while(|r| {
            bytes += r.to_string().len() + 1;
            bytes <= 1536 * 1024
        })
        .cloned()
        .collect()
}
pub(super) fn prepare_record(mut r: Value, share_text: bool) -> Result<Value, String> {
    if let Some(log) = r.get("workshopLog") {
        let identity = |key: &str| {
            log[key].as_str().is_some_and(|s| {
                !s.is_empty()
                    && s.len() <= 160
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            })
        };
        if r.as_object().is_none_or(|o| o.len() != 1)
            || log.as_object().is_none_or(|o| o.len() != 8)
            || !["requestId", "session", "operation"]
                .iter()
                .all(|k| identity(k))
            || log["agent"] != "desktop"
            || log["level"] != "error"
            || log["detail"] != ""
            || !log["observed"]
                .as_u64()
                .is_some_and(|n| n > 0 && n < 9_000_000_000_000_000)
            || !matches!(
                log["code"].as_str(),
                Some(
                    "stream.timeout"
                        | "stream.http"
                        | "stream.protocol"
                        | "stream.transport"
                        | "stream.ended"
                )
            )
        {
            return Err("Invalid structured transport diagnostic".into());
        }
        return Ok(r);
    }
    if let Some(diagnostic) = r.get("diagnostics") {
        if r["role"] != "user" || !valid_diagnostics(diagnostic) {
            return Err("Invalid numeric task diagnostics".into());
        }
    }
    // A complete user result card can be larger than the old message cap.
    let limit = if r.get("assessment").is_some() {
        192000
    } else {
        64000
    };
    if r.to_string().len() > limit {
        return Err("Record too large".into());
    }
    let o = r.as_object_mut().ok_or("Invalid record")?;
    o.retain(|k, _| {
        [
            "engine",
            "sessionId",
            "id",
            "role",
            "created",
            "completed",
            "title",
            "project",
            "provider",
            "model",
            "variant",
            "tokens",
            "text",
            "error",
            "tools",
            "finish",
            "truncated",
            "assessment",
            "diagnostics",
        ]
        .contains(&k.as_str())
    });
    if !share_text {
        strip_text(&mut r);
    }
    Ok(r)
}

fn valid_diagnostics(value: &Value) -> bool {
    let times = [
        "wallMs",
        "queueMs",
        "preparationMs",
        "firstResponseMs",
        "toolMs",
        "reasoningMs",
        "unattributedMs",
    ];
    let counts = [
        "calls",
        "failed",
        "repeatedCalls",
        "retries",
        "input",
        "output",
        "reasoning",
    ];
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == 4 + times.len() + counts.len()
        && value["schema"].as_u64() == Some(1)
        && matches!(value["source"].as_str(), Some("observed" | "history"))
        && matches!(
            value["state"].as_str(),
            Some("running" | "ended" | "error" | "aborted" | "unknown")
        )
        && value["usageComplete"].is_boolean()
        && times.iter().chain(counts.iter()).all(|key| {
            object.get(*key).is_some_and(|n| {
                n.is_null()
                    || n.as_f64().is_some_and(|n| {
                        n.is_finite()
                            && n >= 0.0
                            && n <= if times.contains(key) {
                                30.0 * 86400000.0
                            } else {
                                1e12
                            }
                    })
            })
        })
}

pub(super) fn verify_origin(
    action: &str,
    expected: Option<&str>,
    origin: &str,
) -> Result<(), String> {
    if matches!(action, "ack" | "enqueue") && expected != Some(origin) {
        return Err("Hub changed; stale outbox operation ignored".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transport_diagnostics_are_durable_without_opening_a_text_side_channel() {
        let log = json!({"workshopLog":{"requestId":"id-1","agent":"desktop","session":"s-1","level":"error",
            "code":"stream.timeout","operation":"event-stream","detail":"","observed":1793650000000u64}});
        assert_eq!(prepare_record(log.clone(), false).unwrap(), log);
        let mut stripped = log.clone();
        strip_text(&mut stripped);
        assert_eq!(stripped, log);
        for (key, value) in [
            ("detail", json!("private")),
            ("code", json!("https://secret")),
            ("observed", json!(-1)),
            ("session", json!("/Users/private")),
        ] {
            let mut bad = log.clone();
            bad["workshopLog"][key] = value;
            assert!(prepare_record(bad, true).is_err());
        }
        let mut bad = log.clone();
        bad["workshopLog"]["extra"] = json!("private");
        assert!(prepare_record(bad, true).is_err());
    }
    fn diagnostic() -> Value {
        json!({"schema":1,"source":"observed","state":"ended","usageComplete":false,
            "wallMs":4000,"queueMs":null,"preparationMs":0,"firstResponseMs":50,
            "toolMs":200,"reasoningMs":null,"unattributedMs":3800,
            "calls":2,"failed":0,"repeatedCalls":1,"retries":null,
            "input":null,"output":null,"reasoning":null})
    }
    #[test]
    fn collection_cannot_cross_hub_profiles() {
        assert!(verify_origin("enqueue", Some("old"), "new").is_err());
        assert!(verify_origin("enqueue", None, "new").is_err());
        assert!(verify_origin("ack", Some("old"), "new").is_err());
        assert!(verify_origin("enqueue", Some("new"), "new").is_ok());
        assert!(verify_origin("read", None, "new").is_ok());
    }
    #[test]
    fn numeric_task_diagnostics_survive_the_native_outbox_without_text_sharing() {
        let d = diagnostic();
        let r = prepare_record(
            json!({"role":"user","diagnostics":d,"text":"private","title":"private"}),
            false,
        )
        .unwrap();
        assert_eq!(r["diagnostics"], d);
        assert_eq!(r["text"], "");
        assert_eq!(r["title"], "");
    }
    #[test]
    fn diagnostics_cannot_be_a_side_channel_for_private_payloads() {
        for (key, value) in [
            ("secret", json!("private")),
            ("calls", json!(true)),
            ("toolMs", json!(-1)),
            ("wallMs", json!(3e12)),
        ] {
            let mut d = diagnostic();
            d[key] = value;
            assert!(prepare_record(json!({"role":"user","diagnostics":d}), true).is_err());
        }
        assert!(
            prepare_record(json!({"role":"assistant","diagnostics":diagnostic()}), true).is_err()
        );
    }
}
