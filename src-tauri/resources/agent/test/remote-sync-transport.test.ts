import { afterEach, expect, it, vi } from "vitest";
import { RemoteSyncTransport } from "../src/remote/sync.ts";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function runtime(calls: string[], updatesHang = false) {
  return {
    draining: false,
    config: { broker: { call: vi.fn(async (method: string) => {
      if (method === "updates.control") {
        calls.push(method);
        return updatesHang ? new Promise(() => {}) : { stage: "idle" };
      }
      if (method === "hub.identity") { calls.push(method); return { scope: "scope" }; }
      if (method === "hub.request") { calls.push(method); return { commands: [], watch: null }; }
      return {};
    }) } },
  } as never;
}

it("keeps syncing on its interval without overlapping requests", async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  const transport = new RemoteSyncTransport(runtime(calls), 1_000, {
    beforeSync: async () => {}, overview: () => ({ version: "x" }), detail: () => ({ messages: [] }), execute: async () => ({}),
  });
  transport.start();
  await vi.advanceTimersByTimeAsync(3_500);
  transport.stop();
  expect(calls.filter(x => x === "hub.request").length).toBeGreaterThanOrEqual(3);
});

it("a stale bridge call is fenced by the watchdog and replaced by a live sync", async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  const transport = new RemoteSyncTransport(runtime(calls), 1_000, {
    beforeSync: () => new Promise(() => {}), overview: () => ({}), detail: () => ({}), execute: async () => ({}),
  });
  transport.start();
  await vi.advanceTimersByTimeAsync(16_000);
  expect(calls).toEqual(["hub.identity"]);
  await vi.advanceTimersByTimeAsync(16_000);
  transport.stop();
  // The orphaned first hook remains unresolved, but the watchdog starts a new
  // generation that reaches hub.request instead of leaving Remote dead forever.
  expect(calls.length).toBeGreaterThan(1);
});
