// Read-only archive regression fixtures.
// The fixtures are synthetic; no owner database, model or tool is needed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { OpenCodeArchiveReader } from "../../src/legacy/opencode-reader.ts";

const fixtures = fileURLToPath(new URL("./fixtures/legacy/", import.meta.url));
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const ownedReaders = new Map<string, Set<OpenCodeArchiveReader>>();

function source(t: TestContext, fixture: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enki-legacy-reader-"));
  const file = path.join(dir, "synthetic.sqlite");
  const opened = new Set<OpenCodeArchiveReader>(); ownedReaders.set(file, opened);
  t.after(() => {
    for (const instance of opened) instance.close();
    ownedReaders.delete(file);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const db = new DatabaseSync(file);
  try { db.exec(fs.readFileSync(path.join(fixtures, fixture), "utf8")); }
  finally { db.close(); }
  return file;
}

function reader(_t: TestContext, file: string): OpenCodeArchiveReader {
  assert.ok(ownedReaders.has(file), "reader must belong to an owned fixture");
  const instance = new OpenCodeArchiveReader(file);
  ownedReaders.get(file)!.add(instance);
  return instance;
}

test("V1 restores SQL ids, stable transcript order, metadata and every tool state", (t) => {
  const file = source(t, "v1.sql");
  const before = hash(file);
  const archive = reader(t, file);
  const sessions = archive.sessions();
  assert.equal(sessions.length, 3);
  const branch = sessions.find((s) => s.id === "ses_fixture_branch");
  assert.equal(branch?.parentId, "ses_fixture_main");
  assert.equal(branch?.archived, 1767225609000);
  const messages = archive.messages("ses_fixture_main");
  assert.deepEqual(messages.map((m) => m.info.id), [
    "msg_fixture_010", "msg_fixture_020", "msg_fixture_030",
    "msg_fixture_040", "msg_fixture_050", "msg_fixture_060",
  ]);
  for (const message of messages) {
    assert.equal(message.info.sessionID, "ses_fixture_main");
    for (const part of message.parts) {
      assert.equal(part.sessionID, message.info.sessionID);
      assert.equal(part.messageID, message.info.id);
      assert.ok(part.id);
    }
  }
  const parts = messages.flatMap((m) => m.parts);
  assert.equal(parts.find((p) => p.id === "prt_fixture_020_completed")?.state?.status, "completed");
  assert.equal(parts.find((p) => p.id === "prt_fixture_020_error")?.state?.status, "error");
  assert.equal(parts.find((p) => p.id === "prt_fixture_060_pending")?.state?.status, "pending");
  const completed = parts.find((p) => p.id === "prt_fixture_020_completed");
  assert.equal(completed?.callID, "call_fixture_completed");
  assert.equal(completed?.state?.output, "fixture-only\n");
  assert.equal(messages.find((m) => m.info.id === "msg_fixture_040")?.info.summary, true);
  assert.equal(messages.find((m) => m.info.id === "msg_fixture_020")?.info.cost, 0.125);
  assert.equal(hash(file), before, "opening/reading an archive cannot modify it");
});

test("V2 uses seq projection, never the legacy V1 shadow or pending delivery", (t) => {
  const archive = reader(t, source(t, "v2.sql"));
  const messages = archive.messages("ses_fixture_v2");
  assert.deepEqual(messages.map((m) => m.info.id), [
    "msg_fixture_v2_900", "msg_fixture_v2_800", "msg_fixture_v2_700",
    "msg_fixture_v2_600", "msg_fixture_v2_500", "msg_fixture_v2_100",
  ]);
  const visible = JSON.stringify(messages);
  assert.ok(visible.includes("V2_SUMMARY_MARKER"));
  assert.ok(visible.includes("SYNTHETIC_RECORDED_SHELL_OUTPUT"));
  assert.ok(!visible.includes("V1_SHADOW_DO_NOT_MERGE"));
  assert.ok(!visible.includes("NEVER_REPLAY_PENDING_INPUT"));
});

test("malformed JSON is a diagnosed incomplete archive, never empty user text", (t) => {
  const file = source(t, "v1.sql");
  const write = new DatabaseSync(file);
  write.prepare("UPDATE message SET data=? WHERE id=?").run("{broken", "msg_fixture_010");
  write.close();
  const before = hash(file);
  const archive = reader(t, file);
  assert.throws(() => archive.messages("ses_fixture_main"), /msg_fixture_010|JSON|поврежд|формат/i);
  assert.equal(hash(file), before);
});

test("unknown message role cannot silently become a human instruction", (t) => {
  const file = source(t, "v1.sql");
  const write = new DatabaseSync(file);
  const row = write.prepare("SELECT data FROM message WHERE id=?").get("msg_fixture_010");
  const body: Record<string, unknown> = JSON.parse(String(row?.data));
  body.role = "future_system_instruction";
  write.prepare("UPDATE message SET data=? WHERE id=?").run(JSON.stringify(body), "msg_fixture_010");
  write.close();
  const archive = reader(t, file);
  assert.throws(() => archive.messages("ses_fixture_main"), /role|роль|msg_fixture_010|формат/i);
});

test("projectless legacy sessions remain discoverable", (t) => {
  const file = source(t, "v1.sql");
  const write = new DatabaseSync(file);
  write.prepare("UPDATE session SET directory='' WHERE id=?").run("ses_fixture_main");
  write.close();
  const archive = reader(t, file);
  assert.ok(archive.sessions().some((s) => s.id === "ses_fixture_main" && s.directory === ""));
  assert.equal(archive.messages("ses_fixture_main").length, 6);
});

test("foreign Windows paths and raw nested tool attachments remain opaque", (t) => {
  const archive = reader(t, source(t, "v1.sql"));
  assert.equal(archive.sessions().find((s) => s.id === "ses_fixture_windows")?.directory, "C:/Synthetic/Enki/demo");
  const transcript = JSON.stringify(archive.sessions().flatMap((s) => archive.messages(s.id)));
  assert.ok(transcript.includes("prt_fixture_tool_attachment"));
  assert.ok(transcript.includes("file:///C:/Synthetic/Enki/foreign-only.txt"));
});
