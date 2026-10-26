import { afterEach, expect, it, vi } from "vitest";
import { waitForMcpServer } from "../src/capabilities/connection";
import type { RuntimeServerStatus } from "../src/capabilities/registry";

afterEach(() => vi.useRealTimers());
function fixture() {
  let check = () => {};
  const state = { current: true, servers: [] as RuntimeServerStatus[], error: null as string | null };
  const stop = vi.fn(), open = vi.fn();
  return { state, stop, open, emit: () => check(), start: () => waitForMcpServer({ id: "cua-desktop", current: () => state.current,
    report: () => state, subscribe: fn => { check = fn; return stop; }, open, timeoutMs: 100 }) };
}
const connected: RuntimeServerStatus = { id: "cua-desktop", signature: "test", state: "connected", tools: ["mesh_cua_desktop_check_permissions"] };

it("opens the existing worker and waits for actual target tools, not another server or checking state", async () => {
  const f = fixture(), promise = f.start(), resolved = vi.fn();
  void promise.then(resolved);
  expect(f.open).toHaveBeenCalledOnce();
  f.state.servers = [{ ...connected, id: "other" }, { ...connected, state: "checking", tools: [] }]; f.emit();
  await Promise.resolve(); expect(resolved).not.toHaveBeenCalled();
  f.state.servers = [connected]; f.emit();
  await expect(promise).resolves.toEqual(connected); expect(f.stop).toHaveBeenCalledOnce();
});

it.each(["bridge", "server", "empty", "scope", "timeout"])("does not claim success on %s failure and unsubscribes", async mode => {
  vi.useFakeTimers();
  const f = fixture(), promise = f.start();
  const rejection = expect(promise).rejects.toThrow();
  if (mode === "bridge") f.state.error = "Мост MCP не установлен";
  if (mode === "server") f.state.servers = [{ ...connected, state: "error" }];
  if (mode === "empty") f.state.servers = [{ ...connected, tools: [] }];
  if (mode === "scope") { f.state.current = false; f.state.servers = [connected]; }
  f.emit(); if (mode === "timeout") await vi.advanceTimersByTimeAsync(100);
  await rejection; expect(f.stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
