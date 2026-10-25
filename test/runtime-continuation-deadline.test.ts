import { afterEach, expect, it, vi } from "vitest";
import { RuntimeClient } from "../src/agent/runtime/client";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const client = () => new RuntimeClient({ endpoint: "http://127.0.0.1:4567", token: "fixture", instance: "fixture", version: "fixture", contract: 1 }, async () => { throw new Error("No credential refresh expected"); });

it("allows a25-second archive continuation and retains a bounded deadline with no POST replay", async () => {
  vi.useFakeTimers();
  let complete!: () => void;
  const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    complete = () => resolve(new Response(JSON.stringify({ id: "continued" }), { status: 200 }));
    init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  vi.stubGlobal("fetch", fetch);
  const work = client().continueLegacy("legacy-id", "/project");
  await vi.advanceTimersByTimeAsync(25000);
  expect(fetch.mock.calls[0][1].signal?.aborted).toBe(false);
  complete(); await expect(work).resolves.toEqual({ id: "continued" });
  expect(fetch).toHaveBeenCalledTimes(1);
  const timeout = client().continueLegacy("other-legacy", "/project");
  const failed = expect(timeout).rejects.toThrow("Истекло время ожидания");
  await vi.advanceTimersByTimeAsync(120001); await failed;
  expect(fetch).toHaveBeenCalledTimes(2);
});
