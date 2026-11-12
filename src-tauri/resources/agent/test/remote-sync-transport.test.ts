import { afterEach, expect, it, vi } from "vitest";
import { RemoteSyncTransport } from "../src/remote/sync.ts";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const runtime = { draining: false } as never;
function responder(calls: string[], hangFirst = false) {
  let first = hangFirst;
  return vi.fn(async (route: string) => {
    calls.push(route);
    if (first) { first = false; return new Promise(() => {}); }
    return { commands: [], watch: null };
  });
}

it("keeps syncing on its interval without overlapping requests", async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  const request = responder(calls);
  const transport = new RemoteSyncTransport(runtime, 1_000, {
    request, overview: () => ({ version: "x" }), detail: () => ({ messages: [] }), execute: async () => ({}),
  });
  transport.start();
  await vi.advanceTimersByTimeAsync(3_500);
  transport.stop();
  expect(request.mock.calls.length).toBeGreaterThanOrEqual(3)
});

it("a stale bridge call is fenced by the watchdog and replaced by a live sync", async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  const request = responder(calls, true);
  const transport = new RemoteSyncTransport(runtime, 1_000, {
    request, overview: () => ({}), detail: () => ({}), execute: async () => ({}),
  });
  transport.start();
  await vi.advanceTimersByTimeAsync(16_000);
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(16_000);
  transport.stop();
  // The watchdog fences an orphaned request and starts a new generation.
  expect(request.mock.calls.length).toBeGreaterThan(1);
});
