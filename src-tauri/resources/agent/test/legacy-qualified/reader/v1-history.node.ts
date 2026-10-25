// Independent behavioral acceptance tests. NOT EXECUTED.
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, jsonMessage, message } from "./fixtures.ts";

test("V1 restores every physical message and part identity in SQL creation order", t => {
  const archive = fixture(t, "v1.sql").open();
  const counts = archive.counts();
  assert.equal(counts.sessions, 3);
  assert.equal(counts.messages, 9);
  assert.equal(counts.parts, 17, "nested attachments are not extra physical part rows");
  const transcript = archive.messages("ses_fixture_main");
  assert.deepEqual(transcript.map(value => value.info.id), [
    "msg_fixture_010", "msg_fixture_020", "msg_fixture_030",
    "msg_fixture_040", "msg_fixture_050", "msg_fixture_060",
  ]);
  assert.deepEqual(message(transcript, "msg_fixture_010").parts.map(part => part.id), [
    "prt_fixture_010_file", "prt_fixture_010_ignored", "prt_fixture_010_text",
  ]);
  for (const entry of transcript) {
    assert.equal(entry.info.sessionID, "ses_fixture_main");
    for (const part of entry.parts) {
      assert.equal(part.messageID, entry.info.id);
      assert.equal(part.sessionID, entry.info.sessionID);
    }
  }
  const projection = archive.archiveProjection("ses_fixture_main");
  assert.equal(projection.format, "v1");
  assert.equal(projection.complete, true);
  assert.deepEqual(projection.messages, transcript);
  assert.deepEqual(projection.pendingInputs, []);
});

test("JSON identity spoofing cannot relocate SQL messages or parts", t => {
  const archive = fixture(t, "v1.sql", db => {
    jsonMessage(db, "message", "msg_fixture_020", body => ({ ...body,
      id: "forged-message", sessionID: "ses_fixture_windows", fixtureExtension: { keep: true } }));
    db.prepare("UPDATE part SET data=? WHERE id=?").run(JSON.stringify({
      type: "text", id: "forged-part", sessionID: "ses_fixture_windows", messageID: "msg_fixture_090",
      text: "SQL identity wins", fixtureExtension: { keep: "part" },
    }), "prt_fixture_020_text");
  }).open();
  const entry = message(archive.messages("ses_fixture_main"), "msg_fixture_020");
  assert.equal(entry.info.id, "msg_fixture_020");
  assert.equal(entry.info.sessionID, "ses_fixture_main");
  assert.equal(entry.info.legacy?.sourceId, "msg_fixture_020");
  assert.equal(entry.info.legacy?.raw.id, "forged-message", "raw provenance is not discarded");
  const part = entry.parts.find(value => value.id === "prt_fixture_020_text");
  assert.ok(part);
  assert.equal(part.messageID, "msg_fixture_020");
  assert.equal(part.sessionID, "ses_fixture_main");
  assert.deepEqual(part.fixtureExtension, { keep: "part" });
  assert.ok(!archive.messages("ses_fixture_windows").some(value => value.info.id === "forged-message"));
});

test("SQL order stays deterministic when JSON timestamps and insertion order disagree", t => {
  const archive = fixture(t, "v1.sql", db => {
    jsonMessage(db, "message", "msg_fixture_010", body => ({ ...body, time: { created: 9999999999999 } }));
    jsonMessage(db, "message", "msg_fixture_020", body => ({ ...body, time: { created: 1, completed: 2 } }));
    db.prepare("UPDATE message SET time_created=? WHERE id=?").run(1767225600999, "msg_fixture_030");
  }).open();
  assert.deepEqual(archive.messages("ses_fixture_main").map(value => value.info.id), [
    "msg_fixture_030", "msg_fixture_010", "msg_fixture_020",
    "msg_fixture_040", "msg_fixture_050", "msg_fixture_060",
  ]);
});

test("V1 completed/error/pending tools, nested attachment and accounting remain recorded data", t => {
  const archive = fixture(t, "v1.sql").open();
  const transcript = archive.messages("ses_fixture_main");
  const assistant = message(transcript, "msg_fixture_020");
  const completed = assistant.parts.find(part => part.id === "prt_fixture_020_completed");
  assert.equal(completed?.callID, "call_fixture_completed");
  assert.equal(completed?.tool, "fixture_read");
  assert.equal(completed?.state?.status, "completed");
  assert.deepEqual(completed?.state?.input, { path: "/enki-fixtures/local/fixture-only.txt" });
  assert.equal(completed?.state?.output, "fixture-only\n");
  assert.deepEqual(completed?.state?.attachments, [{
    id: "prt_fixture_tool_attachment", messageID: "msg_fixture_020", sessionID: "ses_fixture_main",
    type: "file", mime: "text/plain", filename: "tool-result.txt",
    url: "data:text/plain;base64,Zml4dHVyZS1vbmx5Cg==",
  }]);
  const failed = assistant.parts.find(part => part.id === "prt_fixture_020_error");
  assert.equal(failed?.state?.status, "error");
  assert.equal(failed?.state?.error, "SYNTHETIC_TOOL_FAILURE");
  const pending = message(transcript, "msg_fixture_060").parts.find(part => part.type === "tool");
  assert.equal(pending?.state?.status, "pending");
  assert.equal(pending?.state?.output, undefined, "never invent a completed result for a pending call");
  assert.equal(assistant.info.cost, 0.125);
  assert.deepEqual(assistant.info.tokens, {
    total: 19, input: 10, output: 7, reasoning: 2, cache: { read: 1, write: 1 },
  });
  assert.equal(message(transcript, "msg_fixture_040").info.summary, true);
  assert.equal(archive.archiveProjection("ses_fixture_main").messages.length, 6);
});

test("session details preserve branch, model, agent, revert, project and raw ignored text", t => {
  const permission = [{ permission: "bash", pattern: "*", action: "ask" }];
  const archive = fixture(t, "v1.sql", db => {
    db.prepare("UPDATE session SET permission=? WHERE id=?").run(JSON.stringify(permission), "ses_fixture_main");
  }).open();
  const details = archive.details("ses_fixture_main");
  assert.equal(details.session.agent, "fixture-agent");
  assert.deepEqual(details.session.model, { id: "fixture-model", providerID: "fixture-provider", variant: "medium" });
  assert.deepEqual(details.session.permission, permission, "historical permission is data, not a newly granted capability");
  assert.deepEqual(details.session.metadata, { fixture: true, originHost: "fixture-mac" });
  assert.deepEqual(details.session.revert, {
    messageID: "msg_fixture_060", partID: "prt_fixture_060_pending", snapshot: "synthetic-snapshot-only",
  });
  assert.equal(details.project?.row.id, "fixture-local");
  assert.deepEqual(details.project?.json.commands.value, { start: "NEVER_RUN_PROJECT_COMMAND" });
  assert.ok(details.related.todo?.some(record => record.row.content === "SYNTHETIC_TODO_DO_NOT_EXECUTE"));
  const branch = archive.details("ses_fixture_branch").session;
  assert.equal(branch.parentId, "ses_fixture_main");
  assert.equal(branch.archived, 1767225609000);
  const user = message(archive.messages("ses_fixture_main"), "msg_fixture_010");
  const ignored = user.parts.find(part => part.id === "prt_fixture_010_ignored");
  assert.equal(ignored?.synthetic, true);
  assert.equal(ignored?.ignored, true);
  assert.equal(ignored?.text, "IGNORED_SYNTHETIC_MARKER");
  assert.equal(archive.messages("ses_fixture_main").filter(value => value.info.id === user.info.id).length, 1);
});

test("foreign Windows directories and file URIs remain opaque and projectless sessions survive", t => {
  const rawPath = String.raw`C:\Synthetic\Enki\demo`;
  const archive = fixture(t, "v1.sql", db => {
    db.prepare("UPDATE session SET directory=? WHERE id=?").run(rawPath, "ses_fixture_windows");
    db.prepare("UPDATE session SET directory='' WHERE id=?").run("ses_fixture_main");
  }).open();
  assert.equal(archive.sessions().find(value => value.id === "ses_fixture_windows")?.directory, rawPath);
  assert.equal(archive.details("ses_fixture_windows").record.row.directory, rawPath);
  const foreign = message(archive.messages("ses_fixture_windows"), "msg_fixture_090");
  assert.equal(foreign.parts.find(part => part.type === "file")?.url, "file:///C:/Synthetic/Enki/foreign-only.txt");
  assert.ok(archive.sessions().some(value => value.id === "ses_fixture_main" && value.directory === ""));
  assert.equal(archive.messages("ses_fixture_main").length, 6);
});
