import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { OpenCodeArchiveReader } from "../../src/legacy/opencode-reader.ts";
import { buildContinuation, type ContinuationReader } from "../../src/legacy/continuation.ts";
import { projectArchiveMessages } from "../../src/legacy/wire-projection.ts";
import type { MessageDTO, ArchiveContinuationMetadata } from "../../src/legacy/protocol.ts";
const archive = "a".repeat(64);
function fixture(t: TestContext, name: "v1" | "v2") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enki-continuation-")), file = path.join(root, "archive.sqlite");
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: false });
  db.exec(fs.readFileSync(fileURLToPath(new URL(`./fixtures/legacy/${name}.sql`, import.meta.url)), "utf8")); db.close(); fs.chmodSync(file, 0o400);
  const original = fs.readFileSync(file), reader = new OpenCodeArchiveReader(file);
  t.after(() => { reader.close(); assert.deepEqual(fs.readFileSync(file), original); fs.rmSync(root, { recursive: true, force: true }); }); return reader;
}
const text = (id: string, role: "user" | "assistant", value: string): MessageDTO => ({ info: { id, sessionID: "s", role, time: { created: 10 } }, parts: [{ id: `${id}-part`, sessionID: "s", messageID: id, type: "text", text: value }] });
function source(messages: MessageDTO[], revert?: ArchiveContinuationMetadata["session"]["revert"]): ContinuationReader {
  return { continuationMetadata: () => ({ format: "v1", pendingInputs: 0, contextEpoch: null, session: { id: "s", directory: "/synthetic", title: "Synthetic", parentId: null, created: 1, updated: 2, archived: null, permission: null, revert } }),
    *messagePages() { for (let i = 0; i < messages.length; i += 17) yield messages.slice(i, i + 17); } };
}
test("V1 respects revert part cutoff, completed summary and retained tail without synthetic authority", async t => {
  const reader = fixture(t, "v1"), plan = await buildContinuation(reader, "ses_fixture_main", { archive });
  assert.equal(plan.cutover.revertMessage, "msg_fixture_060"); assert.equal(plan.cutover.revertPart, "prt_fixture_060_pending"); assert.equal(plan.cutover.compactionMessage, "msg_fixture_040");
  const body = plan.contextNote + JSON.stringify(plan.messages); assert.ok(body.includes("SUMMARY_MARKER")); assert.ok(body.includes("Сохрани Unicode")); assert.ok(body.includes("KEPT_TAIL_MARKER"));
  assert.ok(!body.includes("NEVER_REPLAY_PENDING_TOOL")); assert.ok(!body.includes("IGNORED_SYNTHETIC_MARKER"));
  const calls = plan.messages.flatMap(message => message.role === "assistant" ? message.content.filter(block => block.type === "toolCall").map(block => block.id) : []);
  const results = plan.messages.flatMap(message => message.role === "toolResult" ? [message.toolCallId] : []);
  assert.deepEqual(calls, results); assert.equal(calls.length, 2); assert.equal(plan.messages.length, plan.refs.length);
});
test("V2 starts from durable checkpoint, keeps later chronological chat, and never promotes inbox or epoch authority", async t => {
  const reader = fixture(t, "v2"), plan = await buildContinuation(reader, "ses_fixture_v2", { archive }), body = plan.contextNote + JSON.stringify(plan.messages);
  for (const marker of ["V2_SUMMARY_MARKER", "V2_RECENT_MARKER", "V2_KEPT_TAIL_MARKER", "V2_LATEST_MARKER"]) assert.ok(body.includes(marker), marker);
  for (const marker of ["V2_USER_MARKER", "NEVER_REPLAY_SHELL_FIXTURE", "NEVER_REPLAY_PENDING_INPUT", "SYNTHETIC_LEGACY_BASELINE"]) assert.ok(!body.includes(marker), marker);
  assert.equal(plan.pendingInputs, 1); assert.equal(plan.cutover.compactionMessage, "msg_fixture_v2_700"); assert.ok(plan.cutover.baselineSha256);
});
test("wire IDs are deterministic, isolated per runtime session and preserve unmodified raw provenance", t => {
  const reader = fixture(t, "v1"), raw = reader.messages("ses_fixture_main"), original = JSON.stringify(raw), one = projectArchiveMessages(raw, "legacy-one"), other = projectArchiveMessages(raw, "legacy-two");
  assert.deepEqual(one, projectArchiveMessages(raw, "legacy-one")); assert.notEqual(one[0].info.id, other[0].info.id); assert.match(one[0].info.id, /^msg_legacy_[a-f0-9]{48}$/);
  assert.equal(one[0].info.sessionID, "legacy-one"); assert.equal(one[0].parts[0].sessionID, "legacy-one"); assert.equal(one[0].parts[0].messageID, one[0].info.id);
  assert.equal(one[0].info.legacy?.sourceId, raw[0].info.id); assert.equal(JSON.stringify(raw), original);
});
test("bounded context retains recent tail, reports omissions and does not split multibyte text", async () => {
  const messages = Array.from({ length: 500 }, (_, i) => text(`m${i}`, i % 2 ? "assistant" : "user", `${i === 499 ? "LATEST_TAIL" : "OLD"}:${"ёж".repeat(300)}`)), before = JSON.stringify(messages);
  const plan = await buildContinuation(source(messages), "s", { archive, maxBytes: 8192, maxMessages: 8 });
  assert.ok(Buffer.byteLength(JSON.stringify(plan.messages)) <= 8192); assert.ok(plan.messages.length <= 8); assert.ok(plan.omittedGroups > 480);
  assert.ok(JSON.stringify(plan.messages).includes("LATEST_TAIL")); assert.ok(!JSON.stringify(plan.messages).includes("�")); assert.equal(JSON.stringify(messages), before);
});
test("unfinished calls have paired terminal unknown results and never executable pending work", async () => {
  const message: MessageDTO = { ...text("m1", "assistant", ""), parts: [{ id: "p1", messageID: "m1", sessionID: "s", type: "tool", tool: "bash", callID: "old-call", state: { status: "running", input: { command: "NEVER_RUN" } } }] };
  const plan = await buildContinuation(source([message]), "s", { archive }), result = plan.messages.find(message => message.role === "toolResult");
  if (result?.role !== "toolResult") throw new Error("Missing result"); assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), /результат неизвестен/); assert.equal(plan.refs.at(-1)?.part, "p1");
});
test("historical external URLs remain archive references without any resolver or network", async () => {
  const message = text("m", "user", "attachment"); message.parts.push({ id: "file", sessionID: "s", messageID: "m", type: "file", filename: "ref.png", mime: "image/png", url: "https://must-never-fetch.invalid/secret" });
  const plan = await buildContinuation(source([message]), "s", { archive, includeImages: true });
  assert.ok(JSON.stringify(plan.messages).includes("ref.png")); assert.ok(!JSON.stringify(plan.messages).includes("must-never-fetch")); assert.equal(plan.omittedParts, 1);
});
test("invalid revert and summary linkage fail rather than returning a successful seed", async () => {
  const message = text("m", "user", "before");
  await assert.rejects(buildContinuation(source([message], { messageID: "missing" }), "s", { archive }), /Сообщение отката/);
  await assert.rejects(buildContinuation(source([message], { custom: "unknown" }), "s", { archive }), /Формат границы/);
  await assert.rejects(buildContinuation(source([message], { messageID: "m", partID: "missing" }), "s", { archive }), /Часть отката/);
  const summary = text("summary", "assistant", "summary"); summary.info.summary = true; summary.info.finish = "stop"; summary.info.parentID = "missing";
  await assert.rejects(buildContinuation(source([summary]), "s", { archive }), /Родитель сводки/);
});
test("abort and bad caller budgets fail before returning a usable continuation", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(buildContinuation(source([text("m", "user", "text")]), "s", { archive, signal: controller.signal }), /отменён/);
  await assert.rejects(buildContinuation(source([]), "s", { archive, maxBytes: 1 }), /лимит/);
});
test("oversized tool batch becomes an explicit archive note without orphan tool results", async () => {
  const message = text("big", "assistant", ""); message.parts = [{ id: "large", sessionID: "s", messageID: "big", type: "tool", tool: "plugin", callID: "c", state: { status: "completed", input: { input: "x".repeat(25000) }, output: "done" } }];
  const plan = await buildContinuation(source([message]), "s", { archive, maxBytes: 4096 });
  assert.ok(plan.contextNote.includes("группы: 1")); assert.equal(plan.messages.filter(message => message.role === "toolResult").length, 0); assert.equal(plan.omittedGroups, 1);
});
