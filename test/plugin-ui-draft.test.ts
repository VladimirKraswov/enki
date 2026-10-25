// The composer and the plugin editor share ONE canonical runtime draft (CAS).
// Lost ACKs retry the same mutation id, stale bases are explicit conflicts that
// keep the local text, nothing is sent or applied during IME composition, and
// only one mutation is in flight (ordered).
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DraftCasSync, type DraftHost, type DraftSessionPort } from "../src/agent/runtime/pluginUi/draftSync";
import type { DraftSnapshot } from "../src/agent/runtime/pluginUi/types";

const snap = (revision: number, text: string): DraftSnapshot => ({ revision, text, selection: { start: text.length, end: text.length }, updatedAt: revision });
type Mutation = { id: string; baseRevision: number; text: string };
type DraftReply = { ok: true; result: { replayed: boolean; snapshot: DraftSnapshot } } | { ok: false; message: string; canonical: DraftSnapshot | null };

let ids = 0;
function setup(sessionID = `chat-${Math.random()}`) {
  let text = "", composing = false;
  const sent: Mutation[] = [];
  const uiDraft = vi.fn<(id: string, dir: string, mutation: Mutation) => Promise<DraftReply>>(async (_id, _dir, mutation) => {
    sent.push({ ...mutation });
    return { ok: true, result: { replayed: false, snapshot: snap(mutation.baseRevision + 1, mutation.text) } };
  });
  const refresh = vi.fn<() => Promise<{ draft: DraftSnapshot } | null>>(async () => null);
  const session: DraftSessionPort = { sessionID, directory: "/p", client: { uiDraft }, refresh };
  const host: DraftHost = { read: () => text, write: value => { text = value; }, composing: () => composing };
  const sync = new DraftCasSync(session, host, () => `m-${++ids}`);
  return { sync, sent, uiDraft, refresh, setText: (value: string) => { text = value; }, text: () => text, compose: (value: boolean) => { composing = value; } };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("adopts the canonical draft into an empty composer and follows extension edits", async () => {
  const t = setup();
  t.sync.hydrate(snap(3, "from plugin"));
  expect(t.text()).toBe("from plugin");
  t.refresh.mockResolvedValueOnce({ draft: snap(4, "edited in plugin") });
  await t.sync.remoteRevision(4);
  expect(t.text()).toBe("edited in plugin");
  expect(t.sync.getState()).toEqual({ kind: "synced", revision: 4 });
  expect(t.sent).toEqual([]);
});

it("sends composer edits in order with one mutation in flight", async () => {
  const t = setup();
  t.sync.hydrate(snap(0, ""));
  let release!: () => void;
  t.uiDraft.mockImplementationOnce(async (_i, _d, mutation) => { t.sent.push({ ...mutation }); await new Promise<void>(r => { release = r; }); return { ok: true, result: { replayed: false, snapshot: snap(1, mutation.text) } }; });
  t.setText("a"); t.sync.localChanged(); await vi.advanceTimersByTimeAsync(300);
  t.setText("ab"); t.sync.localChanged(); await vi.advanceTimersByTimeAsync(300);
  expect(t.sent.map(m => m.text)).toEqual(["a"]);
  release(); await vi.advanceTimersByTimeAsync(10);
  expect(t.sent.map(m => [m.text, m.baseRevision])).toEqual([["a", 0], ["ab", 1]]);
});

it("a lost acknowledgement is retried with the SAME mutation id", async () => {
  const t = setup();
  t.sync.hydrate(snap(2, ""));
  t.uiDraft.mockRejectedValueOnce(new Error("connection lost"));
  t.setText("hello"); t.sync.localChanged(); await vi.advanceTimersByTimeAsync(300);
  expect(t.sync.getState().kind).toBe("retrying");
  await vi.advanceTimersByTimeAsync(1_000);
  const calls = t.uiDraft.mock.calls.map(call => call[2]);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(t.sync.getState()).toEqual({ kind: "synced", revision: 3 });
});

it("a stale base is an explicit conflict that keeps the local text; both resolutions are explicit", async () => {
  const t = setup();
  t.sync.hydrate(snap(5, "base"));
  t.uiDraft.mockResolvedValueOnce({ ok: false, message: "Черновик уже изменился", canonical: snap(6, "plugin text") });
  t.setText("my text"); t.sync.localChanged(); await vi.advanceTimersByTimeAsync(300);
  expect(t.sync.getState()).toMatchObject({ kind: "conflict", local: "my text", canonical: { revision: 6 } });
  expect(t.text()).toBe("my text");
  t.sync.takeTheirs();
  expect(t.text()).toBe("plugin text");
  expect(t.sync.stash).toBe("my text");
  t.sync.restoreStash(); await vi.advanceTimersByTimeAsync(300);
  expect(t.sent.at(-1)).toMatchObject({ baseRevision: 6, text: "my text" });
});

it("keepMine replaces the canonical draft from the conflicting revision with a new id", async () => {
  const t = setup();
  t.sync.hydrate(snap(1, ""));
  t.uiDraft.mockResolvedValueOnce({ ok: false, message: "conflict", canonical: snap(2, "theirs") });
  t.setText("mine"); t.sync.localChanged(); await vi.advanceTimersByTimeAsync(300);
  await t.sync.keepMine();
  const [first, second] = t.uiDraft.mock.calls.map(call => call[2]);
  expect(second).toMatchObject({ baseRevision: 2, text: "mine" });
  expect(second.id).not.toBe(first.id);
});

it("never sends or overwrites during an IME composition", async () => {
  const t = setup();
  t.sync.hydrate(snap(0, ""));
  t.compose(true);
  t.setText("にほ"); t.sync.localChanged(); await vi.advanceTimersByTimeAsync(300);
  expect(t.sent).toEqual([]);
  t.refresh.mockResolvedValueOnce({ draft: snap(1, "remote") });
  await t.sync.remoteRevision(1);
  expect(t.text()).toBe("にほ");
  t.compose(false); t.sync.compositionEnded();
  expect(t.sync.getState()).toMatchObject({ kind: "conflict", local: "にほ" });
});

it("a returning tab with unsent text on the same base pushes it instead of discarding it", async () => {
  const first = setup("chat-return");
  first.sync.hydrate(snap(7, "seen"));
  first.sync.dispose();
  const again = setup("chat-return");
  again.setText("seen + typed offline");
  again.sync.hydrate(snap(7, "seen"));
  await vi.advanceTimersByTimeAsync(10);
  expect(again.sent).toEqual([{ id: expect.any(String), baseRevision: 7, text: "seen + typed offline" }]);
});
