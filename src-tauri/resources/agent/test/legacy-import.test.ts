// Read-only OpenCode import through the qualified importer: WAL-consistent
// snapshot, originals byte-for-byte unchanged, namespaced runtime ids, wire ids
// projected per session (raw SQL ids never become live ids), mapped parents,
// idempotent re-import, and an explicit async continuation that sends nothing.
import { afterEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { harness, tempDir, type Harness } from "./helpers.ts";
import { convertLegacy } from "../src/legacy/continue.ts";
import { legacySessionId } from "../src/legacy/opencode-import.ts";
import { archiveWireId } from "../src/legacy/wire-projection.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

const hash = (file: string) => (fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null);

function openCodeFixture(project: string): { file: string; writer: DatabaseSync } {
  const dir = tempDir("opencode-data");
  const file = path.join(dir, "opencode.db");
  const writer = new DatabaseSync(file);
  writer.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, permission TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  const session = writer.prepare("INSERT INTO session VALUES(?,?,?,?,?,?,?,?,?)");
  session.run("ses_workshop", "p", null, project, "Мастерская", 1, 5, null, JSON.stringify([{ permission: "*", pattern: "*", action: "allow" }]));
  session.run("ses_child", "p", "ses_workshop", project, "subtask", 2, 3, null, null);
  const message = writer.prepare("INSERT INTO message VALUES(?,?,?,?,?)");
  const part = writer.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)");
  message.run("msg_1", "ses_workshop", 1, 1, JSON.stringify({ role: "user", time: { created: 1 } }));
  part.run("prt_1", "msg_1", "ses_workshop", 1, 1, JSON.stringify({ type: "text", text: "fix the build" }));
  part.run("prt_1s", "msg_1", "ses_workshop", 1, 1, JSON.stringify({ type: "text", text: "<arvela-response-language-v1>", synthetic: true }));
  message.run("msg_2", "ses_workshop", 2, 3, JSON.stringify({ role: "assistant", providerID: "local-qwen-next", modelID: "qwen38", time: { created: 2, completed: 3 }, tokens: { input: 10, output: 5, cache: { read: 1, write: 0 } }, cost: 0.01, finish: "tool-calls" }));
  part.run("prt_2a", "msg_2", "ses_workshop", 2, 2, JSON.stringify({ type: "reasoning", text: "check logs" }));
  part.run("prt_2b", "msg_2", "ses_workshop", 2, 2, JSON.stringify({ type: "tool", tool: "bash", callID: "call_1", state: { status: "completed", input: { command: "npm test" }, output: "2 passed" } }));
  part.run("prt_2c", "msg_2", "ses_workshop", 2, 2, JSON.stringify({ type: "tool", tool: "edit", callID: "call_2", state: { status: "running", input: { path: "a.ts" } } }));
  part.run("prt_2d", "msg_2", "ses_workshop", 2, 2, JSON.stringify({ type: "patch", files: ["/p/a.ts"] }));
  message.run("msg_3", "ses_workshop", 4, 5, JSON.stringify({ role: "assistant", providerID: "local-qwen-next", modelID: "qwen38", time: { created: 4, completed: 5 }, finish: "stop" }));
  part.run("prt_3", "msg_3", "ses_workshop", 4, 4, JSON.stringify({ type: "text", text: "Build fixed." }));
  return { file, writer };
}

/** Runtime id of an imported OpenCode chat: namespaced by the importer's stable source origin. */
const archiveId = (file: string, legacy: string) => legacySessionId(createHash("sha256").update(fs.realpathSync(file)).digest("hex"), legacy);

it("imports a WAL database read-only with provenance and serves a projected read-only archive", async () => {
  h = await harness();
  const project = h.project("legacy");
  const { file, writer } = openCodeFixture(project);
  expect(fs.existsSync(`${file}-wal`)).toBe(true);
  const before = [hash(file), hash(`${file}-wal`)];
  const shmBefore = fs.existsSync(`${file}-shm`);
  const result = await h.runtime.importer.import(file);
  // The main database and the WAL (all history) stay byte-identical. The -shm
  // file is SQLite's shared-memory WAL index: a read-only online snapshot
  // legitimately updates its reader-coordination bytes, so it is only required
  // to still exist — its hash is not a history-preservation signal.
  expect([hash(file), hash(`${file}-wal`)]).toEqual(before);
  expect(fs.existsSync(`${file}-shm`)).toBe(shmBefore);
  // The writer still sees every committed row after the snapshot.
  expect(writer.prepare("SELECT COUNT(*) AS n FROM part").get()?.n).toBe(7);
  expect(result.created).toBe(true);
  expect(result.imported).toBe(2);

  const id = archiveId(file, "ses_workshop");
  const session = await h.request<{ id: string; parentID?: string; origin: Record<string, unknown> }>("GET", `/sessions/${id}`);
  expect(session.body).toMatchObject({ id, origin: { kind: "opencode", readOnly: true, legacyId: "ses_workshop", archive: result.archive.id } });
  const child = await h.request<{ parentID?: string }>("GET", `/sessions/${archiveId(file, "ses_child")}`);
  expect(child.body.parentID).toBe(id); // mapped parent, never the raw source id

  const history = await h.request<{ messages: Array<{ info: { id: string; sessionID: string; tokens?: { input?: number } }; parts: Array<{ id: string; messageID: string }> }> }>("GET", `/sessions/${id}/messages`);
  expect(history.body.messages.map((m) => m.info.id)).toEqual(["msg_1", "msg_2", "msg_3"].map((raw) => archiveWireId("message", id, raw)));
  expect(history.body.messages.every((m) => m.info.sessionID === id)).toBe(true);
  expect(history.body.messages[1].info.tokens?.input).toBe(10);
  expect(history.body.messages[1].parts.map((p) => p.id)).toEqual(["prt_2a", "prt_2b", "prt_2c", "prt_2d"].map((raw) => archiveWireId("part", id, raw)));

  // Writes, queue items, timers and forks are refused; nothing reaches a model.
  const refused = await h.command({ id: "legacy-write", kind: "prompt", sessionID: id, directory: project, payload: { parts: [{ type: "text", text: "continue" }], model: h.model() } });
  expect(refused.status).toBe(202);
  expect((await h.waitReceipt("legacy-write", ["rejected"])).error).toMatch(/только для чтения/);
  expect((await h.request("POST", `/sessions/${id}/queue`, { id: "q1", text: "x", model: h.model() })).status).toBe(409);
  expect((await h.request("POST", "/schedules", { sessionID: id, directory: project, title: "t", prompt: "p", minutes: 5, model: h.model() })).status).toBe(409);
  expect((await h.request("POST", `/sessions/${id}/fork`, {})).status).toBe(409);
  expect(h.scripted.calls()).toBe(0);

  const again = await h.runtime.importer.import(file);
  expect(again.created).toBe(false);
  expect(again.archive.id).toBe(result.archive.id);
  writer.close();
});

it("continues an archive asynchronously from the raw reader, pairs tools, maps raw ids and is idempotent", async () => {
  h = await harness();
  const project = h.project("continue");
  const { file, writer } = openCodeFixture(project);
  const imported = await h.runtime.importer.import(file);
  const id = archiveId(file, "ses_workshop");
  const continued = await h.request<{ id: string; origin: { kind: string; from: string; archive: string } }>("POST", `/sessions/${id}/continue`, { model: h.model() });
  expect(continued.status).toBe(200);
  expect(continued.body.origin).toEqual({ kind: "continuation", from: id, archive: imported.archive.id });
  const source = await h.request<{ origin: { continuedBy?: string } }>("GET", `/sessions/${id}`);
  expect(source.body.origin.continuedBy).toBe(continued.body.id);
  const again = await h.request<{ id: string }>("POST", `/sessions/${id}/continue`, {});
  expect(again.body.id).toBe(continued.body.id);

  const history = await h.request<{ messages: Array<{ parts: Array<{ type: string; state?: { status: string; output?: string } }> }> }>("GET", `/sessions/${continued.body.id}/messages`);
  const tools = history.body.messages.flatMap((m) => m.parts).filter((p) => p.type === "tool");
  expect(tools.map((t) => t.state?.status)).toEqual(["completed", "error"]);
  expect(tools[1].state?.output).toMatch(/результат неизвестен/);
  // The map keeps RAW source ids (archive annotations), distinct from wire/SDK ids.
  const mapped = h.runtime.db.all("SELECT legacy_message, legacy_part FROM legacy_map WHERE pi_session=? ORDER BY legacy_message, legacy_part", continued.body.id);
  expect(mapped.map((r) => `${String(r.legacy_message)}:${String(r.legacy_part)}`)).toEqual(["msg_1:", "msg_2:", "msg_2:prt_2b", "msg_2:prt_2c", "msg_3:"]);
  expect(h.scripted.calls()).toBe(0);
  writer.close();
});

it("conversion never drops tool pairs and annotates unrepresentable parts", () => {
  const converted = convertLegacy([
    { info: { id: "m1", sessionID: "s", role: "user", time: { created: 1 } }, parts: [{ id: "p1", sessionID: "s", messageID: "m1", type: "file", mime: "application/pdf", filename: "spec.pdf" }] },
    { info: { id: "m2", sessionID: "s", role: "assistant", time: { created: 2 } }, parts: [
      { id: "p2", sessionID: "s", messageID: "m2", type: "tool", tool: "task", callID: "c1", state: { status: "pending" } },
      { id: "p3", sessionID: "s", messageID: "m2", type: "subtask" },
    ] },
  ], "f".repeat(64));
  const calls = converted.messages.flatMap((m) => (m.role === "assistant" ? m.content.filter((c) => c.type === "toolCall") : []));
  const results = converted.messages.filter((m) => m.role === "toolResult");
  expect(calls).toHaveLength(1);
  expect(results).toHaveLength(1);
  expect(converted.unrepresented).toBe(2);
});

it("rolls back an import interrupted between steps on restart and keeps originals", async () => {
  const data = tempDir("import-restart");
  h = await harness({ data });
  const job = randomUUID();
  const staging = path.join(h.runtime.paths.staging, job);
  fs.mkdirSync(path.join(staging, "raw"), { recursive: true });
  h.runtime.db.run("INSERT INTO migration_journal(id,kind,state,detail,started,updated) VALUES(?,'opencode','snapshotted',?,1,1)", job, JSON.stringify({ version: 2, origin: "synthetic" }));
  await h.stop();
  h = await harness({ data, scripted: h.scripted });
  expect(fs.existsSync(staging)).toBe(false);
  expect(h.runtime.db.get("SELECT state FROM migration_journal WHERE id=?", job)?.state).toBe("rolled_back");
  expect(h.runtime.recoveryIssues).toEqual([]);
});
