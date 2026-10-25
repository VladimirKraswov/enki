// Managed browser setup for the single runtime (src/browser/integration.ts).
// The window installs/starts the native browser service and tells the runtime
// (PUT /settings browserEnabled) to attach browser tools to new sessions.
// Retired with the external engines: the OpenCode JSONC `desktop_browser`
// entry editor (comment/permission/skills preservation, reserved-name and
// foreign-executable refusal, wrapper rename migration, engine detection, MCP
// inventory POST/GET reattachment). No external agent configuration exists.
import { beforeEach, expect, it, vi } from "vitest";
import type { BrowserStatus, SetupOptions } from "../src/browser/integration";

let integration: typeof import("../src/browser/integration");
const installed: BrowserStatus = {
  supported: true, installed: true, running: true, browserOpen: false, command: "/Applications/Enki.app/Contents/MacOS/enki",
  nodeProgram: "/opt/homebrew/bin/node", skillPath: "/tmp/browser-fixture/current/skills", runtimePath: "/tmp/browser-fixture/current",
  profilePath: "/tmp/browser-fixture/profile", version: "0.0.83",
};
beforeEach(async () => { vi.resetModules(); integration = await import("../src/browser/integration"); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(options: { status?: BrowserStatus; override?: (command: string, args?: Record<string, unknown>) => unknown } = {}) {
  const order: string[] = [];
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    order.push(command === "browser_input" ? `input:${String(args?.action)}` : command);
    const changed = options.override?.(command, args);
    if (changed !== undefined) return changed;
    switch (command) {
      case "browser_status": return options.status ?? installed;
      case "browser_install": case "browser_start": return installed;
      case "browser_input": case "browser_stop": return undefined;
      default: throw new Error(`Unexpected native command: ${command}`);
    }
  });
  const syncRuntime = vi.fn(async (on: boolean) => { order.push(`runtime:${on}`); });
  const setup: SetupOptions = { local: true, preferences: { enabled: true }, current: () => true, syncRuntime };
  const run = (patch: Partial<SetupOptions> = {}) => integration.configureLocalBrowser({ ...setup, ...patch }, invoke as never);
  const calls = (name: string) => invoke.mock.calls.filter(([command]) => command === name);
  return { invoke, syncRuntime, setup, run, calls, order };
}

it("starts the service and applies environment and interaction mode before the runtime attaches tools", async () => {
  const f = fixture();
  await expect(f.run({ preferences: { enabled: true, mode: "human" } })).resolves.toEqual(installed);
  expect(f.order).toEqual(["browser_status", "browser_start", "input:preferences", "input:mode", "runtime:true"]);
  expect(f.calls("browser_input")[1][1]).toEqual({ action: "mode", args: { mode: "human" } });
  expect(integration.browserSetupSnapshot()).toMatchObject({ phase: "ready", status: installed });
});

it("never touches native services for a remote runtime", async () => {
  const f = fixture();
  await expect(f.run({ local: false })).resolves.toBeUndefined();
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.syncRuntime).not.toHaveBeenCalled();
});

it("installs only when missing and reports an install failure instead of continuing", async () => {
  const f = fixture({ status: { ...installed, installed: false }, override: c => c === "browser_install" ? { ...installed, installed: false, error: "download failed" } : undefined });
  await f.run();
  expect(f.order).toEqual(["browser_status", "browser_install"]);
  expect(integration.browserSetupSnapshot()).toMatchObject({ phase: "error", error: "download failed" });
  expect(f.syncRuntime).not.toHaveBeenCalled();
});

it("a service that does not start or a runtime that refuses the tools is an error, never ready", async () => {
  const stopped = fixture({ override: c => c === "browser_start" ? { ...installed, running: false, error: "port busy" } : undefined });
  await stopped.run();
  expect(integration.browserSetupSnapshot()).toMatchObject({ phase: "error", error: "port busy" });
  integration.invalidateBrowserSetup();
  const refused = fixture();
  refused.syncRuntime.mockRejectedValueOnce(new Error("runtime unavailable"));
  await refused.run();
  expect(integration.browserSetupSnapshot()).toMatchObject({ phase: "error", error: "runtime unavailable" });
});

it("disabled setup never installs or starts tools; it stops its own service first and detaches the runtime", async () => {
  const f = fixture({ status: { ...installed, installed: false } });
  await f.run({ preferences: { enabled: false } });
  expect(f.order).toEqual(["browser_status", "browser_stop", "runtime:false"]);
  expect(integration.browserSetupSnapshot()).toMatchObject({ phase: "disabled", status: { running: false, browserOpen: false } });
});

it("a runtime failure after disabling cannot leave a stopped browser labelled as running", async () => {
  const f = fixture();
  f.syncRuntime.mockRejectedValueOnce(new Error("runtime unavailable"));
  await f.run({ preferences: { enabled: false } });
  expect(f.calls("browser_stop")).toHaveLength(1);
  expect(integration.browserSetupSnapshot()).toMatchObject({ phase: "disabled", status: { running: false } });
});

it("coalesces parallel identical setup and reruns for changed preferences or an explicit recheck", async () => {
  const f = fixture();
  const [a, b] = [f.run(), f.run()];
  expect(a).toBe(b);
  await a;
  expect(f.calls("browser_status")).toHaveLength(1);
  await f.run();
  expect(f.calls("browser_status")).toHaveLength(1);
  await f.run({ preferences: { enabled: true, mode: "human" } });
  expect(f.calls("browser_status")).toHaveLength(2);
  integration.invalidateBrowserSetup();
  await f.run({ preferences: { enabled: true, mode: "human" } });
  expect(f.calls("browser_status")).toHaveLength(3);
});

it("an invalidated setup cannot attach runtime tools after an awaited native call", async () => {
  const gate = deferred<BrowserStatus>();
  const f = fixture({ override: c => c === "browser_start" ? gate.promise : undefined });
  const pending = f.run();
  await vi.waitFor(() => expect(f.calls("browser_start")).toHaveLength(1));
  integration.invalidateBrowserSetup();
  gate.resolve(installed);
  await pending;
  expect(f.syncRuntime).not.toHaveBeenCalled();
  expect(f.calls("browser_input")).toHaveLength(0);
});

it("a setup superseded without a successor (e.g. a host switch) settles instead of staying in progress", async () => {
  const gate = deferred<BrowserStatus>();
  let current = true;
  const f = fixture({ override: c => c === "browser_status" ? gate.promise : undefined });
  const pending = f.run({ current: () => current });
  expect(integration.browserSetupSnapshot().phase).toBe("checking");
  current = false;
  gate.resolve(installed);
  await pending;
  expect(integration.browserSetupSnapshot().phase).toBe("idle");
  expect(f.syncRuntime).not.toHaveBeenCalled();
});

it("a failure of an invalidated setup is never reported over the newer one", async () => {
  const gate = deferred<BrowserStatus>();
  let first = true;
  const f = fixture({ override: c => c === "browser_start" && first ? (first = false, gate.promise) : undefined });
  const stale = f.run();
  await vi.waitFor(() => expect(f.calls("browser_start")).toHaveLength(1));
  integration.invalidateBrowserSetup();
  const fresh = f.run({ preferences: { enabled: true, mode: "fast" } });
  await fresh;
  expect(integration.browserSetupSnapshot().phase).toBe("ready");
  gate.resolve({ ...installed, running: false, error: "stale failure" });
  await stale;
  expect(integration.browserSetupSnapshot()).toMatchObject({ phase: "ready" });
  expect(f.syncRuntime).toHaveBeenCalledTimes(1);
});
