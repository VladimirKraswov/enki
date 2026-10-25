import { describe, expect, it, vi } from "vitest";
import type { MessageResponse, Session } from "../src/api/types";
import { addMessageUsage, periodStart, scanUsage, type UsageSource } from "../src/usage/metrics";
import { bindStore, runtimeFixture } from "./helpers/runtime-fixture";

const day = new Date(2026, 8, 30, 12).getTime();
function session(id: string, updated = day): Session {
  return { id, projectID: "p", directory: "/tmp/test", title: id, time: { created: updated, updated } };
}
function answer(id: string, modelID: string, tokens: { total?: number; input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }, time = day): MessageResponse {
  return { info: { id, sessionID: "s1", role: "assistant", providerID: "local", modelID, time: { created: time, completed: time }, tokens }, parts: [] };
}

describe("usage accounting", () => {
  it("uses each response's model, counts cache once, and keeps reasoning within output", async () => {
    const messages = [answer("a", "flash", { total: 120, input: 10, output: 20, reasoning: 15, cache: { read: 80, write: 10 } }), answer("b", "v100", { total: 55, input: 5, output: 10, cache: { read: 35 } })];
    const source: UsageSource = { engine: "OpenCode", sessions: async () => [session("s1"), session("s1")], messages: async () => ({ messages }) };
    const report = await scanUsage([source], "30d", new AbortController().signal, undefined, day);
    expect(report.sessionsScanned).toBe(1);
    expect(report.totals).toMatchObject({ total: 175, input: 15, output: 30, cacheRead: 115, cacheWrite: 10, other: 5, reasoning: 15, replies: 2 });
    expect(report.models.map(x => [x.model, x.total, x.sessions])).toEqual([["flash", 120, 1], ["v100", 55, 1]]);
  });

  it("filters message time, includes child sessions and reports partial reads", async () => {
    const old = day - 40 * 86_400_000;
    const source: UsageSource = {
      engine: "OpenCode",
      sessions: async () => [session("child"), session("bad"), session("old", old)],
      messages: async (s) => {
        if (s.id === "bad") throw Error("unavailable");
        return { messages: [answer("recent", "flash", { input: 4, output: 6 }), answer("old", "flash", { input: 99 }, old)] };
      },
    };
    const report = await scanUsage([source], "7d", new AbortController().signal, undefined, day);
    expect(report.sessionsFound).toBe(2);
    expect(report.totals.total).toBe(10);
    expect(report.failures).toHaveLength(1);
    expect(periodStart("7d", day)).toBe(new Date(2026, 8, 24).getTime());
  });

  it("stops between pages on cancellation and never counts zero or duplicate assistant updates", async () => {
    const controller = new AbortController();
    const messages = vi.fn(async () => {
      controller.abort();
      return { messages: [answer("a", "m", { total: 0 })], before: "cursor" };
    });
    await expect(scanUsage([{ engine: "Pi", sessions: async () => [session("s1")], messages }], "all", controller.signal)).rejects.toBeTruthy();
    expect(messages).toHaveBeenCalledTimes(1);
    const counters = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, other: 0, reasoning: 0, replies: 0 };
    expect(addMessageUsage(counters, answer("x", "m", { total: 0 }))).toBe(0);
  });
});

// The runtime catalogue replaced the OpenCode session index (roots=false/x-next-cursor).
it("reads every active and archived runtime chat by cursor, once each, and attributes imported archives", async () => {
  const { store } = await import("../src/state/store");
  const { usageSources } = await import("../src/usage/sources");
  const fx = runtimeFixture();
  const pages: Record<string, { sessions: unknown[]; cursor: number | null }> = {
    "false:": { sessions: [session("a"), session("b")], cursor: 456 },
    "false:456": { sessions: [session("b"), { ...session("old"), origin: { kind: "opencode" } }], cursor: 456 }, // a repeated cursor ends paging
    "true:": { sessions: [{ ...session("archived"), time: { created: day, updated: day, archived: day } }], cursor: null },
  };
  fx.on("GET", "/sessions/recent", c => pages[`${c.query.archived === "true"}:${c.query.cursor ?? ""}`] ?? { sessions: [], cursor: null });
  fx.on("GET", "/sessions/:id/messages", () => ({ messages: [], before: null }));
  bindStore(store, fx);
  try {
    const [pi, opencode] = usageSources();
    const signal = new AbortController().signal;
    expect((await pi.sessions(signal)).map(s => s.id)).toEqual(["a", "b", "archived"]);
    expect((await opencode.sessions(signal)).map(s => s.id)).toEqual(["old"]);
    expect(fx.made("GET", "/sessions/recent").map(c => [c.query.archived ?? "", c.query.cursor ?? "", c.query.limit])).toEqual([["", "", "20"], ["", "456", "20"], ["true", "", "20"]]);
    await pi.messages(session("a"), "cursor-1", signal);
    expect(fx.made("GET", "/sessions/:id/messages")[0].query).toEqual({ directory: "/tmp/test", before: "cursor-1", limit: "200" });
    store.state = { ...store.state, connection: { ...store.state.connection, phase: "disconnected" } as never };
    expect(usageSources()).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});
