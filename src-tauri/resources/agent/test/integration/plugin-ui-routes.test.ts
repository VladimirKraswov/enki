// Plugin UI over authenticated HTTP/SSE: UUIDv4 client principals, authority held
// for the SSE lifetime and taken BEFORE worker startup, staged-worker attach while
// session_start awaits a custom UI, reconnect without a duplicate worker, draft
// CAS with lost-ACK replay and explicit conflicts, controller leases, and
// maintenance keeping live views readable while mutations are refused.
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { extension, gate, harness, newSession, ownedEvents, type Harness } from "../helpers.ts";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

interface UiClient { messages: Array<Record<string, unknown>>; status: Promise<number>; close(): void; waitFor(type: string, timeoutMs?: number): Promise<Record<string, unknown>> }

function uiStream(h: Harness, sid: string, dir: string, client: string | null, route: "open" | "events" = "open"): UiClient {
  const messages: Array<Record<string, unknown>> = [];
  // Own socket, tracked by the harness: closed and awaited before its listener.
  const { request, status } = ownedEvents(`${h.base}/sessions/${sid}/ui/${route}?directory=${encodeURIComponent(dir)}`,
    { Authorization: `Bearer ${h.token}`, ...(client ? { "X-Enki-Client": client } : {}) },
    data => { messages.push(JSON.parse(data) as Record<string, unknown>); }, h);
  return {
    messages, status, close: () => { void request.close(); },
    waitFor: async (type, timeoutMs = 20_000) => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const found = messages.find(m => m.type === type);
        if (found) return found;
        if (Date.now() > until) throw new Error(`ui message ${type} not observed`);
        await new Promise(r => setTimeout(r, 20));
      }
    },
  };
}

const as = (client: string) => ({ "X-Enki-Client": client });
const q = (dir: string) => `?directory=${encodeURIComponent(dir)}`;

it("requires a UUIDv4 client principal; authority principals can read the API but not the UI", async () => {
  h = await harness();
  const dir = h.project("ui-auth");
  const sid = await newSession(h, dir);
  expect((await uiStream(h, sid, dir, null).status)).toBe(403);
  expect((await uiStream(h, sid, dir, "not-a-uuid").status)).toBe(403);
  expect((await h.request("GET", `/sessions/${sid}${q(dir)}`)).status).toBe(200);
  expect((await h.request("GET", `/sessions/${sid}/ui${q(dir)}`)).status).toBe(403);
  expect((await h.request("POST", `/sessions/${sid}/ui/control${q(dir)}`, {}, as(randomUUID()))).status).toBe(403);
});

it("attaches, controls, fences viewers, replays a lost draft ACK and reports conflicts", async () => {
  h = await harness();
  const dir = h.project("ui-draft");
  const sid = await newSession(h, dir);
  const owner = randomUUID(), viewer = randomUUID();
  const a = uiStream(h, sid, dir, owner);
  expect(await a.status).toBe(200);
  const hello = await a.waitFor("ui.hello");
  const snapshot = hello.snapshot as { scope: { sessionId: string; sessionEpoch: number }; nativeScope: unknown; draft: { revision: number } };
  expect(snapshot.scope.sessionId).toBe(sid);
  expect(snapshot.nativeScope).toBeNull();
  await a.waitFor("ui.reset");
  const control = await h.request<{ controllerLeaseId: string | null; scope: { sessionEpoch: number } }>("POST", `/sessions/${sid}/ui/control${q(dir)}`, {}, as(owner));
  expect(control.status).toBe(200);
  expect(control.body.controllerLeaseId).toBeTruthy();
  const owned = await h.request<{ nativeScope: { principal: string; directory: string } | null }>("GET", `/sessions/${sid}/ui${q(dir)}`, undefined, as(owner));
  expect(owned.body.nativeScope).toMatchObject({ directory: dir });
  expect(owned.body.nativeScope?.principal).toMatch(/^client:[a-f0-9]{64}$/);
  const b = uiStream(h, sid, dir, viewer);
  await b.waitFor("ui.hello");
  const seen = await h.request<{ nativeScope: unknown; attachment: { controllerLeaseId: string | null } }>("GET", `/sessions/${sid}/ui${q(dir)}`, undefined, as(viewer));
  expect(seen.body).toMatchObject({ nativeScope: null, attachment: { controllerLeaseId: null } });
  const base = snapshot.draft.revision;
  const first = await h.request<{ replayed: boolean; snapshot: { revision: number; text: string } }>("POST", `/sessions/${sid}/ui/draft${q(dir)}`, { id: "m-1", baseRevision: base, text: "hello" }, as(owner));
  expect(first.body).toMatchObject({ replayed: false, snapshot: { revision: base + 1, text: "hello" } });
  // Lost ACK: the SAME mutation id is retried and replayed, never applied twice.
  const retry = await h.request<{ replayed: boolean }>("POST", `/sessions/${sid}/ui/draft${q(dir)}`, { id: "m-1", baseRevision: base, text: "hello" }, as(owner));
  expect(retry.body.replayed).toBe(true);
  // Another writer on a stale revision gets an explicit conflict with the canonical draft.
  const stale = await h.request<{ code: string; draft: { text: string; revision: number } }>("POST", `/sessions/${sid}/ui/draft${q(dir)}`, { id: "m-2", baseRevision: base, text: "other" }, as(viewer));
  expect(stale.status).toBe(409);
  expect(stale.body).toMatchObject({ code: "draft-conflict", draft: { text: "hello", revision: base + 1 } });
  // Same id with different content is a conflict, not a silent overwrite.
  expect((await h.request("POST", `/sessions/${sid}/ui/draft${q(dir)}`, { id: "m-1", baseRevision: base, text: "changed" }, as(owner))).status).toBe(409);
  expect((await h.request("POST", `/sessions/${sid}/ui/input${q(dir)}`, { type: "ui.input" }, as(viewer))).status).toBe(409);
  a.close(); b.close();
});

// Remainder review: every editor change commits a full-text receipt; storage
// must stay bounded while a recent lost ACK still replays and an evicted one
// is an explicit conflict, never a second application.
it("draft receipts are bounded: recent ids replay, evicted ids conflict, storage does not grow per edit", async () => {
  h = await harness();
  const dir = h.project("ui-draft-bound");
  const sid = await newSession(h, dir);
  const owner = randomUUID();
  const a = uiStream(h, sid, dir, owner);
  const hello = await a.waitFor("ui.hello");
  let revision = (hello.snapshot as { draft: { revision: number } }).draft.revision;
  const text = "x".repeat(4096);
  for (let n = 0; n < 150; n++) {
    const done = await h.request<{ snapshot: { revision: number } }>("POST", `/sessions/${sid}/ui/draft${q(dir)}`, { id: `edit-${n}`, baseRevision: revision, text: `${text}${n}` }, as(owner));
    expect(done.status).toBe(200);
    revision = done.body.snapshot.revision;
  }
  const count = h.runtime.db.get("SELECT COUNT(*) AS n FROM meta WHERE key LIKE ?", `ui:v1:${sid}:draft-receipt:%`)?.n;
  expect(Number(count)).toBeLessThanOrEqual(64);
  expect(Number(count)).toBeGreaterThan(0);
  // The newest mutation's lost ACK still replays exactly.
  const recent = await h.request<{ replayed: boolean; snapshot: { revision: number } }>("POST", `/sessions/${sid}/ui/draft${q(dir)}`, { id: "edit-149", baseRevision: revision - 1, text: `${text}149` }, as(owner));
  expect(recent.body).toMatchObject({ replayed: true, snapshot: { revision } });
  // An evicted early mutation is not re-applied over the newer draft.
  const old = await h.request<{ code: string; draft: { revision: number; text: string } }>("POST", `/sessions/${sid}/ui/draft${q(dir)}`, { id: "edit-0", baseRevision: 0, text: `${text}0` }, as(owner));
  expect(old.status).toBe(409);
  expect(old.body.draft).toMatchObject({ revision, text: `${text}149` });
  a.close();
});

it("authority is taken before startup; a staged worker is attachable while session_start awaits UI", async () => {
  const startup = gate();
  h = await harness({ extraExtensions: () => [extension("slow-start", pi => { pi.on("session_start", async () => { await startup.wait; }); })] });
  const dir = h.project("ui-staged");
  const sid = await newSession(h, dir);
  const client = randomUUID();
  const view = uiStream(h, sid, dir, client);
  const hello = await view.waitFor("ui.hello");
  expect((hello.snapshot as { scope: { sessionId: string } }).scope.sessionId).toBe(sid);
  expect(h.runtime.activity().opening).toBe(1);
  // Reconnect during startup re-attaches to the same staged worker.
  const again = uiStream(h, sid, dir, client);
  await again.waitFor("ui.hello");
  expect(h.runtime.activity().opening).toBe(1);
  startup.open();
  const worker = await h.runtime.registry.worker(sid);
  expect(h.runtime.registry.live(sid)).toBe(worker);
  view.close(); again.close();
});

it("releases authority when the stream closes and never launches a duplicate worker on reconnect", async () => {
  h = await harness();
  const dir = h.project("ui-reconnect");
  const sid = await newSession(h, dir);
  const client = randomUUID();
  const first = uiStream(h, sid, dir, client);
  const hello = await first.waitFor("ui.hello");
  const worker = h.runtime.registry.live(sid);
  first.close();
  const until = Date.now() + 5_000;
  while ((await h.request("GET", `/sessions/${sid}/ui${q(dir)}`, undefined, as(client))).status !== 403) {
    if (Date.now() > until) throw new Error("UI authority survived the closed stream");
    await new Promise(r => setTimeout(r, 25));
  }
  const second = uiStream(h, sid, dir, client);
  const rehello = await second.waitFor("ui.hello");
  expect(h.runtime.registry.live(sid)).toBe(worker);
  expect((rehello.snapshot as { scope: unknown }).scope).toEqual((hello.snapshot as { scope: unknown }).scope);
  second.close();
});

it("during maintenance a live view stays readable while opening and mutations are refused", async () => {
  h = await harness();
  const dir = h.project("ui-maintenance");
  const sid = await newSession(h, dir), other = await newSession(h, dir);
  const client = randomUUID();
  const view = uiStream(h, sid, dir, client);
  await view.waitFor("ui.hello");
  h.runtime.admission.setMaintenance(true);
  try {
    expect((await h.request("GET", `/sessions/${sid}/ui${q(dir)}`, undefined, as(client))).status).toBe(200);
    expect((await h.request("POST", `/sessions/${sid}/ui/resync${q(dir)}`, {}, as(client))).status).toBe(204);
    expect((await h.request("POST", `/sessions/${sid}/ui/control${q(dir)}`, {}, as(client))).status).toBe(503);
    expect(await uiStream(h, other, dir, randomUUID(), "open").status).toBe(503);
    // Watching never opens a worker: it waits (authority held) for one to start.
    const waiting = uiStream(h, other, dir, randomUUID(), "events");
    expect(await waiting.status).toBe(200);
    await waiting.waitFor("ui.waiting");
    expect(h.runtime.registry.live(other)).toBeUndefined();
    waiting.close();
    const watcher = uiStream(h, sid, dir, randomUUID(), "events");
    expect(await watcher.status).toBe(200);
    await watcher.waitFor("ui.hello");
    watcher.close();
  } finally { h.runtime.admission.setMaintenance(false); }
  view.close();
});

it("a watching view attaches when a prompt starts the worker", async () => {
  h = await harness();
  const dir = h.project("ui-watch");
  const sid = await newSession(h, dir);
  const watcher = uiStream(h, sid, dir, randomUUID(), "events");
  await watcher.waitFor("ui.waiting");
  await h.runtime.registry.worker(sid);
  const hello = await watcher.waitFor("ui.hello");
  expect((hello.snapshot as { scope: { sessionId: string } }).scope.sessionId).toBe(sid);
  await watcher.waitFor("ui.reset");
  watcher.close();
});
