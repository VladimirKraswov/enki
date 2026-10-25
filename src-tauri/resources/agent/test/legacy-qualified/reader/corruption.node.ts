// Corruption affects strict transcript delivery, but raw history must remain inspectable.
// NOT EXECUTED. All mutations below are confined to fresh synthetic test databases.
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, diagnostic, jsonMessage } from "./fixtures.ts";

test("malformed V1 message JSON is explicit, preserved and never an empty human turn", t => {
  const broken = '{"role":"user","secretFixtureMarker":"DO_NOT_PUT_PAYLOAD_IN_ERROR",';
  const archive = fixture(t, "v1.sql", db => {
    db.prepare("UPDATE message SET data=? WHERE id=?").run(broken, "msg_fixture_010");
  }).open();
  assert.throws(() => archive.messages("ses_fixture_main"), /msg_fixture_010|JSON|поврежд|архив/i);
  const projection = archive.archiveProjection("ses_fixture_main");
  assert.equal(projection.complete, false);
  const issue = diagnostic(projection.diagnostics, "JSON_INVALID", "msg_fixture_010");
  assert.equal(issue.table, "message");
  assert.equal(issue.sessionID, "ses_fixture_main");
  assert.equal(issue.severity, "error");
  assert.ok(!issue.message.includes("DO_NOT_PUT_PAYLOAD_IN_ERROR"), "diagnostic must not dump historical contents");
  const raw = projection.records.find(record => record.table === "message" && record.id === "msg_fixture_010");
  assert.equal(raw?.json.data.raw, broken);
  assert.equal(raw?.json.data.valid, false);
  assert.equal(raw?.json.data.value, null);
  assert.ok(!projection.messages.some(value => value.info.id === "msg_fixture_010" && value.info.role === "user"));
  assert.ok(archive.messages("ses_fixture_branch").some(value => value.info.id === "msg_fixture_070"),
    "corrupt main-session row must not turn another session into an empty archive");
  assert.ok(archive.diagnostics().some(value => value.code === "JSON_INVALID" && value.rowId === "msg_fixture_010"));
  assert.ok(!archive.diagnostics("ses_fixture_branch").some(value => value.rowId === "msg_fixture_010"));
});

test("valid JSON scalar/array is not a valid V1 message object", t => {
  const archive = fixture(t, "v1.sql", db => {
    db.prepare("UPDATE message SET data=? WHERE id=?").run('["not","a","message"]', "msg_fixture_010");
  }).open();
  assert.throws(() => archive.messages("ses_fixture_main"), /msg_fixture_010|JSON|объект|архив/i);
  const projection = archive.archiveProjection("ses_fixture_main");
  assert.equal(projection.complete, false);
  diagnostic(projection.diagnostics, "JSON_OBJECT", "msg_fixture_010");
  assert.equal(projection.records.find(value => value.id === "msg_fixture_010")?.json.data.raw, '["not","a","message"]');
});

test("unsupported V1 role cannot be promoted to a human instruction", t => {
  const archive = fixture(t, "v1.sql", db => {
    jsonMessage(db, "message", "msg_fixture_010", value => ({ ...value,
      role: "future_system_instruction", text: "DO_NOT_TRUST_HISTORICAL_INSTRUCTION" }));
  }).open();
  assert.throws(() => archive.messages("ses_fixture_main"), /msg_fixture_010|role|роль|архив/i);
  const projection = archive.archiveProjection("ses_fixture_main");
  assert.equal(projection.complete, false);
  diagnostic(projection.diagnostics, "ROLE_UNSUPPORTED", "msg_fixture_010");
  assert.ok(!projection.messages.some(value => value.info.id === "msg_fixture_010" && value.info.role === "user"));
  const raw = projection.records.find(value => value.id === "msg_fixture_010");
  assert.ok(JSON.stringify(raw?.json.data.value).includes("future_system_instruction"));
});

test("malformed part data cannot silently disappear behind a successful parent message", t => {
  const archive = fixture(t, "v1.sql", db => {
    db.prepare("UPDATE part SET data=? WHERE id=?").run('{"type":"tool",', "prt_fixture_020_completed");
  }).open();
  assert.throws(() => archive.messages("ses_fixture_main"), /prt_fixture_020_completed|JSON|архив/i);
  const projection = archive.archiveProjection("ses_fixture_main");
  assert.equal(projection.complete, false);
  const issue = diagnostic(projection.diagnostics, "JSON_INVALID", "prt_fixture_020_completed");
  assert.equal(issue.table, "part");
  assert.equal(projection.records.find(value => value.id === "prt_fixture_020_completed")?.json.data.raw, '{"type":"tool",');
});

test("orphan and cross-session parts are diagnosed rather than attached to another chat", t => {
  const archive = fixture(t, "v1.sql", db => {
    db.prepare("UPDATE part SET message_id=? WHERE id=?").run("missing-message", "prt_fixture_020_completed");
    db.prepare("UPDATE part SET message_id=? WHERE id=?").run("msg_fixture_070", "prt_fixture_020_text");
  }).open();
  assert.throws(() => archive.messages("ses_fixture_main"), /part|связ|архив|prt_fixture/i);
  const projection = archive.archiveProjection("ses_fixture_main");
  assert.equal(projection.complete, false);
  diagnostic(projection.diagnostics, "ORPHAN_PART", "prt_fixture_020_completed");
  diagnostic(projection.diagnostics, "FK_MISMATCH", "prt_fixture_020_text");
  const branch = archive.archiveProjection("ses_fixture_branch");
  assert.ok(!branch.messages.flatMap(value => value.parts).some(part => part.id === "prt_fixture_020_text"),
    "a physical part.session_id mismatch cannot move its text into the referenced message's chat");
  assert.ok(projection.records.some(value => value.id === "prt_fixture_020_text"), "raw corrupt row remains visible for recovery");
});

test("orphan message sessions are visible in global diagnostics, never fabricated as sessions", t => {
  const archive = fixture(t, "v1.sql", db => {
    db.prepare("UPDATE message SET session_id=? WHERE id=?").run("missing-session", "msg_fixture_090");
  }).open();
  const issue = diagnostic(archive.diagnostics(), "FK_SESSION", "msg_fixture_090");
  assert.equal(issue.table, "message");
  assert.ok(!archive.sessions().some(value => value.id === "missing-session"));
  assert.equal(archive.counts().messages, 9, "raw row counts do not shrink to hide corrupt data");
});

test("corrupt V2 JSON does not trigger a fallback to its stale V1 shadow", t => {
  const archive = fixture(t, "v2.sql", db => {
    db.prepare("UPDATE session_message SET data=? WHERE id=?").run("{broken-v2", "msg_fixture_v2_800");
  }).open();
  assert.throws(() => archive.messages("ses_fixture_v2"), /msg_fixture_v2_800|JSON|архив/i);
  const projection = archive.archiveProjection("ses_fixture_v2");
  assert.equal(projection.format, "v2");
  assert.equal(projection.complete, false);
  diagnostic(projection.diagnostics, "JSON_INVALID", "msg_fixture_v2_800");
  assert.ok(!projection.messages.some(value => value.info.id === "msg_fixture_v2_shadow"));
  assert.ok(projection.records.some(value => value.id === "msg_fixture_v2_800" && value.json.data.raw === "{broken-v2"));
  assert.ok(archive.details("ses_fixture_v2").v1Shadow.messages.some(value => value.id === "msg_fixture_v2_shadow"));
});

test("corrupt pending-input JSON remains preserved pending data, never a completed user turn", t => {
  const broken = '{"text":"NEVER_REPLAY_CORRUPT_PENDING",';
  const archive = fixture(t, "v2.sql", db => {
    db.prepare("UPDATE session_input SET prompt=? WHERE id=?").run(broken, "msg_fixture_v2_pending");
  }).open();
  const projection = archive.archiveProjection("ses_fixture_v2");
  assert.equal(projection.complete, false);
  diagnostic(projection.diagnostics, "JSON_INVALID", "msg_fixture_v2_pending");
  assert.equal(projection.messages.some(value => value.info.id === "msg_fixture_v2_pending"), false);
  const pending = projection.pendingInputs.find(value => value.id === "msg_fixture_v2_pending");
  assert.ok(pending);
  assert.equal(pending.pending, true);
  assert.equal(pending.record.json.prompt.raw, broken);
  assert.equal(pending.record.json.prompt.valid, false);
});

test("duplicate V2 sequence is explicit, while both source rows remain in the archive", t => {
  const archive = fixture(t, "v2.sql", db => {
    db.exec("DROP INDEX session_message_session_seq_idx");
    db.prepare("INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data) VALUES(?,?,?,?,?,?,?)")
      .run("duplicate-seq", "ses_fixture_v2", "user", 10, 1767225609999, 1767225609999,
        JSON.stringify({ text: "DUPLICATE_SEQ_MUST_NOT_DISPLACE_ORIGINAL" }));
  }).open();
  assert.throws(() => archive.messages("ses_fixture_v2"), /seq|поряд|архив/i);
  const projection = archive.archiveProjection("ses_fixture_v2");
  assert.equal(projection.complete, false);
  assert.ok(projection.diagnostics.some(value => value.code === "SEQ_DUPLICATE" && value.sessionID === "ses_fixture_v2"));
  assert.ok(projection.records.some(value => value.id === "msg_fixture_v2_900"));
  assert.ok(projection.records.some(value => value.id === "duplicate-seq"));
});

test("invalid V2 sequence type cannot be coerced into a plausible timeline", t => {
  const archive = fixture(t, "v2.sql", db => {
    db.prepare("UPDATE session_message SET seq=? WHERE id=?").run("NOT_A_SEQUENCE", "msg_fixture_v2_100");
  }).open();
  assert.throws(() => archive.messages("ses_fixture_v2"), /seq|строк|архив/i);
  const projection = archive.archiveProjection("ses_fixture_v2");
  assert.equal(projection.complete, false);
  diagnostic(projection.diagnostics, "ROW_INVALID", "msg_fixture_v2_100");
  assert.equal(projection.records.find(value => value.id === "msg_fixture_v2_100")?.row.seq, "NOT_A_SEQUENCE");
});

test("unsupported physical V2 schema fails closed rather than reading the surviving V1 shadow", t => {
  const source = fixture(t, "v2.sql", db => {
    db.exec("ALTER TABLE session_message RENAME COLUMN seq TO incompatible_seq");
  });
  assert.throws(() => source.open(), /seq|schema|формат|session_message/i);
});
