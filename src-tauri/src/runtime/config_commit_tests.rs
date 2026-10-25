//! Native authority regressions. The OS vault is an injectable in-memory map
//! (no keychain interaction); filesystem, SQLite journal and recovery are real.
use super::*;
use base64::Engine;
use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex,
    },
};

/// Sentinels contain literal `$VAR`/`${VAR}` text that must stay literal.
const API_KEY: &str = "sk-SENTINEL-apikey-$HOME-abc$VAR";
const HEADER: &str = "Bearer ${SENTINEL_TOKEN}-header";
const OAUTH: &str = "{\"type\":\"oauth\",\"access\":\"SENTINEL-access\",\"refresh\":\"SENTINEL-refresh\",\"expires\":1}";

#[derive(Default)]
struct MemoryOs {
    values: Mutex<HashMap<String, String>>,
    fail_set: AtomicBool,
}
impl SecretOs for MemoryOs {
    fn get(&self, account: &str) -> Result<Option<String>, VaultError> {
        Ok(self.values.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, value: &str) -> Result<(), VaultError> {
        if self.fail_set.load(Ordering::SeqCst) {
            return Err(VaultError::Write);
        }
        self.values
            .lock()
            .unwrap()
            .insert(account.into(), value.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), VaultError> {
        self.values.lock().unwrap().remove(account);
        Ok(())
    }
}
impl MemoryOs {
    fn refs(&self) -> Vec<String> {
        self.values
            .lock()
            .unwrap()
            .keys()
            .filter(|k| k.starts_with(vault::REF_PREFIX))
            .cloned()
            .collect()
    }
}

struct Fixture {
    root: PathBuf,
    os: Arc<MemoryOs>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn fixture(name: &str) -> Fixture {
    // Canonicalize the test temp parent once (macOS /var is a link); the
    // authority itself never canonicalizes and refuses links below it.
    let base = fs::canonicalize(std::env::temp_dir()).unwrap();
    let root = base.join(format!(
        "enki-config-{name}-{}-{}",
        std::process::id(),
        vault::random_id().unwrap()
    ));
    fs::create_dir(&root).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    }
    Fixture {
        root,
        os: Arc::new(MemoryOs::default()),
    }
}
impl Fixture {
    fn authority(&self, owner: &str) -> Authority {
        Authority::new(self.root.clone(), self.os.clone(), owner, None)
    }
    fn crashing(&self, owner: &str, point: &'static str) -> Authority {
        let fired = Arc::new(AtomicBool::new(false));
        let fault: Fault = Arc::new(move |at| {
            if at == point && !fired.swap(true, Ordering::SeqCst) {
                Err(format!("simulated crash at {at}"))
            } else {
                Ok(())
            }
        });
        Authority::new(self.root.clone(), self.os.clone(), owner, Some(fault))
    }
    /// Every byte the authority wrote below its root.
    fn disk(&self) -> Vec<u8> {
        fn walk(path: &Path, out: &mut Vec<u8>) {
            for entry in fs::read_dir(path).unwrap().flatten() {
                let p = entry.path();
                if p.is_dir() {
                    walk(&p, out)
                } else {
                    out.extend(fs::read(&p).unwrap_or_default())
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.root, &mut out);
        out
    }
}

fn logical(name: &str) -> String {
    format!("pi-import-{}", vault::sha256_hex(name.as_bytes()))
}
fn models() -> Vec<u8> {
    br#"{"providers":{"fixture":{"baseUrl":"http://127.0.0.1:9/v1","api":"openai-completions","models":[{"id":"m"}]}}}"#.to_vec()
}
fn settings() -> Vec<u8> {
    let mut big = br#"{"defaultModel":"m","pad":""#.to_vec();
    big.extend(std::iter::repeat_n(b'x', CHUNK + 17)); // spans two chunks
    big.extend(br#""}"#);
    big
}

struct Plan {
    files: Vec<(&'static str, Vec<u8>)>,
    secrets: Vec<(String, &'static str, Option<&'static str>, &'static str)>,
}
fn plan() -> Plan {
    Plan {
        files: vec![("models.json", models()), ("settings.json", settings())],
        secrets: vec![
            (logical("api"), "api-key", Some("fixture"), API_KEY),
            (logical("header"), "header", Some("fixture"), HEADER),
            (logical("oauth"), "credential", Some("oauthfixture"), OAUTH),
        ],
    }
}
fn manifest_of(plan: &Plan, expected: u64) -> Value {
    json!({
        "version": 1, "origin": "fixture-origin", "expectedRevision": expected,
        "files": plan.files.iter().map(|(n, b)| json!({ "name": n, "sha256": vault::sha256_hex(b), "size": b.len() })).collect::<Vec<_>>(),
        "sourceHashes": { "models.json": vault::sha256_hex(b"source") },
        "bindings": plan.secrets.iter().map(|(id, kind, provider, _)| json!({ "vaultId": id, "pointer": format!("/x/{kind}"), "provider": provider, "kind": kind })).collect::<Vec<_>>(),
        "deferred": ["/settings/extensions"],
        "discovery": { "extensions": false, "skills": false, "prompts": false, "packages": false, "project": false },
    })
}
fn stage(a: &Authority, op: &str, plan: &Plan, expected: u64) -> Result<(), String> {
    a.begin(&json!({ "operationId": op, "manifest": manifest_of(plan, expected) }))?;
    for (name, bytes) in &plan.files {
        for (index, chunk) in bytes.chunks(CHUNK).enumerate() {
            let data = base64::engine::general_purpose::STANDARD.encode(chunk);
            a.file_chunk(
                &json!({ "operationId": op, "name": name, "index": index, "dataBase64": data }),
            )?;
        }
    }
    for (id, _, _, value) in &plan.secrets {
        a.secret_put(&json!({ "operationId": op, "logicalId": id, "value": value }))?;
    }
    Ok(())
}
fn import(a: &Authority, op: &str, plan: &Plan, expected: u64) -> Result<Value, String> {
    stage(a, op, plan, expected)?;
    a.commit(&json!({ "operationId": op }))
}
const OP_A: &str = "op-aaaaaaaaaaaaaaaaaaaa";
const OP_B: &str = "op-bbbbbbbbbbbbbbbbbbbb";

fn assert_no_plaintext(f: &Fixture, extra: &[&str]) {
    let disk = f.disk();
    for needle in ["SENTINEL", API_KEY, HEADER].iter().chain(extra) {
        assert!(
            !disk.windows(needle.len()).any(|w| w == needle.as_bytes()),
            "{needle} reached disk"
        );
    }
}

#[test]
fn import_publishes_exact_receipt_and_keeps_values_off_disk() {
    let f = fixture("receipt");
    let a = f.authority("gen-1");
    let p = plan();
    let receipt = import(&a, OP_A, &p, 0).unwrap();
    assert_eq!(receipt["configRevision"], 1);
    let ids: Vec<String> = serde_json::from_value(receipt["vaultIds"].clone()).unwrap();
    assert_eq!(ids.len(), 3);
    for (id, ..) in &p.secrets {
        assert!(ids.contains(id));
    }
    for (name, bytes) in &p.files {
        assert!(receipt["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["name"] == *name && x["sha256"] == vault::sha256_hex(bytes)));
    }
    let snapshot = a.current().unwrap();
    assert_eq!(snapshot["generationId"], receipt["generationId"]);
    let dir = PathBuf::from(snapshot["directory"].as_str().unwrap());
    assert_eq!(fs::read(dir.join("models.json")).unwrap(), models());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(dir.join("settings.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    let read = a
        .secret_read(&json!({ "configRevision": 1, "logicalId": logical("header") }))
        .unwrap();
    assert_eq!(
        read["value"], HEADER,
        "literal ${{VAR}} text is returned byte-for-byte"
    );
    assert!(a
        .secret_read(&json!({ "configRevision": 0, "logicalId": logical("header") }))
        .unwrap_err()
        .starts_with("CONFIG_REVISION_CHANGED"));
    assert_no_plaintext(&f, &[]);
    assert!(
        !snapshot.to_string().contains("SENTINEL") && !receipt.to_string().contains("SENTINEL")
    );
}

#[test]
fn preexisting_legacy_and_versioned_credentials_survive_import() {
    let f = fixture("preexisting");
    f.os.set(&vault::legacy_account("oauthfixture"), "legacy-user-value")
        .unwrap();
    let a = f.authority("gen-1");
    let receipt = import(&a, OP_A, &plan(), 0).unwrap();
    assert_eq!(
        receipt["conflicts"][0]["policy"],
        "existing-provider-credential-kept"
    );
    let read = a
        .credential_read(&json!({ "providerId": "oauthfixture" }))
        .unwrap();
    assert_eq!(
        (read["value"].as_str(), read["source"].as_str()),
        (Some("legacy-user-value"), Some("legacy"))
    );
    assert_eq!(
        f.os.get(&vault::legacy_account("oauthfixture"))
            .unwrap()
            .as_deref(),
        Some("legacy-user-value")
    );

    // A versioned credential configured in Enki also wins over a later import.
    let g = fixture("preexisting-versioned");
    let b = g.authority("gen-1");
    b.compare_and_set(&json!({ "operationId": OP_B, "providerId": "oauthfixture", "expectedRevision": 0, "value": "enki-configured" })).unwrap();
    import(&b, OP_A, &plan(), 0).unwrap();
    assert_eq!(
        b.credential_read(&json!({ "providerId": "oauthfixture" }))
            .unwrap()["value"],
        "enki-configured"
    );
}

#[test]
fn import_without_existing_provider_credential_becomes_the_provider_credential() {
    let f = fixture("adopt");
    let a = f.authority("gen-1");
    let receipt = import(&a, OP_A, &plan(), 0).unwrap();
    assert_eq!(receipt["conflicts"].as_array().unwrap().len(), 0);
    let read = a
        .credential_read(&json!({ "providerId": "oauthfixture" }))
        .unwrap();
    assert_eq!(
        (read["value"].as_str(), read["revision"].as_u64()),
        (Some(OAUTH), Some(1))
    );
}

#[test]
fn concurrent_imports_cannot_overwrite_or_roll_back_each_other() {
    let f = fixture("concurrent");
    let a = f.authority("gen-1");
    let mut second = plan();
    second.secrets[0].3 = "sk-SENTINEL-second-import";
    stage(&a, OP_A, &plan(), 0).unwrap();
    stage(&a, OP_B, &second, 0).unwrap();
    let first = a.commit(&json!({ "operationId": OP_A })).unwrap();
    let error = a.commit(&json!({ "operationId": OP_B })).unwrap_err();
    assert!(error.starts_with("CONFIG_REVISION_CONFLICT"), "{error}");
    let read = a
        .secret_read(&json!({ "configRevision": 1, "logicalId": logical("api") }))
        .unwrap();
    assert_eq!(
        read["value"], API_KEY,
        "loser cleanup must not touch the winner's refs"
    );
    assert_eq!(a.current().unwrap()["generationId"], first["generationId"]);
    assert_eq!(
        a.status(&json!({ "operationId": OP_B })).unwrap()["phase"],
        "aborted"
    );
    assert!(!f
        .os
        .values
        .lock()
        .unwrap()
        .values()
        .any(|v| v == "sk-SENTINEL-second-import"));
    assert_eq!(f.os.refs().len(), 3);
}

#[test]
fn lost_ack_retries_return_one_receipt_and_never_accept_changed_payload() {
    let f = fixture("lost-ack");
    let a = f.authority("gen-1");
    let p = plan();
    stage(&a, OP_A, &p, 0).unwrap();
    // Duplicate chunk / secret after a lost ACK are idempotent only if identical.
    let data = base64::engine::general_purpose::STANDARD.encode(models());
    a.file_chunk(
        &json!({ "operationId": OP_A, "name": "models.json", "index": 0, "dataBase64": data }),
    )
    .unwrap();
    let other = base64::engine::general_purpose::STANDARD.encode(b"{\"providers\":{}}");
    assert!(a
        .file_chunk(
            &json!({ "operationId": OP_A, "name": "models.json", "index": 0, "dataBase64": other })
        )
        .is_err());
    a.secret_put(&json!({ "operationId": OP_A, "logicalId": logical("api"), "value": API_KEY }))
        .unwrap();
    let changed = a
        .secret_put(
            &json!({ "operationId": OP_A, "logicalId": logical("api"), "value": "sk-changed" }),
        )
        .unwrap_err();
    assert!(changed.starts_with("CONFIG_SECRET_CONFLICT") && !changed.contains("sk-changed"));
    let receipt = a.commit(&json!({ "operationId": OP_A })).unwrap();
    assert_eq!(a.commit(&json!({ "operationId": OP_A })).unwrap(), receipt);
    // A later runtime generation can still reconcile the receipt.
    let later = f.authority("gen-2");
    let status = later.status(&json!({ "operationId": OP_A })).unwrap();
    assert_eq!(
        (status["phase"].as_str(), &status["receipt"]),
        (Some("committed"), &receipt)
    );
    assert_eq!(
        later
            .begin(&json!({ "operationId": OP_A, "manifest": manifest_of(&p, 0) }))
            .unwrap()["phase"],
        "committed"
    );
    assert!(later
        .begin(&json!({ "operationId": OP_A, "manifest": manifest_of(&p, 1) }))
        .unwrap_err()
        .starts_with("CONFIG_OPERATION_CONFLICT"));
    assert_eq!(
        f.os.refs().len(),
        3,
        "no secret was replayed into a new ref"
    );
}

fn listing(path: &Path) -> Vec<String> {
    fs::read_dir(path)
        .map(|d| {
            d.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn crash_after_every_vault_and_file_boundary_recovers_exactly() {
    let points = [
        "begin.journaled",
        "chunk.written",
        "secret.intent",
        "secret.written",
        "files.synced",
        "files.published",
        "head.before",
        "head.committed",
    ];
    for point in points {
        let f = fixture("crash");
        let source = f.root.join("source-models.json");
        fs::write(&source, b"{\"source\":\"read-only\"}").unwrap();
        let before = fs::read(&source).unwrap();
        let error = import(&f.crashing("gen-1", point), OP_A, &plan(), 0).unwrap_err();
        assert!(error.contains(point), "{point}: {error}");
        // Child death: the next runtime generation opens the authority.
        let next = f.authority("gen-2");
        if point != "head.committed" {
            // A read never assumes the unretired owner dead: pending, intact.
            let pending = next.status(&json!({ "operationId": OP_A })).unwrap();
            assert!(
                matches!(pending["phase"].as_str(), Some("prepared" | "published")),
                "{point}: {pending}"
            );
            // Its first claiming call retires gen-1 (enforced writer
            // exclusivity) and only then reclaims gen-1's job.
            assert_eq!(
                next.abort(&json!({ "operationId": OP_A })).unwrap()["phase"],
                "aborted",
                "{point}"
            );
        }
        let status = next.status(&json!({ "operationId": OP_A })).unwrap();
        let snapshot = next.current().unwrap();
        if point == "head.committed" {
            assert_eq!(status["phase"], "committed", "{point}");
            assert_eq!(snapshot["configRevision"], 1);
            assert_eq!(f.os.refs().len(), 3);
            assert_eq!(
                next.secret_read(&json!({ "configRevision": 1, "logicalId": logical("api") }))
                    .unwrap()["value"],
                API_KEY
            );
        } else {
            assert_eq!(status["phase"], "aborted", "{point}");
            assert!(status["error"]
                .as_str()
                .unwrap()
                .starts_with("CONFIG_INTERRUPTED"));
            assert_eq!(
                snapshot["configRevision"], 0,
                "{point}: previous head stays active"
            );
            assert!(f.os.refs().is_empty(), "{point}: owned staged refs removed");
            assert!(listing(&f.root.join("staging")).is_empty(), "{point}");
            assert!(listing(&f.root.join("generations")).is_empty(), "{point}");
            assert_eq!(
                next.credential_read(&json!({ "providerId": "oauthfixture" }))
                    .unwrap()["source"],
                "none"
            );
            // A fresh import (new id, never a blind replay) still succeeds.
            import(&next, OP_B, &plan(), 0).unwrap();
        }
        assert_eq!(
            fs::read(&source).unwrap(),
            before,
            "{point}: source untouched"
        );
        assert_no_plaintext(&f, &[]);
    }
}

#[test]
fn crash_during_cleanup_is_resumed_without_touching_foreign_refs() {
    let f = fixture("cleanup-crash");
    let a = f.authority("gen-1");
    import(&a, OP_A, &plan(), 0).unwrap();
    let mut rotated = plan();
    rotated.secrets[0].3 = "sk-SENTINEL-rotated";
    stage(&a, OP_B, &rotated, 1).unwrap();
    let crashing = f.crashing("gen-1", "cleanup.vault");
    assert!(crashing.abort(&json!({ "operationId": OP_B })).is_err());
    let next = f.authority("gen-2");
    // The successor's claiming call retires gen-1 and resumes the cleanup.
    assert_eq!(
        next.abort(&json!({ "operationId": OP_B })).unwrap()["phase"],
        "aborted"
    );
    assert_eq!(
        next.status(&json!({ "operationId": OP_B })).unwrap()["phase"],
        "aborted"
    );
    assert_eq!(
        f.os.refs().len(),
        3,
        "only the aborted job's own refs were removed"
    );
    assert_eq!(
        next.secret_read(&json!({ "configRevision": 1, "logicalId": logical("api") }))
            .unwrap()["value"],
        API_KEY
    );
}

#[test]
fn wrong_owner_cannot_continue_and_rotation_keeps_committed_generation() {
    let f = fixture("owner");
    let a = f.authority("gen-1");
    import(&a, OP_A, &plan(), 0).unwrap();
    let mut rotated = plan();
    rotated.secrets[0].3 = "sk-SENTINEL-rotated";
    stage(&a, OP_B, &rotated, 1).unwrap();
    // Lifetime contract (not a deadness proof): a later generation of this
    // process exists only after the runtime revoked gen-1, and its first
    // claiming call ENFORCES that by retiring gen-1. It never continues or
    // commits gen-1's job; the reclaim rolls back ONLY that job's staged refs.
    let other = f.authority("gen-2");
    assert!(other
        .commit(&json!({ "operationId": OP_B }))
        .unwrap_err()
        .contains("CONFIG_INTERRUPTED"));
    assert!(a
        .status(&json!({ "operationId": OP_B }))
        .unwrap_err()
        .starts_with("CONFIG_GENERATION_REVOKED"));
    assert!(a.begin(&json!({ "operationId": "op-eeeeeeeeeeeeeeeeeeee", "manifest": manifest_of(&rotated, 1) })).unwrap_err().starts_with("CONFIG_GENERATION_REVOKED"));
    assert!(
        other.abort(&json!({ "operationId": OP_A })).unwrap()["phase"] == "committed",
        "commit is never reverted"
    );
    assert_eq!(
        other
            .secret_read(&json!({ "configRevision": 1, "logicalId": logical("api") }))
            .unwrap()["value"],
        API_KEY
    );
    assert!(!f
        .os
        .values
        .lock()
        .unwrap()
        .values()
        .any(|v| v == "sk-SENTINEL-rotated"));
    // Same logical id rotated by a committed import: new ref, old generation kept.
    let receipt = import(&other, "op-cccccccccccccccccccc", &rotated, 1).unwrap();
    assert_eq!(receipt["configRevision"], 2);
    assert_eq!(
        f.os.refs().len(),
        6,
        "previous generation retained for running projections"
    );
    assert_eq!(
        other
            .secret_read(&json!({ "configRevision": 2, "logicalId": logical("api") }))
            .unwrap()["value"],
        "sk-SENTINEL-rotated"
    );
}

#[test]
fn oauth_cas_never_overwrites_a_newer_credential_or_replays_a_refresh() {
    let f = fixture("cas");
    f.os.set(&vault::legacy_account("prov"), "legacy").unwrap();
    let a = f.authority("gen-1");
    let cas = |op: &str, expected: u64, value: Value| {
        a.compare_and_set(&json!({ "operationId": op, "providerId": "prov", "expectedRevision": expected, "value": value }))
    };
    assert_eq!(
        a.credential_read(&json!({ "providerId": "prov" })).unwrap()["revision"],
        0
    );
    assert_eq!(
        cas("cas-0000000000000001", 0, json!("tok-1")).unwrap()["revision"],
        1
    );
    // Two refreshers read revision 1; only the first wins.
    assert_eq!(
        cas("cas-0000000000000002", 1, json!("tok-2")).unwrap()["revision"],
        2
    );
    let lost = cas("cas-0000000000000003", 1, json!("tok-3")).unwrap();
    assert_eq!(
        (lost["conflict"].as_bool(), lost["revision"].as_u64()),
        (Some(true), Some(2))
    );
    // Lost ACK of the winning CAS: same outcome, no second write.
    assert_eq!(
        cas("cas-0000000000000002", 1, json!("tok-2")).unwrap()["revision"],
        2
    );
    assert!(cas("cas-0000000000000002", 0, json!("tok-2"))
        .unwrap_err()
        .starts_with("CONFIG_OPERATION_CONFLICT"));
    assert_eq!(
        a.credential_read(&json!({ "providerId": "prov" })).unwrap()["value"],
        "tok-2"
    );
    assert_eq!(f.os.refs().len(), 1, "superseded refs are collected");
    // Crash between the OS write and the CAS row keeps revision 2.
    let crashing = f.crashing("gen-1", "cas.written");
    assert!(crashing.compare_and_set(&json!({ "operationId": "cas-0000000000000004", "providerId": "prov", "expectedRevision": 2, "value": "tok-4" })).is_err());
    let next = f.authority("gen-2");
    let read = next
        .credential_read(&json!({ "providerId": "prov" }))
        .unwrap();
    assert_eq!(
        (read["value"].as_str(), read["revision"].as_u64()),
        (Some("tok-2"), Some(2))
    );
    assert_eq!(f.os.refs().len(), 1, "crashed intent ref removed");
    // Explicit delete is a tombstone; the legacy entry is never deleted.
    assert_eq!(next.compare_and_set(&json!({ "operationId": "cas-0000000000000005", "providerId": "prov", "expectedRevision": 2, "value": null })).unwrap()["revision"], 3);
    assert_eq!(
        next.credential_read(&json!({ "providerId": "prov" }))
            .unwrap()["source"],
        "deleted"
    );
    assert_eq!(
        f.os.get(&vault::legacy_account("prov")).unwrap().as_deref(),
        Some("legacy")
    );
}

#[test]
fn vault_failure_oversized_or_missing_secret_never_moves_the_head() {
    let f = fixture("limits");
    let a = f.authority("gen-1");
    let p = plan();
    a.begin(&json!({ "operationId": OP_A, "manifest": manifest_of(&p, 0) }))
        .unwrap();
    let big = "x".repeat(MAX_SECRET + 1);
    let error = a
        .secret_put(&json!({ "operationId": OP_A, "logicalId": logical("api"), "value": big }))
        .unwrap_err();
    assert!(error.starts_with("CONFIG_SECRET_TOO_LARGE"));
    f.os.fail_set.store(true, Ordering::SeqCst);
    assert!(a
        .secret_put(&json!({ "operationId": OP_A, "logicalId": logical("api"), "value": API_KEY }))
        .unwrap_err()
        .starts_with("CONFIG_VAULT_WRITE"));
    f.os.fail_set.store(false, Ordering::SeqCst);
    assert!(a
        .commit(&json!({ "operationId": OP_A }))
        .unwrap_err()
        .starts_with("CONFIG_INCOMPLETE"));
    assert_eq!(a.current().unwrap()["configRevision"], 0);
    a.abort(&json!({ "operationId": OP_A })).unwrap();

    // Staged ref removed externally before commit: verification refuses.
    stage(&a, OP_B, &p, 0).unwrap();
    let staged = f.os.refs();
    f.os.delete(&staged[0]).unwrap();
    assert!(a
        .commit(&json!({ "operationId": OP_B }))
        .unwrap_err()
        .starts_with("CONFIG_SECRET_UNAVAILABLE"));
    assert_eq!(a.current().unwrap()["configRevision"], 0);
    a.abort(&json!({ "operationId": OP_B })).unwrap();
    assert!(f.os.refs().is_empty());

    // After commit, a vanished binding fails closed on read; no fallback.
    import(&a, "op-dddddddddddddddddddd", &p, 0).unwrap();
    for account in f.os.refs() {
        f.os.delete(&account).unwrap();
    }
    assert!(a
        .secret_read(&json!({ "configRevision": 1, "logicalId": logical("header") }))
        .unwrap_err()
        .starts_with("CONFIG_SECRET_UNAVAILABLE"));
    assert!(a
        .credential_read(&json!({ "providerId": "oauthfixture" }))
        .unwrap_err()
        .starts_with("CONFIG_SECRET_UNAVAILABLE"));
}

#[test]
fn manifest_schema_identity_and_inventory_budget_fail_closed() {
    let f = fixture("schema");
    let a = f.authority("gen-1");
    let p = plan();
    let begin = |manifest: Value| a.begin(&json!({ "operationId": OP_A, "manifest": manifest }));
    let mut unknown = manifest_of(&p, 0);
    unknown["secrets"] = json!([{ "value": "sk-SENTINEL-in-manifest" }]);
    let error = begin(unknown).unwrap_err();
    assert!(error.starts_with("CONFIG_SCHEMA") && !error.contains("SENTINEL"));
    let mut auth = manifest_of(&p, 0);
    auth["files"][0]["name"] = json!("auth.json");
    assert!(begin(auth).is_err());
    let mut provider = manifest_of(&p, 0);
    provider["bindings"][0]["provider"] = json!("bad provider/../x");
    assert!(begin(provider)
        .unwrap_err()
        .starts_with("CONFIG_PROVIDER_ID_UNSUPPORTED"));
    let mut discovery = manifest_of(&p, 0);
    discovery["discovery"]["extensions"] = json!(true);
    assert!(begin(discovery).is_err());
    let mut huge = manifest_of(&p, 0);
    huge["files"][0]["size"] = json!(MAX_FILE + 1);
    assert!(begin(huge).is_err());
    let mut namespace = manifest_of(&p, 0);
    namespace["bindings"][0]["vaultId"] = json!("pi-provider:fixture");
    assert!(
        begin(namespace).is_err(),
        "import refs never alias the provider namespace"
    );
    assert!(begin(manifest_of(&p, 7))
        .unwrap_err()
        .starts_with("CONFIG_REVISION_CONFLICT"));
    assert!(dispatch("config.current", &json!({}), None)
        .unwrap_err()
        .starts_with("CONFIG_LOCAL_ONLY"));
    assert_eq!(a.current().unwrap()["configRevision"], 0);
}

#[test]
fn reads_before_any_write_create_nothing_and_keep_legacy_credentials_available() {
    let f = fixture("lazy");
    let root = f.root.join("runtime-config");
    let a = Authority::new(root.clone(), f.os.clone(), "gen-1", None);
    f.os.set(&vault::legacy_account("old"), "legacy-key")
        .unwrap();
    f.os.set(
        vault::LEGACY_INDEX,
        "[\"pi-provider:old\",\"pi-provider:bad id\"]",
    )
    .unwrap();
    assert_eq!(
        a.call("config.current", &json!({})).unwrap()["generationId"],
        Value::Null
    );
    assert_eq!(
        a.call("vault.credentialRead", &json!({ "providerId": "old" }))
            .unwrap()["value"],
        "legacy-key"
    );
    assert_eq!(
        a.call("vault.credentialList", &json!({})).unwrap()["providers"],
        json!(["old"])
    );
    assert!(!root.exists(), "read-only calls never create the authority");
    a.call("vault.compareAndSet", &json!({ "operationId": OP_A, "providerId": "old", "expectedRevision": 0, "value": "new-key" })).unwrap();
    assert!(root.join("authority.sqlite").exists());
    assert_eq!(
        a.call("vault.credentialRead", &json!({ "providerId": "old" }))
            .unwrap()["value"],
        "new-key"
    );
    assert_eq!(
        f.os.get(&vault::legacy_account("old")).unwrap().as_deref(),
        Some("legacy-key"),
        "legacy entry untouched"
    );
}

#[cfg(unix)]
#[test]
fn linked_root_or_staging_is_refused() {
    let f = fixture("links");
    let real = f.root.join("real");
    fs::create_dir(&real).unwrap();
    std::os::unix::fs::symlink(&real, f.root.join("linked")).unwrap();
    let linked = Authority::new(f.root.join("linked"), f.os.clone(), "gen-1", None);
    assert!(linked
        .current()
        .unwrap_err()
        .starts_with("CONFIG_UNSAFE_PATH"));
    let a = f.authority("gen-1");
    std::os::unix::fs::symlink(&real, f.root.join("staging")).unwrap();
    assert!(a
        .begin(&json!({ "operationId": OP_A, "manifest": manifest_of(&plan(), 0) }))
        .is_err());
    assert!(
        listing(&real).is_empty(),
        "nothing written through the link"
    );
}

const ROTATED: &str = "sk-SENTINEL-rotated";
const THIRD: &str = "sk-SENTINEL-third";

#[test]
fn live_reader_observes_a_staged_import_and_only_a_retired_owner_is_reclaimed() {
    let f = fixture("live-reader");
    let a = f.authority("gen-1");
    import(&a, OP_A, &plan(), 0).unwrap();
    let mut rotated = plan();
    rotated.secrets[0].3 = ROTATED;
    a.begin(&json!({ "operationId": OP_B, "manifest": manifest_of(&rotated, 1) }))
        .unwrap();
    // A live authorized reader between gen-1's calls: observes, never reclaims.
    let b = f.authority("gen-2");
    assert_eq!(
        b.status(&json!({ "operationId": OP_B })).unwrap()["phase"],
        "prepared"
    );
    stage(&a, OP_B, &rotated, 1).unwrap();
    assert_eq!(b.current().unwrap()["configRevision"], 1);
    assert_eq!(
        b.status(&json!({ "operationId": OP_B })).unwrap()["phase"],
        "prepared"
    );
    b.credential_list().unwrap();
    b.credential_read(&json!({ "providerId": "oauthfixture" }))
        .unwrap();
    assert!(
        f.os.values.lock().unwrap().values().any(|v| v == ROTATED),
        "staged ref survives reads"
    );
    assert_eq!(
        a.commit(&json!({ "operationId": OP_B })).unwrap()["configRevision"],
        2
    );
    assert_eq!(b.current().unwrap()["configRevision"], 2);

    // gen-1 stages again; gen-2's first CLAIMING call retires gen-1.
    let mut third = plan();
    third.secrets[0].3 = THIRD;
    let op_c = "op-cccccccccccccccccccc";
    stage(&a, op_c, &third, 2).unwrap();
    let committed = f.os.refs().len() - 3;
    b.compare_and_set(&json!({ "operationId": "cas-0000000000000009", "providerId": "unrelated", "expectedRevision": 0, "value": "k" })).unwrap();
    let status = b.status(&json!({ "operationId": op_c })).unwrap();
    assert_eq!(status["phase"], "aborted");
    assert!(status["error"]
        .as_str()
        .unwrap()
        .starts_with("CONFIG_INTERRUPTED"));
    assert!(
        !f.os.values.lock().unwrap().values().any(|v| v == THIRD),
        "retired owner's staged refs removed"
    );
    assert_eq!(
        f.os.refs().len(),
        committed + 1,
        "committed + previous generations kept, plus the new CAS ref"
    );
    assert_eq!(
        b.secret_read(&json!({ "configRevision": 2, "logicalId": logical("api") }))
            .unwrap()["value"],
        ROTATED
    );
    // A retired generation is never re-admitted, not even for reads.
    assert!(a
        .status(&json!({ "operationId": op_c }))
        .unwrap_err()
        .starts_with("CONFIG_GENERATION_REVOKED"));
    assert!(a
        .current()
        .unwrap_err()
        .starts_with("CONFIG_GENERATION_REVOKED"));
}

#[test]
fn another_live_process_job_is_never_reclaimed_until_its_lease_is_released() {
    let f = fixture("process-lease");
    let other = f.authority("gen-p").with_process("proc-other-0001");
    stage(&other, OP_A, &plan(), 0).unwrap();
    let me = f.authority("gen-1");
    // Its OS lease is held: alive. Claiming calls here cannot touch its job.
    assert!(me
        .commit(&json!({ "operationId": OP_A }))
        .unwrap_err()
        .starts_with("CONFIG_OPERATION_OWNER"));
    assert!(me
        .abort(&json!({ "operationId": OP_A }))
        .unwrap_err()
        .starts_with("CONFIG_OPERATION_OWNER"));
    me.compare_and_set(&json!({ "operationId": "cas-0000000000000001", "providerId": "mine", "expectedRevision": 0, "value": "k" })).unwrap();
    assert_eq!(
        me.status(&json!({ "operationId": OP_A })).unwrap()["phase"],
        "prepared"
    );
    assert_eq!(f.os.refs().len(), 4);
    // The other process can still continue (not retired by this process).
    assert_eq!(
        other.commit(&json!({ "operationId": OP_A })).unwrap()["configRevision"],
        1
    );

    let late = f.authority("gen-q").with_process("proc-other-0002");
    let mut rotated = plan();
    rotated.secrets[0].3 = ROTATED;
    stage(&late, OP_B, &rotated, 1).unwrap();
    late.release_process_lease(); // that process died: the OS released its lease
    assert_eq!(
        me.status(&json!({ "operationId": OP_B })).unwrap()["phase"],
        "aborted",
        "proven-dead owner reclaimed"
    );
    assert!(!f.os.values.lock().unwrap().values().any(|v| v == ROTATED));
    assert_eq!(
        me.secret_read(&json!({ "configRevision": 1, "logicalId": logical("api") }))
            .unwrap()["value"],
        API_KEY
    );
}

#[test]
fn revoked_admission_is_refused_before_any_recovery_or_write() {
    let f = fixture("admission");
    let admitted = Arc::new(AtomicBool::new(true));
    let flag = admitted.clone();
    let a = f
        .authority("gen-1")
        .with_admission(Arc::new(move || flag.load(Ordering::SeqCst)));
    let cas = |op: &str, expected: u64| {
        a.compare_and_set(&json!({ "operationId": op, "providerId": "prov", "expectedRevision": expected, "value": "tok" }))
    };
    assert_eq!(cas("cas-0000000000000001", 0).unwrap()["revision"], 1);
    admitted.store(false, Ordering::SeqCst);
    assert!(cas("cas-0000000000000002", 1)
        .unwrap_err()
        .starts_with("CONFIG_GENERATION_REVOKED"));
    assert!(a
        .begin(&json!({ "operationId": OP_A, "manifest": manifest_of(&plan(), 0) }))
        .unwrap_err()
        .starts_with("CONFIG_GENERATION_REVOKED"));
    let read = f
        .authority("gen-2")
        .credential_read(&json!({ "providerId": "prov" }))
        .unwrap();
    assert_eq!(
        (read["value"].as_str(), read["revision"].as_u64()),
        (Some("tok"), Some(1))
    );
    assert_eq!(
        f.authority("gen-2")
            .status(&json!({ "operationId": OP_A }))
            .unwrap()["phase"],
        "unknown"
    );
}

fn cas_on(a: &Authority, op: &str, expected: u64, value: Value) -> Result<Value, String> {
    a.compare_and_set(&json!({ "operationId": op, "providerId": "prov", "expectedRevision": expected, "value": value }))
}

#[test]
fn cas_receipt_is_bound_to_the_complete_request_even_after_newer_writes() {
    const A: &str = "SENTINEL-value-A";
    const B: &str = "SENTINEL-value-B";
    let (op1, op2, op3) = (
        "cas-0000000000000001",
        "cas-0000000000000002",
        "cas-0000000000000003",
    );
    let f = fixture("cas-request");
    let a = f.authority("gen-1");
    let conflict =
        |r: Result<Value, String>| r.unwrap_err().starts_with("CONFIG_OPERATION_CONFLICT");
    let ok = cas_on(&a, op1, 0, json!(A)).unwrap();
    assert_eq!(ok, json!({ "revision": 1 }));
    assert_eq!(
        cas_on(&a, op1, 0, json!(A)).unwrap(),
        ok,
        "identical retry: original receipt"
    );
    assert!(
        conflict(cas_on(&a, op1, 0, json!(B))),
        "same provider+expected, changed value"
    );
    assert!(
        conflict(cas_on(&a, op1, 0, Value::Null)),
        "same provider+expected, value -> null"
    );
    // A conflict receipt is bound the same way.
    let lost = cas_on(&a, op2, 0, json!(B)).unwrap();
    assert_eq!(lost, json!({ "conflict": true, "revision": 1 }));
    assert_eq!(cas_on(&a, op2, 0, json!(B)).unwrap(), lost);
    assert!(conflict(cas_on(&a, op2, 0, json!(A))));
    assert!(conflict(cas_on(&a, op2, 0, Value::Null)));
    // A null (delete) request: null -> value is a different request too.
    let removed = cas_on(&a, op3, 1, Value::Null).unwrap();
    assert_eq!(cas_on(&a, op3, 1, Value::Null).unwrap(), removed);
    assert!(conflict(cas_on(&a, op3, 1, json!(A))));
    // Newer writes collect A's ref; the old receipts stay exact.
    cas_on(&a, "cas-0000000000000004", 2, json!("SENTINEL-value-C")).unwrap();
    cas_on(&a, "cas-0000000000000005", 3, json!("SENTINEL-value-D")).unwrap();
    assert_eq!(f.os.refs().len(), 1);
    let later = f.authority("gen-2");
    assert_eq!(
        cas_on(&later, op1, 0, json!(A)).unwrap(),
        ok,
        "old successful receipt after newer writes"
    );
    assert!(conflict(cas_on(&later, op1, 0, json!(B))));
    assert!(conflict(cas_on(&later, op1, 0, Value::Null)));
    assert_eq!(cas_on(&later, op2, 0, json!(B)).unwrap(), lost);
    assert!(conflict(cas_on(&later, op2, 0, json!(A))));
    let read = later
        .credential_read(&json!({ "providerId": "prov" }))
        .unwrap();
    assert_eq!(
        (read["value"].as_str(), read["revision"].as_u64()),
        (Some("SENTINEL-value-D"), Some(4))
    );
    // Journal: no value, no plain digest of a value, no MAC key.
    let key =
        f.os.get(vault::CAS_KEY_ACCOUNT)
            .unwrap()
            .expect("key lives only in the OS vault");
    let digests: Vec<String> = [A, B]
        .iter()
        .map(|v| vault::sha256_hex(v.as_bytes()))
        .collect();
    let extra: Vec<&str> = digests
        .iter()
        .map(String::as_str)
        .chain([key.as_str()])
        .collect();
    assert_no_plaintext(&f, &extra);
}

const HOLDER_ENV: &str = "ENKI_CONFIG_LOCK_HOLDER";
const HOLDER_READY: &str = "ENKI-CONFIG-LOCK-HELD";

/// Child-process fixture, spawned only by the real OS-lock tests below
/// (`hold_authority_lock`) through this test binary: holds the exact OS
/// authority lock until its stdin closes (or 30 s pass), then exits. Without
/// the env var it does nothing.
#[test]
#[ignore = "fixture: spawned by hold_authority_lock for the real OS-lock tests"]
fn lock_holder_fixture() {
    use std::io::{BufRead, Write};
    let Some(path) = std::env::var_os(HOLDER_ENV) else {
        return;
    };
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .unwrap();
    fs2::FileExt::try_lock_exclusive(&file).unwrap();
    println!("{HOLDER_READY}");
    std::io::stdout().flush().unwrap();
    let (done, wait) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = std::io::stdin().lock().read_line(&mut String::new());
        let _ = done.send(());
    });
    let _ = wait.recv_timeout(Duration::from_secs(30));
    drop(file);
}

/// Always releases and reaps the own fixture: stdin EOF, bounded wait, then
/// kill only as a cleanup fallback for this test's own child.
struct Holder(Option<std::process::Child>);
impl Drop for Holder {
    fn drop(&mut self) {
        let Some(mut child) = self.0.take() else {
            return;
        };
        drop(child.stdin.take());
        let until = Instant::now() + Duration::from_secs(10);
        while Instant::now() < until {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Spawns this test binary's own `lock_holder_fixture` on the fixture's exact
/// authority lock and returns once the child holds it. Dropping the Holder
/// releases the lock; then join the returned stdout reader.
fn hold_authority_lock(f: &Fixture) -> (Holder, std::thread::JoinHandle<()>) {
    use std::io::BufRead;
    use std::process::{Command, Stdio};
    // libtest names omit the crate: runtime::config_commit::tests::lock_holder_fixture
    let name = module_path!()
        .split_once("::")
        .map_or(module_path!(), |(_, rest)| rest);
    let filter = format!("{name}::lock_holder_fixture");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            filter.as_str(),
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(HOLDER_ENV, f.root.join("authority.lock"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let holder = Holder(Some(child));
    let (ready, held) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
        {
            if line.contains(HOLDER_READY) {
                let _ = ready.send(());
            }
        }
    });
    held.recv_timeout(Duration::from_secs(30))
        .expect("own fixture holds the authority lock");
    (holder, reader)
}

#[test]
fn foreign_lock_holder_process_gets_a_bounded_busy_result_and_the_head_is_unchanged() {
    let f = fixture("lock-holder");
    let a = f.authority("gen-1");
    assert_eq!(
        cas_on(&a, "cas-0000000000000001", 0, json!("tok-1")).unwrap()["revision"],
        1
    );
    let before = a.current().unwrap();
    let (holder, reader) = hold_authority_lock(&f);

    let bounded = f
        .authority("gen-1")
        .with_lock_deadline(Duration::from_millis(300));
    let calls: [(&str, Value); 4] = [
        (
            "vault.compareAndSet",
            json!({ "operationId": "cas-0000000000000002", "providerId": "prov", "expectedRevision": 1, "value": "tok-2" }),
        ),
        (
            "config.begin",
            json!({ "operationId": OP_A, "manifest": manifest_of(&plan(), 0) }),
        ),
        ("vault.credentialRead", json!({ "providerId": "prov" })),
        ("config.current", json!({})),
    ];
    for (method, params) in calls {
        let started = Instant::now();
        let error = bounded.call(method, &params).unwrap_err();
        assert!(
            error.starts_with("CONFIG_AUTHORITY_BUSY"),
            "{method}: {error}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{method} returned boundedly"
        );
    }
    drop(holder);
    reader.join().unwrap();

    // Nothing was admitted while busy: same head, same credential revision,
    // and the busy CAS id was never journaled (so it is not a receipt).
    assert_eq!(a.current().unwrap(), before);
    let read = a.credential_read(&json!({ "providerId": "prov" })).unwrap();
    assert_eq!(
        (read["value"].as_str(), read["revision"].as_u64()),
        (Some("tok-1"), Some(1))
    );
    assert_eq!(
        a.status(&json!({ "operationId": OP_A })).unwrap()["phase"],
        "unknown"
    );
    assert_eq!(
        cas_on(&bounded, "cas-0000000000000002", 1, json!("tok-2")).unwrap()["revision"],
        2
    );
}

/// Every path below the root with its exact bytes (directories empty), sorted.
fn snapshot(f: &Fixture) -> Vec<(PathBuf, Vec<u8>)> {
    fn walk(path: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
        for entry in fs::read_dir(path).unwrap().flatten() {
            let p = entry.path();
            if p.is_dir() {
                walk(&p, out);
                out.push((p, Vec::new()));
            } else {
                let bytes = fs::read(&p).unwrap_or_default();
                out.push((p, bytes));
            }
        }
    }
    let mut out = Vec::new();
    walk(&f.root, &mut out);
    out.sort();
    out
}

#[test]
fn admission_is_rechecked_under_the_lease_after_the_entry_checks_passed() {
    let f = fixture("admission-lease");
    let a = f.authority("gen-1");
    assert_eq!(
        cas_on(&a, "cas-0000000000000001", 0, json!("tok-1")).unwrap()["revision"],
        1
    );
    let before = snapshot(&f);
    // Live at call entry and open entry; revoked by the time the lease is held.
    let checks = Arc::new(AtomicUsize::new(0));
    let seen = checks.clone();
    let late = f
        .authority("gen-2")
        .with_admission(Arc::new(move || seen.fetch_add(1, Ordering::SeqCst) < 2));
    // The public `call` entry (what `serve` dispatches), not `compare_and_set`
    // directly: only `call` performs the entry check counted below.
    let error = late
        .call(
            "vault.compareAndSet",
            &json!({ "operationId": "cas-0000000000000002", "providerId": "prov", "expectedRevision": 1, "value": "tok-2" }),
        )
        .unwrap_err();
    assert!(error.starts_with("CONFIG_GENERATION_REVOKED"), "{error}");
    assert_eq!(
        checks.load(Ordering::SeqCst),
        3,
        "call entry, open entry, under the lease"
    );
    assert_eq!(snapshot(&f), before);
    // gen-2 never claimed (gen-1 is not retired) and its id is no receipt.
    assert_eq!(
        cas_on(&a, "cas-0000000000000002", 1, json!("tok-2")).unwrap()["revision"],
        2
    );
}

/// Production composition against a REAL foreign OS lock holder: runtime
/// BrokerJob -> its own retained permit's admission -> `serve` (dispatch's
/// path) -> Authority at the OS lease. Only `Authority::production`'s root and
/// keychain are replaced by the fixture root and injectable SecretOs.
#[test]
fn revoke_while_admitted_requests_wait_for_the_os_lock_denies_them_without_any_effect() {
    use super::super::{control::GenerationGate, BrokerJob};
    let f = fixture("revoke-wait");
    let fx = &f;
    let previous = f.authority("gen-1");
    assert_eq!(
        cas_on(&previous, "cas-0000000000000001", 0, json!("tok-1")).unwrap()["revision"],
        1
    );
    stage(&previous, OP_A, &plan(), 0).unwrap();
    let head = previous.current().unwrap();
    let before = snapshot(&f);
    let secrets = f.os.values.lock().unwrap().clone();

    let gate = GenerationGate::new(2, 4);
    let request = |id: &str, method: &str, params: Value| BrokerJob {
        message: json!({ "type": "request", "id": id, "method": method, "params": params }),
        permit: Arc::new(gate.admit().unwrap()),
    };
    let cas = |op: &str, expected: u64, value: &str| json!({ "operationId": op, "providerId": "prov", "expectedRevision": expected, "value": value });
    let waiting = [
        request(
            "r-begin",
            "config.begin",
            json!({ "operationId": OP_B, "manifest": manifest_of(&plan(), 0) }),
        ),
        request(
            "r-cas",
            "vault.compareAndSet",
            cas("cas-0000000000000002", 1, "tok-2"),
        ),
    ];
    // Admitted before revoke but served after it (still queued).
    let queued = request(
        "r-queued",
        "vault.compareAndSet",
        cas("cas-0000000000000003", 1, "tok-3"),
    );

    let (holder, reader) = hold_authority_lock(&f);
    let started = Instant::now();
    let (waited, joined) = std::thread::scope(|scope| {
        let workers: Vec<_> = waiting
            .into_iter()
            .map(|job| {
                scope.spawn(move || {
                    let response = job.respond("gen-2", |method, params, admission| {
                        serve(fx.authority("gen-2"), admission, method, params)
                    });
                    (response, job)
                })
            })
            .collect();
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            workers.iter().all(|w| !w.is_finished()),
            "both requests wait for the held OS lock"
        );
        assert!(
            !gate.wait_drained_until(Instant::now()),
            "waiting requests are owned work"
        );
        gate.revoke();
        assert!(gate.admit().is_err(), "no request is admitted after revoke");
        // Revoked waiters stop waiting while the foreign lock is still held.
        let until = Instant::now() + Duration::from_secs(2);
        while workers.iter().any(|w| !w.is_finished()) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            workers.iter().all(|w| w.is_finished()),
            "revoked waiters do not wait out LOCK_DEADLINE"
        );
        let waited = started.elapsed();
        drop(holder);
        reader.join().unwrap();
        (
            waited,
            workers
                .into_iter()
                .map(|w| w.join().unwrap())
                .collect::<Vec<_>>(),
        )
    });
    let (responses, settled): (Vec<Value>, Vec<BrokerJob>) = joined.into_iter().unzip();
    assert!(
        waited < LOCK_DEADLINE,
        "returned revoked, not busy, while the lock was held: {waited:?}"
    );
    for (response, id) in responses.iter().zip(["r-begin", "r-cas"]) {
        let ok = (
            response["id"].as_str(),
            response["generation"].as_str(),
            response["ok"].as_bool(),
        );
        assert_eq!(ok, (Some(id), Some("gen-2"), Some(false)));
        assert!(
            response["error"]
                .as_str()
                .unwrap()
                .starts_with("CONFIG_GENERATION_REVOKED"),
            "{response}"
        );
    }
    // Settled responses whose jobs are not yet dropped still hold the drain.
    assert!(!gate.wait_drained_until(Instant::now()));
    let late = queued.respond("gen-2", |_, _, _| {
        panic!("a revoked generation's queued request reached the broker")
    });
    assert_eq!(late["ok"], false);
    // A late call with a revoked request's admission, now uncontended: refused.
    let stale = serve(
        f.authority("gen-2"),
        settled[0].admission(),
        "config.current",
        &json!({}),
    )
    .unwrap_err();
    assert!(stale.starts_with("CONFIG_GENERATION_REVOKED"), "{stale}");
    drop(settled);
    drop(queued);
    assert!(
        gate.wait_drained_until(Instant::now()),
        "drained once every owned job is settled and dropped"
    );

    // No claim, recovery, journal, head or secret effect of the revoked generation.
    assert_eq!(snapshot(&f), before);
    assert_eq!(*f.os.values.lock().unwrap(), secrets);
    assert_eq!(previous.current().unwrap(), head);
    assert_eq!(
        previous.status(&json!({ "operationId": OP_A })).unwrap()["phase"],
        "prepared",
        "not recovered"
    );
    assert_eq!(
        previous.status(&json!({ "operationId": OP_B })).unwrap()["phase"],
        "unknown"
    );
    // gen-2 never claimed: gen-1 is not retired and completes its own job; the
    // denied CAS id was never journaled, so it is no receipt.
    assert_eq!(
        previous.commit(&json!({ "operationId": OP_A })).unwrap()["configRevision"],
        1
    );
    assert_eq!(
        cas_on(&previous, "cas-0000000000000002", 1, json!("tok-2")).unwrap()["revision"],
        2
    );

    // A new generation with its own live permit is served and fences the old claimant.
    let next = GenerationGate::new(3, 4);
    let job = BrokerJob {
        message: json!({ "type": "request", "id": "r-next", "method": "vault.compareAndSet", "params": cas("cas-0000000000000004", 2, "tok-4") }),
        permit: Arc::new(next.admit().unwrap()),
    };
    let response = job.respond("gen-3", |method, params, admission| {
        serve(f.authority("gen-3"), admission, method, params)
    });
    assert_eq!(
        (
            response["ok"].as_bool(),
            response["value"]["revision"].as_u64()
        ),
        (Some(true), Some(3)),
        "{response}"
    );
    drop(job);
    assert!(next.wait_drained_until(Instant::now()));
    assert!(previous
        .current()
        .unwrap_err()
        .starts_with("CONFIG_GENERATION_REVOKED"));
}

/// Mirrors keyring 3.6.3 windows.rs set_password: refuses
/// `encode_utf16().count() * 2 > CRED_MAX_CREDENTIAL_BLOB_SIZE (2560)`.
#[derive(Default)]
struct LimitOs {
    inner: MemoryOs,
    /// Some(n): the next n sets succeed, later ones fail (crash model).
    fail_after: Mutex<Option<usize>>,
}
impl SecretOs for LimitOs {
    fn get(&self, account: &str) -> Result<Option<String>, VaultError> {
        self.inner.get(account)
    }
    fn set(&self, account: &str, value: &str) -> Result<(), VaultError> {
        if value.encode_utf16().count() * 2 > 2560 {
            return Err(VaultError::Write);
        }
        if let Some(left) = self.fail_after.lock().unwrap().as_mut() {
            if *left == 0 {
                return Err(VaultError::Write);
            }
            *left -= 1;
        }
        self.inner.set(account, value)
    }
    fn delete(&self, account: &str) -> Result<(), VaultError> {
        self.inner.delete(account)
    }
}
impl LimitOs {
    fn keys_of(&self, account: &str) -> Vec<String> {
        let part = format!("{account}#");
        self.inner
            .values
            .lock()
            .unwrap()
            .keys()
            .filter(|k| *k == account || k.starts_with(&part))
            .cloned()
            .collect()
    }
    /// Every stored part has its manifest: no orphan of a removed value.
    fn assert_no_orphan_parts(&self) {
        let values = self.inner.values.lock().unwrap();
        for key in values.keys().filter(|k| k.contains('#')) {
            assert!(
                values.contains_key(key.split('#').next().unwrap()),
                "orphan part {key}"
            );
        }
    }
}

#[test]
fn windows_entry_limit_is_1280_utf16_units_and_larger_values_are_chunked_exactly() {
    let limited = Arc::new(LimitOs::default());
    let emoji = "\u{1F600}"; // one char, two UTF-16 units (a surrogate pair), four UTF-8 bytes
                             // The injectable limit: 1280 code units fit, 1281 do not, whatever the UTF-8 size.
    for (fits, refused) in [
        ("a".repeat(1280), "a".repeat(1281)),
        ("é".repeat(1280), "é".repeat(1281)),
        (emoji.repeat(640), format!("a{}", emoji.repeat(640))),
    ] {
        limited.set("probe", &fits).unwrap();
        assert_eq!(limited.set("probe", &refused), Err(VaultError::Write));
    }
    assert!(
        "a".repeat(2500).encode_utf16().count() > vault::WINDOWS_MAX_UNITS,
        "2500 ASCII chars do NOT fit"
    );
    let os = vault::ChunkedOs::new(limited.clone(), vault::WINDOWS_MAX_UNITS);
    let oauth = format!(
        "{{\"type\":\"oauth\",\"access\":\"{}\",\"refresh\":\"ü{emoji}\",\"expires\":1}}",
        "a".repeat(5000)
    );
    let cases = [
        "a".repeat(1280),
        "a".repeat(1281),
        "é".repeat(1280),
        "é".repeat(1281),
        emoji.repeat(640),
        format!("{}{emoji}", "a".repeat(1279)),
        oauth,
        emoji.repeat(MAX_SECRET / 4),
    ];
    for (i, value) in cases.iter().enumerate() {
        let account = format!("pi-ref:case{i}");
        os.set(&account, value).unwrap();
        assert_eq!(
            os.get(&account).unwrap().as_deref(),
            Some(value.as_str()),
            "case {i}"
        );
        let raw = limited.inner.get(&account).unwrap().unwrap();
        if value.encode_utf16().count() <= vault::WINDOWS_MAX_UNITS {
            assert_eq!(
                &raw, value,
                "case {i}: within the limit stays one raw entry"
            );
        } else {
            assert!(
                raw.starts_with("\u{1}enki-chunked-v1:") && raw.len() < 64,
                "case {i}: manifest only"
            );
            let parts = vault::split_units(value, vault::WINDOWS_MAX_UNITS);
            assert_eq!(parts.concat(), *value);
            for (n, part) in parts.iter().enumerate() {
                assert!(part.encode_utf16().count() <= vault::WINDOWS_MAX_UNITS);
                let stored = limited
                    .inner
                    .get(&vault::ChunkedOs::part_account(&account, n + 1))
                    .unwrap();
                assert_eq!(stored.as_deref(), Some(*part), "case {i} part {n}");
            }
        }
        os.delete(&account).unwrap();
        assert!(
            limited.keys_of(&account).is_empty(),
            "case {i}: delete removes manifest and every part"
        );
    }
    // A surrogate pair is never split across parts.
    let parts = vault::split_units(&cases[5], vault::WINDOWS_MAX_UNITS);
    assert_eq!((parts.len(), parts[1]), (2, emoji));
    // A raw value can never be misread as a manifest; oversize is refused.
    assert_eq!(
        os.set("pi-ref:x", "\u{1}enki-chunked-v1:2:9"),
        Err(VaultError::Write)
    );
    assert_eq!(
        os.set("pi-ref:x", &"a".repeat(MAX_SECRET + 1)),
        Err(VaultError::Write)
    );
    limited.assert_no_orphan_parts();
}

#[test]
fn chunked_crash_before_manifest_reads_absent_and_damaged_parts_fail_closed() {
    let limited = Arc::new(LimitOs::default());
    let os = vault::ChunkedOs::new(limited.clone(), vault::WINDOWS_MAX_UNITS);
    let value = "x".repeat(3000); // three parts
    *limited.fail_after.lock().unwrap() = Some(3); // all parts written, manifest lost
    assert_eq!(os.set("pi-ref:crash", &value), Err(VaultError::Write));
    *limited.fail_after.lock().unwrap() = None;
    assert_eq!(
        os.get("pi-ref:crash").unwrap(),
        None,
        "no manifest: absent, never a partial value"
    );
    os.delete("pi-ref:crash").unwrap();
    assert!(
        limited.keys_of("pi-ref:crash").is_empty(),
        "crash leftovers removed by owned delete"
    );
    os.set("pi-ref:missing", &value).unwrap();
    limited.inner.delete("pi-ref:missing#2").unwrap();
    assert_eq!(os.get("pi-ref:missing"), Err(VaultError::Read));
    os.set("pi-ref:short", &value).unwrap();
    limited.inner.set("pi-ref:short#3", "y").unwrap();
    assert_eq!(
        os.get("pi-ref:short"),
        Err(VaultError::Read),
        "exact length verified"
    );
}

#[test]
fn windows_sized_oauth_credentials_and_import_secrets_round_trip_through_the_authority() {
    let f = fixture("windows-limit");
    let limited = Arc::new(LimitOs::default());
    let os: Arc<dyn SecretOs> = Arc::new(vault::ChunkedOs::new(
        limited.clone(),
        vault::WINDOWS_MAX_UNITS,
    ));
    let a = Authority::new(f.root.clone(), os, "gen-1", None);
    let refresh = format!("{{\"type\":\"oauth\",\"access\":\"SENTINEL-{}\",\"refresh\":\"r-ü\u{1F600}\",\"expires\":1}}", "a".repeat(4000));
    assert_eq!(
        cas_on(&a, "cas-0000000000000001", 0, json!(refresh)).unwrap()["revision"],
        1
    );
    assert_eq!(
        a.credential_read(&json!({ "providerId": "prov" })).unwrap()["value"],
        refresh
    );
    let imported: &'static str = Box::leak(
        format!(
            "{{\"type\":\"oauth\",\"access\":\"SENTINEL-{}\",\"refresh\":\"r\",\"expires\":1}}",
            "é".repeat(3000)
        )
        .into_boxed_str(),
    );
    let mut p = plan();
    p.secrets[2].3 = imported;
    import(&a, OP_A, &p, 0).unwrap();
    assert_eq!(
        a.secret_read(&json!({ "configRevision": 1, "logicalId": logical("oauth") }))
            .unwrap()["value"],
        imported
    );
    assert_eq!(
        a.credential_read(&json!({ "providerId": "oauthfixture" }))
            .unwrap()["value"],
        imported
    );
    // Replacing the chunked CAS credential collects the old ref with all parts.
    assert_eq!(
        cas_on(&a, "cas-0000000000000002", 1, json!("small")).unwrap()["revision"],
        2
    );
    assert!(!limited
        .inner
        .values
        .lock()
        .unwrap()
        .values()
        .any(|v| v.contains("r-ü")));
    limited.assert_no_orphan_parts();
    assert_no_plaintext(&f, &[]);
}
