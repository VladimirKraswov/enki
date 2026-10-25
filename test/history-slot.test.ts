// Final integration (UI performance audit P2): a chat slot created only by
// live/background events or a status listing is not a history read, and loaded
// inactive transcripts are a bounded cache. Real store + runtime fixture.
// Written, NOT RUN.
import { beforeEach, expect, it, vi } from "vitest";
import type { RuntimeFixture } from "./helpers/runtime-fixture";

const hosts = vi.hoisted(() => ({ backend: null as unknown }));
vi.mock("../src/agent/registry", async (original) => ({ ...(await original<typeof import("../src/agent/registry")>()),
  connectRuntime: vi.fn(async () => hosts.backend) }));

let store: any, fx: RuntimeFixture, RETAINED: number;
const DIR = "/work/a";
const session = (id: string) => ({ id, directory: DIR, title: id, projectID: "fixture", time: { created: 1, updated: 1 } });
const page = (id: string) => ({ messages: [{ info: { id: `${id}-m1`, sessionID: id, role: "user", time: { created: 1 } }, parts: [{ id: `${id}-p1`, sessionID: id, messageID: `${id}-m1`, type: "text", text: `old ${id}` }] }], before: `${id}-older` });
const ids = Array.from({ length: 20 }, (_, i) => `ses_${i}`);
beforeEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v), removeItem: (k: string) => saved.delete(k) });
  vi.stubGlobal("document", { hidden: false, hasFocus: vi.fn(() => true) });
  const fixture = await import("./helpers/runtime-fixture");
  const module = await import("../src/state/store");
  store = module.store; RETAINED = module.RETAINED_TRANSCRIPTS;
  fx = fixture.runtimeFixture(); hosts.backend = fx.backend;
  fx.on("GET", "/sessions", () => ids.map(session));
  fx.on("GET", "/sessions/:id", c => session(c.params.id));
  fx.on("GET", "/sessions/:id/messages", c => page(c.params.id));
  expect(await store.connectLocal()).toBe(true);
  await store.setDirectory(DIR);
});

it("a background chat that only streamed loads its authoritative page (and cursor) once when opened", async () => {
  await store.selectSession("ses_0");
  // ses_1 receives a live tail while the user reads ses_0: a slot now exists.
  fx.emit({ type: "message.part.updated", properties: { part: { id: "live-p", sessionID: "ses_1", messageID: "live-m", type: "text", text: "live" } } }, DIR);
  expect(store.state.chat.sessions.ses_1).toBeTruthy();
  const before = fx.made("GET", "/sessions/ses_1/messages").length;
  await store.selectSession("ses_1");
  expect(fx.made("GET", "/sessions/ses_1/messages")).toHaveLength(before + 1);
  expect(store.state.chat.sessions.ses_1.messageOrder).toContain("ses_1-m1");
  expect(store.state.historyCursors.ses_1).toBe("ses_1-older");
  // Re-opening an already loaded chat does not re-read it.
  await store.selectSession("ses_0"); await store.selectSession("ses_1");
  expect(fx.made("GET", "/sessions/ses_1/messages")).toHaveLength(before + 1);
});

// Regression: restoring a project's last chat skipped the history read when a
// live-only slot existed, leaving a streamed tail without history or cursor.
it("restoring a project's chat with only a streamed slot reads its authoritative page", async () => {
  await store.selectSession("ses_0");
  fx.emit({ type: "message.part.updated", properties: { part: { id: "live-p", sessionID: "ses_1", messageID: "live-m", type: "text", text: "live" } } }, DIR);
  expect(store.state.chat.sessions.ses_1).toBeTruthy();
  const before = fx.made("GET", "/sessions/ses_1/messages").length;
  await store.setDirectory("/work/b");
  await store.setDirectory(DIR, { sessionId: "ses_1" });
  expect(fx.made("GET", "/sessions/ses_1/messages")).toHaveLength(before + 1);
  expect(store.state.chat.sessions.ses_1.messageOrder).toContain("ses_1-m1");
  expect(store.state.historyCursors.ses_1).toBe("ses_1-older");
});

it("an oversized-event stub re-reads that chat's authoritative history (active now, background on open)", async () => {
  await store.selectSession("ses_0");
  const active = fx.made("GET", "/sessions/ses_0/messages").length;
  fx.emit({ type: "event.oversized", properties: { type: "message.part.updated", bytes: 9e6, sessionID: "ses_0", messageID: "m", partID: "p" } }, DIR);
  await vi.waitFor(() => expect(fx.made("GET", "/sessions/ses_0/messages")).toHaveLength(active + 1));
  await store.selectSession("ses_1");
  fx.emit({ type: "event.oversized", properties: { type: "message.part.updated", bytes: 9e6, sessionID: "ses_0" } }, DIR);
  const background = fx.made("GET", "/sessions/ses_0/messages").length;
  await new Promise((r) => setTimeout(r, 20));
  expect(fx.made("GET", "/sessions/ses_0/messages")).toHaveLength(background);
  await store.selectSession("ses_0");
  expect(fx.made("GET", "/sessions/ses_0/messages")).toHaveLength(background + 1);
});

// Regression: slots of other chats that only STREAMED (timers, background runs)
// were never released, so a long-lived window kept every streamed run.
it("stream-only background slots are bounded when chats settle; running, failed and active chats are kept", async () => {
  const live = (id: string, n: number) => fx.emit({ type: "message.part.updated", properties: { part: { id: `${id}-live${n}`, sessionID: id, messageID: `${id}-lm`, type: "text", text: "x".repeat(1000) } } }, DIR);
  const status = (id: string, type: string) => fx.emit({ type: "session.status", properties: { sessionID: id, status: { type } } }, DIR);
  await store.selectSession("ses_0");
  const background = ids.slice(1);
  for (const id of background) { status(id, "busy"); live(id, 0); }
  // A failed background run keeps its attention mark; one is still running.
  fx.emit({ type: "session.error", properties: { sessionID: "ses_2", error: { message: "boom" } } }, DIR);
  for (const id of background.filter(id => id !== "ses_2" && id !== "ses_3")) { await new Promise(r => setTimeout(r, 1)); status(id, "idle"); }
  const MODULE = await import("../src/state/store");
  const streamOnly = background.filter(id => store.state.chat.sessions[id]);
  // Bounded: the retained idle slots plus the running and the failed chat.
  expect(streamOnly.length).toBeLessThanOrEqual(MODULE.RETAINED_STREAM_SLOTS + 2);
  expect(store.state.chat.sessions.ses_3).toBeTruthy(); // still busy
  expect(store.state.chat.sessions.ses_2?.lastError).toBeTruthy(); // failed: still marked
  expect(store.state.chat.sessions.ses_0).toBeTruthy(); // active
  // The least recently active slots go first (ties: creation order); the newest is kept.
  expect(store.state.chat.sessions[background.at(-1)!]).toBeTruthy();
  const released = background.find(id => !store.state.chat.sessions[id])!;
  expect(released).toBeTruthy();
  // Opening a released chat reads its authoritative history; nothing was replayed.
  await store.selectSession(released);
  expect(store.state.chat.sessions[released].messageOrder).toEqual([`${released}-m1`]);
  expect(fx.made("POST", "/commands")).toEqual([]);
});

it("loaded inactive transcripts are bounded; running/waiting chats are kept and an evicted one reloads on activation", async () => {
  await store.selectSession("ses_0");
  fx.emit({ type: "session.status", properties: { sessionID: "ses_0", status: { type: "busy" } } }, DIR);
  for (const id of ids.slice(1)) await store.selectSession(id);
  const loaded = ids.filter((id) => store.state.chat.sessions[id]?.messageOrder.includes(`${id}-m1`));
  expect(loaded.length).toBeLessThanOrEqual(RETAINED + 1);
  // The running chat and the active one are never released.
  expect(loaded).toContain("ses_0");
  expect(loaded).toContain(ids.at(-1));
  const evicted = ids.slice(1).find((id) => !store.state.chat.sessions[id]);
  expect(evicted).toBeTruthy();
  expect(store.state.historyCursors[evicted!]).toBeUndefined();
  const reads = fx.made("GET", `/sessions/${evicted}/messages`).length;
  await store.selectSession(evicted);
  expect(fx.made("GET", `/sessions/${evicted}/messages`)).toHaveLength(reads + 1);
  expect(store.state.chat.sessions[evicted!].messageOrder).toEqual([`${evicted}-m1`]);
});
