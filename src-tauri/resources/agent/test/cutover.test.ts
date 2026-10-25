// Pre-2.0 UI queues/timers → runtime through the durable cutover journal.
// Invariants: immutable payload (incl. attachments) recorded before
// publication; publication + receipt atomic; stable ids and idempotent retry
// across restart; unmappable items quarantined with payload (never text-only,
// never dispatched); paused timers stored disabled once; no execution.
import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { CutoverJournal } from "../src/migration/cutover.ts";
import { harness, newSession, tempDir, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
type Receipt = { id: string; legacyId: string; state: string; sessionID: string | null; itemID: string | null; code: string | null; retryable: boolean };
const INSTALL = "install-0000-test";

function batch(workspace: string, source: "ui-queue" | "ui-timers", items: unknown[]) { return { installation: INSTALL, workspace, source, items }; }
const queueItem = (legacyId: string, session: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  kind: "queue", legacyId, session,
  queue: { text: `text ${legacyId}`, parts: [], model: { providerID: "enki-scripted", modelID: "scripted-large", variant: "high" }, state: "ready", queuedAt: 10, ...extra },
});

it("publishes a full queue (files, variant, order, uncertain) paused, idempotently, and never dispatches it", async () => {
  h = await harness();
  const project = h.project("cutover-queue");
  const sid = await newSession(h, project);
  const ref = { engine: "runtime", id: sid, directory: project };
  const items = [
    queueItem("old-1", ref, { parts: [{ type: "file", mime: "image/png", filename: "shot.png", url: PNG }] }),
    queueItem("old-2", ref, { state: "uncertain", error: "Доставка не подтверждена" }),
    queueItem("old-3", ref),
  ];
  const first = await h.request<{ receipts: Receipt[] }>("POST", "/migrations/cutover", batch("ws-local", "ui-queue", items));
  expect(first.body.receipts.map((r) => r.state)).toEqual(["accepted", "accepted", "accepted"]);
  const queue = h.runtime.queue.state(sid);
  expect(queue.armed).toBe(false);
  expect(queue.pausedReason).toMatch(/перенесена/);
  expect(queue.items.map((i) => [i.id, i.state])).toEqual(first.body.receipts.map((r, n) => [r.itemID, n === 1 ? "uncertain" : "ready"]));
  expect(queue.items[0].attachments).toEqual([expect.objectContaining({ name: "shot.png", mime: "image/png" })]);
  expect(queue.items[0].model).toEqual({ providerID: "enki-scripted", modelID: "scripted-large", variant: "high" });
  // The journal keeps its own backup reference to the bytes until resolved.
  expect(h.runtime.db.get("SELECT COUNT(*) AS n FROM attachments WHERE owner=?", `cutover:${first.body.receipts[0].id}`)?.n).toBe(1);

  const again = await h.request<{ receipts: Receipt[] }>("POST", "/migrations/cutover", batch("ws-local", "ui-queue", items));
  expect(again.body.receipts).toEqual(first.body.receipts);
  expect(h.runtime.queue.state(sid).items).toHaveLength(3);
  expect(h.scripted.calls()).toBe(0);

  // Same legacy id, different payload: the first durable copy wins, visibly.
  const conflict = await h.request<{ receipts: Receipt[] }>("POST", "/migrations/cutover", batch("ws-local", "ui-queue", [queueItem("old-3", ref, { text: "changed" })]));
  expect(conflict.body.receipts[0]).toMatchObject({ code: "payload_conflict", state: "accepted" });
});

it("quarantines unmapped items with their payload, keeps other workspaces independent, and retries after import", async () => {
  h = await harness();
  const project = h.project("cutover-archive");
  const writable = await newSession(h, project);
  const archiveRef = { engine: "opencode", id: "ses_old", directory: project };
  const unmapped = await h.request<{ receipts: Receipt[] }>("POST", "/migrations/cutover",
    batch("ws-a", "ui-queue", [queueItem("a-1", archiveRef, { parts: [{ type: "file", mime: "image/png", filename: "a.png", url: PNG }] })]));
  expect(unmapped.body.receipts[0]).toMatchObject({ state: "quarantined", code: "source_not_imported", retryable: true });
  const other = await h.request<{ receipts: Receipt[] }>("POST", "/migrations/cutover", batch("ws-b", "ui-queue", [queueItem("b-1", { engine: "runtime", id: writable, directory: project })]));
  expect(other.body.receipts[0].state).toBe("accepted");
  expect((await h.request<Receipt[]>("GET", "/migrations/cutover?workspace=ws-a")).body.map((r) => r.state)).toEqual(["quarantined"]);

  // Import the archive; retry continues it into a verified writable chat (archive pointer kept).
  const file = path.join(tempDir("cutover-oc"), "opencode.db"), writer = new DatabaseSync(file);
  writer.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, permission TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  writer.prepare("INSERT INTO session VALUES(?,?,?,?,?,?,?,?,?)").run("ses_old", "p", null, project, "Старый", 1, 2, null, null);
  writer.close();
  await h.runtime.importer.import(file);
  const retried = await h.request<Receipt>("POST", `/migrations/cutover/${unmapped.body.receipts[0].id}/retry`);
  expect(retried.body.state).toBe("accepted");
  const target = h.runtime.catalog.get(retried.body.sessionID!)!;
  expect(target.origin.kind).toBe("continuation");
  const archive = h.runtime.catalog.all().find((s) => s.origin.kind === "opencode")!;
  expect(archive.origin).toMatchObject({ kind: "opencode", continuedBy: target.id });
  expect(h.runtime.queue.state(target.id).items[0].attachments).toHaveLength(1);
  expect(h.scripted.calls()).toBe(0);
});

it("stores paused/uncertain timers disabled in one write, moves overdue repeats forward and never fires them", async () => {
  h = await harness();
  const project = h.project("cutover-timers");
  const sid = await newSession(h, project);
  const ref = { engine: "runtime", id: sid, directory: project };
  const now = Date.now();
  const timer = (legacyId: string, extra: Record<string, unknown>) => ({ kind: "timer", legacyId, session: ref,
    timer: { title: legacyId, prompt: `wake ${legacyId}`, minutes: 15, mode: "repeat", model: h.model(), enabled: true, state: "ready", nextAt: now + 60_000, ...extra } });
  const result = await h.request<{ receipts: Receipt[] }>("POST", "/migrations/cutover", batch("ws-t", "ui-timers", [
    timer("paused", { enabled: false }), timer("dispatching", { state: "dispatching" }), timer("overdue", { nextAt: now - 3_600_000 }),
    timer("once-missed", { mode: "once", runAt: now - 1000, nextAt: now - 1000 }), timer("normal", {}),
  ]));
  expect(result.body.receipts.every((r) => r.state === "accepted")).toBe(true);
  const tasks = new Map(h.runtime.scheduler.list({ sessionID: sid }).tasks.map((t) => [t.title, t]));
  expect(tasks.get("paused")).toMatchObject({ enabled: false, state: "ready" });
  expect(tasks.get("dispatching")).toMatchObject({ enabled: false, state: "error" });
  expect(tasks.get("overdue")!.nextAt).toBeGreaterThan(now);
  expect(tasks.get("once-missed")).toMatchObject({ enabled: false, state: "error" });
  expect(tasks.get("normal")).toMatchObject({ enabled: true, nextAt: now + 60_000 });
  // Every schedule.updated for "paused" carried enabled:false (never enabled-then-paused).
  const updates = h.runtime.journal.replay({ all: true }, 0)!.filter((e) => e.event.type === "schedule.updated")
    .map((e) => (e.event.properties as { task: { title: string; enabled: boolean } }).task).filter((t) => t.title === "paused");
  expect(updates.length).toBeGreaterThan(0);
  expect(updates.every((t) => !t.enabled)).toBe(true);
  h.runtime.scheduler.tick(now + 1);
  expect(h.scripted.calls()).toBe(0);
});

it("adopts an earlier unjournaled timer copy instead of duplicating it, and applies the source's paused intent atomically", async () => {
  h = await harness();
  const project = h.project("cutover-legacy-copy");
  const sid = await newSession(h, project);
  const ref = { engine: "runtime", id: sid, directory: project };
  // What an early 2.0 build left behind: copied enabled under `legacy-<id>`, its pause call lost.
  const copy = h.runtime.scheduler.add({ directory: project, sessionID: sid, title: "old", prompt: "wake old", minutes: 15, mode: "repeat", requestKey: "legacy-old-1", model: h.model() });
  expect(copy.enabled).toBe(true);
  const result = await h.request<{ receipts: Receipt[] }>("POST", "/migrations/cutover", batch("ws-copy", "ui-timers", [{ kind: "timer", legacyId: "old-1", session: ref,
    timer: { title: "old", prompt: "wake old", minutes: 15, mode: "repeat", model: h.model(), enabled: false, state: "ready", nextAt: Date.now() + 60_000 } }]));
  expect(result.body.receipts[0]).toMatchObject({ state: "accepted", itemID: copy.id });
  const tasks = h.runtime.scheduler.list({ sessionID: sid }).tasks;
  expect(tasks).toHaveLength(1); // no duplicate wake-up
  expect(tasks[0]).toMatchObject({ id: copy.id, enabled: false });
  h.runtime.scheduler.tick(Date.now() + 3_600_000);
  expect(h.scripted.calls()).toBe(0);
});

it("keeps the journal, receipts and stable ids across restart; a publish failure stays retryable with payload", async () => {
  const data = tempDir("cutover-restart");
  h = await harness({ data });
  const project = h.project("cutover-restart");
  const sid = await newSession(h, project);
  const ref = { engine: "runtime", id: sid, directory: project };
  // Fault cut at the publication boundary: the target queue is full.
  // (paused fill: nothing is dispatched while the limit is reached)
  for (let n = 0; n < 20; n++) h.runtime.queue.importItem(sid, project, { id: `fill-${n}`, text: "fill", parts: [], model: h.model(), state: "ready" }, "test fill");
  const cut = await h.request<{ receipts: Receipt[] }>("POST", "/migrations/cutover", batch("ws-r", "ui-queue", [queueItem("r-1", ref)]));
  expect(cut.body.receipts[0]).toMatchObject({ state: "quarantined", code: "publish_failed", retryable: true });
  expect(cut.body.receipts[0].id).toBe(CutoverJournal.idOf(INSTALL, "ws-r", "ui-queue", "queue", "r-1"));
  const scripted = h.scripted;
  await h.stop();
  h = await harness({ data, scripted });
  expect((await h.request<Receipt[]>("GET", "/migrations/cutover")).body).toEqual([expect.objectContaining({ id: cut.body.receipts[0].id, state: "quarantined" })]);
  expect(JSON.parse(String(h.runtime.db.get("SELECT payload FROM cutover_items")?.payload)).queue.text).toBe("text r-1");
  await h.request("DELETE", `/sessions/${sid}/queue/fill-0`);
  const retried = await h.request<{ receipts: Receipt[] }>("POST", "/migrations/cutover", batch("ws-r", "ui-queue", [queueItem("r-1", ref)]));
  expect(retried.body.receipts[0]).toMatchObject({ id: cut.body.receipts[0].id, state: "accepted" });
  expect(fs.existsSync(path.join(data, "runtime.sqlite"))).toBe(true);
  const resolved = await h.request<Receipt>("POST", `/migrations/cutover/${cut.body.receipts[0].id}/resolve`);
  expect(resolved.body.state).toBe("resolved");
  expect(h.runtime.queue.state(sid).items.some((i) => i.id === retried.body.receipts[0].itemID)).toBe(true); // resolving keeps published work
});
