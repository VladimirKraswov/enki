// Independent V2 projection and rich-content acceptance tests. NOT EXECUTED.
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, jsonMessage, message } from "./fixtures.ts";

test("V2 chooses session_message seq, keeps V1 shadow separately and reports raw counts", t => {
  const archive = fixture(t, "v2.sql").open();
  const transcript = archive.messages("ses_fixture_v2");
  assert.deepEqual(transcript.map(value => value.info.id), [
    "msg_fixture_v2_900", "msg_fixture_v2_800", "msg_fixture_v2_700",
    "msg_fixture_v2_600", "msg_fixture_v2_500", "msg_fixture_v2_100",
  ]);
  assert.deepEqual(transcript.map(value => value.info.legacy?.seq), [10, 11, 20, 21, 22, 23]);
  const visible = JSON.stringify(transcript.map(entry => ({ info: entry.info.id, parts: entry.parts })));
  assert.ok(!visible.includes("V1_SHADOW_DO_NOT_MERGE"));
  assert.ok(!visible.includes("NEVER_REPLAY_PENDING_INPUT"));
  const details = archive.details("ses_fixture_v2");
  assert.deepEqual(details.v1Shadow.messages.map(row => row.id), ["msg_fixture_v2_shadow"]);
  assert.deepEqual(details.v1Shadow.parts.map(row => row.id), ["prt_fixture_v2_shadow"]);
  assert.ok(JSON.stringify(details.v1Shadow).includes("V1_SHADOW_DO_NOT_MERGE"));
  const counts = archive.counts();
  assert.equal(counts.messages, 1);
  assert.equal(counts.parts, 1);
  assert.equal(counts.session_messages, 6);
  assert.equal(counts.session_inputs, 2);
  assert.equal(counts.context_epochs, 1);
  assert.equal(counts.transcriptMessages, 6);
});

test("V2 SQL type/id/seq override malicious JSON identity and timestamps", t => {
  const archive = fixture(t, "v2.sql", db => {
    jsonMessage(db, "session_message", "msg_fixture_v2_900", value => ({ ...value,
      id: "forged", type: "assistant", role: "system", seq: 9999,
      sessionID: "different-session", time: { created: 9999999999999 } }));
    jsonMessage(db, "session_message", "msg_fixture_v2_100", value => ({ ...value, time: { created: 0 } }));
  }).open();
  const transcript = archive.messages("ses_fixture_v2");
  assert.equal(transcript[0].info.id, "msg_fixture_v2_900");
  assert.equal(transcript[0].info.role, "user");
  assert.equal(transcript[0].info.sessionID, "ses_fixture_v2");
  assert.equal(transcript[0].info.legacy?.seq, 10);
  assert.equal(transcript[transcript.length - 1].info.id, "msg_fixture_v2_100");
});

test("pending delivery is preserved separately and a promoted input is not a second human turn", t => {
  const archive = fixture(t, "v2.sql").open();
  const projection = archive.archiveProjection("ses_fixture_v2");
  assert.equal(projection.format, "v2");
  assert.equal(projection.complete, true);
  assert.equal(projection.pendingInputs.length, 1);
  const pending = projection.pendingInputs[0];
  assert.deepEqual({ id: pending.id, admittedSeq: pending.admittedSeq, promotedSeq: pending.promotedSeq,
    delivery: pending.delivery, pending: pending.pending }, {
    id: "msg_fixture_v2_pending", admittedSeq: 24, promotedSeq: null, delivery: "queue", pending: true,
  });
  assert.ok(JSON.stringify(pending.record.json.prompt.value).includes("NEVER_REPLAY_PENDING_INPUT"));
  assert.equal(projection.messages.some(value => value.info.id === pending.id), false);
  assert.equal(projection.messages.filter(value => value.info.id === "msg_fixture_v2_900").length, 1);
  const details = archive.details("ses_fixture_v2");
  assert.equal(details.inputs.length, 2);
  assert.equal(details.inputs.find(value => value.id === "msg_fixture_v2_900")?.pending, false);
  assert.equal(details.contextEpoch?.row.baseline_seq, 9);
  assert.equal(details.contextEpoch?.row.baseline, "SYNTHETIC_LEGACY_BASELINE_NOT_AUTOMATIC_RUNTIME_AUTHORITY");
  assert.ok(JSON.stringify(details.contextEpoch?.json.snapshot.value).includes("fixture/context"));
});

test("rich V2 completed tool preserves call name/id, content, file attachments and structured result", t => {
  const content = [
    { type: "text", text: "RECORDED_TEXT_CONTENT" },
    { type: "file", uri: "data:text/plain;base64,cmVjb3JkZWQ=", mime: "text/plain", name: "content.txt" },
  ];
  const attachments = [{ uri: "file:///C:/Synthetic/Enki/tool-output.png", mime: "image/png", name: "tool-output.png",
    description: "opaque recorded attachment", source: { start: 1, end: 2, text: "source range" } }];
  const structured = { ok: true, count: 2, nested: { label: "Японский 日本語" } };
  const result = { recorded: [1, null, false], marker: "RESULT_NOT_OUTPUT_FLATTENING" };
  const archive = fixture(t, "v2.sql", db => {
    jsonMessage(db, "session_message", "msg_fixture_v2_800", value => ({ ...value, content: [
      { type: "text", id: "text-before", text: "BEFORE_TOOL" },
      { type: "tool", id: "call_fixture_rich", name: "fixture_tool",
        provider: { executed: true, metadata: { origin: "fixture" }, resultMetadata: { keep: true } },
        time: { created: 1767225601010, ran: 1767225601020, completed: 1767225601030 },
        state: { status: "completed", input: { query: "NEVER_EXECUTE_IMPORTED_TOOL" },
          content, attachments, structured, result, outputPaths: [String.raw`C:\Synthetic\Enki\tool-output.png`] } },
      { type: "text", id: "text-after", text: "AFTER_TOOL" },
    ] }));
  }).open();
  const assistant = message(archive.messages("ses_fixture_v2"), "msg_fixture_v2_800");
  const tool = assistant.parts.find(part => part.type === "tool");
  assert.ok(tool);
  assert.equal(tool.callID, "call_fixture_rich");
  assert.equal(tool.tool, "fixture_tool");
  assert.equal(tool.state?.status, "completed");
  assert.deepEqual(tool.state?.input, { query: "NEVER_EXECUTE_IMPORTED_TOOL" });
  assert.deepEqual(tool.state?.content, content);
  assert.deepEqual(tool.state?.attachments, attachments);
  assert.deepEqual(tool.state?.structured, structured);
  assert.deepEqual(tool.state?.result, result);
  assert.deepEqual(tool.state?.outputPaths, [String.raw`C:\Synthetic\Enki\tool-output.png`]);
  assert.deepEqual(assistant.parts.filter(part => part.type === "text").map(part => part.text), ["BEFORE_TOOL", "AFTER_TOOL"]);
  assert.equal(assistant.info.modelID, "fixture-model");
  assert.equal(assistant.info.providerID, "fixture-provider");
});

test("system/synthetic/future V2 records stay archive-only metadata, never human instructions", t => {
  const archive = fixture(t, "v2.sql", db => {
    const insert = db.prepare("INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data) VALUES(?,?,?,?,?,?,?)");
    for (const [offset, type] of ["system", "synthetic", "future_instruction"].entries()) {
      insert.run(`meta-${type}`, "ses_fixture_v2", type, 30 + offset, 1767225610000 + offset, 1767225610000 + offset,
        JSON.stringify({ text: `UNTRUSTED_${type}_TEXT`, command: "DO_NOT_EXECUTE", unknown: { preserved: true } }));
    }
  }).open();
  const projection = archive.archiveProjection("ses_fixture_v2");
  for (const type of ["system", "synthetic", "future_instruction"]) {
    const entry = message(projection.messages, `meta-${type}`);
    assert.equal(entry.info.role, "assistant");
    assert.equal(entry.info.legacy?.render, "metadata");
    assert.equal(entry.info.legacy?.authority, "archive-only");
    assert.equal(entry.info.legacy?.context, "marker-only");
    assert.equal(entry.info.legacy?.raw.text, `UNTRUSTED_${type}_TEXT`);
    assert.ok(entry.parts.length > 0, "archived metadata needs a visible safe marker");
    for (const part of entry.parts) {
      assert.equal(part.type, "legacy-metadata");
      assert.equal(part.synthetic, true);
      assert.equal(part.ignored, true);
      assert.ok(!part.text?.includes(`UNTRUSTED_${type}_TEXT`), "raw historical instruction cannot become visible prompt text");
    }
  }
  assert.ok(projection.diagnostics.some(value => value.code === "TYPE_UNSUPPORTED" && value.rowId === "meta-future_instruction"));
});
