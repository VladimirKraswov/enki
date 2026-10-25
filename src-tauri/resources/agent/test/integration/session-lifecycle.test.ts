// Remainder review: precise replacements for retired pi-backend cases 7, 19,
// 20 and 31 (remainder-retirement-matrix gap 3). Real Runtime, real SDK,
// scripted provider. Written, NOT RUN.
//   7  POST /sessions creates a chat without any model turn, SDK session or
//      worker (the old "no Pi CLI process spawned" premise is retired: there is
//      no CLI; its live equivalent is "no SessionWorker / SDK session opened").
//   19 GET /sessions is directory-filtered and shows the app-owned titles.
//   20 deleting an OPENED chat closes its worker and removes the metadata it
//      owned (queue, grants, Hub lease); the project files stay untouched and
//      the transcript is kept recoverable in trash.
//   31 separate persisted full/ask/read policies survive a runtime restart and
//      are still ENFORCED after it.
import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Broker, BrokerMethod } from "../../src/control/broker.ts";
import { fauxAssistantMessage, fauxToolCall } from "../../src/sdk/testing.ts";
import { gate, harness, newSession, promptCommand, tempDir, type Harness } from "../helpers.ts";

const harnesses: Harness[] = [];
afterEach(async () => { for (const item of harnesses.splice(0).reverse()) await item.stop(); });
async function start(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const created = await harness(options); harnesses.push(created); return created;
}

const FULL = [{ permission: "*", pattern: "*", action: "allow" as const }];
const allowReads = ["read", "glob", "grep", "list", "question", "todowrite"].map((permission) => ({ permission, pattern: "*", action: "allow" as const }));
const ASK = [{ permission: "*", pattern: "*", action: "ask" as const }, ...allowReads];
const READ = [{ permission: "*", pattern: "*", action: "deny" as const }, ...allowReads];

it("7: creating a chat runs no model turn and opens no worker or SDK session", async () => {
  const h = await start();
  const dir = h.project("create-only");
  const cursor = h.runtime.journal.head;
  const created = await h.request<{ id: string; title: string; directory: string }>("POST", "/sessions", { directory: dir, title: "Только создан" });
  expect(created.status).toBe(200);
  const sid = created.body.id;
  expect(created.body).toMatchObject({ title: "Только создан", directory: dir });
  expect(h.scripted.calls()).toBe(0);
  expect(h.runtime.registry.live(sid)).toBeUndefined();
  expect(h.runtime.registry.activity().opening).toBe(0);
  expect(h.runtime.catalog.get(sid)?.sessionFile).toBeNull();
  const events = (h.runtime.journal.replay({ all: true, sessionID: sid }, cursor) ?? []).map((e) => e.event.type);
  expect(events).toEqual(["session.created"]);
  // Listing the folder does not open it either.
  expect((await h.request<Array<{ id: string }>>("GET", `/sessions?directory=${encodeURIComponent(dir)}`)).body.map((s) => s.id)).toEqual([sid]);
  expect(h.runtime.registry.live(sid)).toBeUndefined();
  expect(h.scripted.calls()).toBe(0);
});

it("19: the session list is filtered by directory and shows app-owned titles, also after a turn and a rename", async () => {
  const h = await start();
  const a = h.project("list-a"), b = h.project("list-b");
  const alpha = await newSession(h, a, { title: "Альфа" });
  const untitled = await newSession(h, a);
  const beta = await newSession(h, b, { title: "Бета" });
  h.scripted.setResponses([fauxAssistantMessage("answer")]);
  await h.command(promptCommand(h, "list-turn", alpha, a, "первое сообщение, не заголовок"));
  expect((await h.waitReceipt("list-turn", ["completed", "failed", "rejected"])).state).toBe("completed");
  expect((await h.request("PATCH", `/sessions/${beta}`, { title: "Бета переименована" })).status).toBe(200);
  const listA = await h.request<Array<{ id: string; title: string; directory: string }>>("GET", `/sessions?directory=${encodeURIComponent(a)}`);
  expect(new Map(listA.body.map((s) => [s.id, s.title]))).toEqual(new Map([[alpha, "Альфа"], [untitled, "Новый чат"]]));
  expect(listA.body.every((s) => s.directory === a)).toBe(true);
  const listB = await h.request<Array<{ id: string; title: string }>>("GET", `/sessions?directory=${encodeURIComponent(b)}`);
  expect(listB.body.map((s) => [s.id, s.title])).toEqual([[beta, "Бета переименована"]]);
  const recent = await h.request<{ sessions: Array<{ id: string }> }>("GET", `/sessions/recent?directory=${encodeURIComponent(b)}`);
  expect(recent.body.sessions.map((s) => s.id)).toEqual([beta]);
});

it("19b: a corrupt transcript in a folder does not hide the other copied Pi chats from the list", async () => {
  const h = await start();
  const dir = h.project("adopt-corrupt");
  const sessions = h.runtime.sessionDir(dir);
  fs.writeFileSync(path.join(sessions, "0001_bad.jsonl"), "{not json\n");
  const id = "copied-pi-chat-0001", at = new Date().toISOString();
  fs.writeFileSync(path.join(sessions, `0002_${id}.jsonl`), [
    { type: "session", version: 3, id, timestamp: at, cwd: dir },
    { type: "message", id: "e1", parentId: null, timestamp: at, message: { role: "user", content: "скопированный чат", timestamp: Date.now() } },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n");
  const listed = await h.request<Array<{ id: string; title: string }>>("GET", `/sessions?directory=${encodeURIComponent(dir)}`);
  expect(listed.status).toBe(200);
  expect(listed.body.map((s) => [s.id, s.title])).toEqual([[id, "скопированный чат"]]);
  // The unreadable file is left exactly as it was.
  expect(fs.readFileSync(path.join(sessions, "0001_bad.jsonl"), "utf8")).toBe("{not json\n");
});

const TICKET = "12345678-1234-1234-1234-123456789012";
function hubBroker(released: unknown[]): Broker {
  return {
    kind: "supervisor",
    available: () => true,
    async call<T>(method: BrokerMethod, params: Record<string, unknown>): Promise<T> {
      if (method === "hub.identity") return { scope: "hub-test" } as T;
      const route = String(params.path).replace("model-services/", "");
      if (route === "catalog") return { schema: 1, routes: [{ service: "gpu", label: "GPU", providerID: "enki-scripted", modelID: "scripted-large", agent: "pi", target: "scripted-large" }] } as T;
      if (route === "release") { released.push(params.body); return {} as T; }
      return { schema: 1, operation_id: TICKET, phase: "ready", ready: true, active_model: "scripted-large", target_model: "scripted-large",
        elapsed_seconds: 1, active_requests: 0, error: null, loader: null } as T;
    },
  };
}

it("20: deleting an opened chat closes its worker and removes its owned queue, grants and Hub lease; project files stay", async () => {
  const released: unknown[] = [];
  const h = await start({ broker: hubBroker(released) });
  const dir = h.project("delete-opened");
  const keep = path.join(dir, "keep.txt");
  fs.writeFileSync(keep, "owner file");
  const sid = await newSession(h, dir, { permission: FULL, title: "Удаляемый" });
  const hold = gate();
  h.scripted.setResponses([fauxAssistantMessage("first"), async () => { await hold.wait; return fauxAssistantMessage("second"); }]);
  await h.command(promptCommand(h, "del-1", sid, dir, "first"));
  expect((await h.waitReceipt("del-1", ["completed", "failed", "rejected"])).state).toBe("completed");
  await h.command(promptCommand(h, "del-2", sid, dir, "second"));
  await h.waitReceipt("del-2", ["running"]);
  // Work the chat owns: a queued prompt with an attachment and a remembered grant.
  const note = `data:text/plain;base64,${Buffer.from("заметка").toString("base64")}`;
  expect((await h.request("POST", `/sessions/${sid}/queue`, { id: "q-del", text: "later", model: h.model(), parts: [{ type: "file", mime: "text/plain", filename: "note.txt", url: note }] })).status).toBe(200);
  h.runtime.db.run("INSERT INTO permission_grants(session_id,permission,pattern,created) VALUES(?,?,?,?)", sid, "edit", "remembered", Date.now());
  // Paused before the turn ends, so the queued item deterministically stays.
  expect((await h.request("POST", `/sessions/${sid}/queue/pause`, {})).status).toBe(200);
  // A running chat cannot be deleted.
  expect((await h.request("DELETE", `/sessions/${sid}`)).status).toBe(409);
  hold.open();
  expect((await h.waitReceipt("del-2", ["completed", "failed", "rejected"])).state).toBe("completed");
  for (let i = 0; i < 200 && h.runtime.dispatcher.inFlight(sid); i++) await new Promise((r) => setTimeout(r, 25));
  const worker = h.runtime.registry.live(sid)!;
  expect(worker).toBeDefined();
  expect(h.runtime.queue.hasWork(sid)).toBe(true);
  expect(h.runtime.db.get("SELECT COUNT(*) AS n FROM attachments WHERE owner='queue:q-del'")?.n).toBe(1);
  expect(h.runtime.db.get("SELECT COUNT(*) AS n FROM permission_grants WHERE session_id=?", sid)?.n).toBe(1);
  const transcript = h.runtime.catalog.get(sid)!.sessionFile!;
  expect(fs.existsSync(transcript)).toBe(true);
  const projectBefore = fs.readdirSync(dir).sort();
  // (The runtime's own 15 s heartbeat would also release an idle lease; this
  // test finishes well before it, so the release below is the deletion's.)
  const delivered = released.length;
  expect((await h.request("DELETE", `/sessions/${sid}`)).status).toBe(204);
  expect(worker.isClosed()).toBe(true);
  expect(h.runtime.registry.live(sid)).toBeUndefined();
  expect(h.runtime.catalog.get(sid)).toBeNull();
  expect((await h.request<Array<{ id: string }>>("GET", `/sessions?directory=${encodeURIComponent(dir)}`)).body.map((s) => s.id)).not.toContain(sid);
  expect(h.runtime.queue.hasWork(sid)).toBe(false);
  expect(h.runtime.queue.state(sid)).toMatchObject({ armed: false, items: [] });
  expect(h.runtime.db.get("SELECT COUNT(*) AS n FROM queue_state WHERE session_id=?", sid)?.n).toBe(0);
  expect(h.runtime.db.get("SELECT COUNT(*) AS n FROM attachments WHERE owner='queue:q-del'")?.n).toBe(0);
  expect(h.runtime.db.get("SELECT COUNT(*) AS n FROM permission_grants WHERE session_id=?", sid)?.n).toBe(0);
  expect(released.slice(delivered)).toEqual([{ ticket: TICKET }]);
  // The transcript is recoverable from trash; the project folder is untouched.
  expect(fs.existsSync(transcript)).toBe(false);
  const trash = path.join(h.runtime.paths.data, "trash");
  expect(fs.readdirSync(trash).some((name) => name.endsWith(path.basename(transcript)))).toBe(true);
  expect(fs.readdirSync(dir).sort()).toEqual(projectBefore);
  expect(fs.readFileSync(keep, "utf8")).toBe("owner file");
  // A queued prompt of the deleted chat never runs later.
  const calls = h.scripted.calls();
  await h.runtime.hub.renew();
  await new Promise((r) => setTimeout(r, 200));
  expect(h.scripted.calls()).toBe(calls);
});

it("31: separate persisted full/ask/read policies survive a restart and are enforced after it", async () => {
  const data = tempDir("policy-restart");
  const first = await start({ data });
  const dir = first.project("policy-restart");
  const full = await newSession(first, dir, { permission: FULL, title: "full" });
  const ask = await newSession(first, dir, { permission: ASK, title: "ask" });
  const read = await newSession(first, dir, { permission: READ, title: "read" });
  // Changing one chat's policy never changes another's.
  expect((await first.request("PATCH", `/sessions/${ask}`, { permission: ASK })).status).toBe(200);
  await first.stop();
  harnesses.splice(harnesses.indexOf(first), 1);

  const h = await start({ data });
  for (const [sid, rules] of [[full, FULL], [ask, ASK], [read, READ]] as const)
    expect((await h.request<{ permission?: unknown }>("GET", `/sessions/${sid}`)).body.permission).toEqual(rules);
  const writeTurn = (file: string) => h.scripted.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: file, content: "hello" })], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  writeTurn("full.txt");
  await h.command(promptCommand(h, "p-full", full, dir, "write"));
  await h.waitReceipt("p-full", ["completed"]);
  expect(fs.readFileSync(path.join(dir, "full.txt"), "utf8")).toBe("hello");
  expect(h.runtime.interactions.pendingPermissions()).toEqual([]);
  writeTurn("read.txt");
  await h.command(promptCommand(h, "p-read", read, dir, "write"));
  await h.waitReceipt("p-read", ["completed", "failed"]);
  expect(fs.existsSync(path.join(dir, "read.txt"))).toBe(false);
  expect(h.runtime.interactions.pendingPermissions()).toEqual([]);
  writeTurn("ask.txt");
  await h.command(promptCommand(h, "p-ask", ask, dir, "write"));
  for (let i = 0; i < 400 && !h.runtime.interactions.pendingPermissions().length; i++) await new Promise((r) => setTimeout(r, 25));
  const pending = h.runtime.interactions.pendingPermissions();
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ sessionID: ask, permission: "edit" });
  expect((await h.request("POST", `/permissions/${pending[0].id}/reply`, { reply: "reject" })).status).toBe(204);
  await h.waitReceipt("p-ask", ["completed", "failed"]);
  expect(fs.existsSync(path.join(dir, "ask.txt"))).toBe(false);
});
