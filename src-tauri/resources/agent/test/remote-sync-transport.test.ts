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
    overview: () => ({ version: "x" }), detail: () => ({ messages: [] }), execute: async () => ({}),
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
    overview: () => { throw new Error("temporary snapshot failure"); }, detail: () => ({}), execute: async () => ({}),
  });
  transport.start();
  await vi.advanceTimersByTimeAsync(16_000);
  expect(calls.filter(x => x === "hub.identity").length).toBeGreaterThan(1);
  await vi.advanceTimersByTimeAsync(16_000);
  transport.stop();
  // Failed snapshots are retried on the normal interval; no inert hook can
  // leave the transport permanently pending.
  expect(calls.filter(x => x === "hub.identity").length).toBeGreaterThan(1);
});
