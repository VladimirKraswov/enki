// Owned terminals and update safety: a running shell blocks maintenance; closing
// it is bounded and responsive, but the primary's exit never claims tree cleanup
// or idleness — only an explicit detach (which proves nothing) releases it.
// Output silence is not idleness.
// An in-memory node-pty module is injected; no shell or profile is spawned.
import { afterEach, expect, it } from "vitest";
import { PtyService, type NativePty, type PtyModule } from "../src/platform/pty.ts";
import { projectToolEnvironment, sdkProfileDirectory } from "../src/platform/environment.ts";
import { harness, type Harness } from "./helpers.ts";

class FakePty implements NativePty {
  pid = 4242;
  killed = 0;
  failKill = false;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number }) => void>();
  onData(listener: (data: string) => void) { this.dataListeners.add(listener); return { dispose: () => { this.dataListeners.delete(listener); } }; }
  onExit(listener: (event: { exitCode: number }) => void) { this.exitListeners.add(listener); return { dispose: () => { this.exitListeners.delete(listener); } }; }
  write(): void {}
  resize(): void {}
  kill(): void { this.killed++; if (this.failKill) throw new Error("EPERM"); }
  emit(data: string): void { for (const listener of this.dataListeners) listener(data); }
  exit(code = 0): void { for (const listener of [...this.exitListeners]) listener({ exitCode: code }); }
}

function fakeModule(): { spawned: FakePty[]; load: () => Promise<PtyModule> } {
  const spawned: FakePty[] = [];
  const module: PtyModule = { spawn: () => { const pty = new FakePty(); spawned.push(pty); return pty; } };
  return { spawned, load: async () => module };
}

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

const IDLE = { running: 0, starting: 0, unconfirmed: 0, closing: 0, cleanupUnknown: 0 };

// Remainder review: the SDK profile overrides (installed before any SDK import)
// must not leak into the owner's interactive shell.
it("the user's terminal gets the host's original Pi/ADC variables, never the bundled SDK profile", async () => {
  const seen: Array<Record<string, string>> = [];
  const module: PtyModule = { spawn: (_file, _args, options) => { seen.push(options.env); return new FakePty(); } };
  const pty = new PtyService(async () => module);
  await pty.create("/project");
  const expected = projectToolEnvironment(process.env);
  for (const key of ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "GOOGLE_APPLICATION_CREDENTIALS"]) expect(seen[0][key]).toBe(expected[key]);
  const profile = sdkProfileDirectory();
  if (profile && expected.PI_CODING_AGENT_DIR !== profile) expect(seen[0].PI_CODING_AGENT_DIR).not.toBe(profile);
  expect(seen[0].TERM).toBe("xterm-256color");
  expect(Object.keys(seen[0]).some((key) => key.startsWith("ENKI_RUNTIME_"))).toBe(false);
});

it("a closed shell's primary exit proves only the primary: cleanup stays unknown until an explicit detach", async () => {
  const fake = fakeModule();
  const pty = new PtyService(fake.load);
  expect(pty.activity()).toEqual(IDLE);
  const info = await pty.create("/project", "Enki", { cols: 80, rows: 24 });
  // No output at all: still running, never assumed idle.
  expect(pty.activity()).toEqual({ ...IDLE, running: 1 });
  pty.kill(info.id, "/project");
  expect(fake.spawned[0].killed).toBe(1);
  expect(pty.list("/project")).toEqual([]);
  expect(pty.activity()).toEqual({ ...IDLE, unconfirmed: 1, closing: 1 });
  fake.spawned[0].exit(0);
  // Documented node-pty 1.1 limitation: SIGHUP-ignoring descendants may survive
  // kill(); onExit is not evidence of tree cleanup, so this is NOT idle.
  expect(pty.activity()).toEqual({ ...IDLE, unconfirmed: 1, cleanupUnknown: 1 });
  expect(pty.closingList("/project")).toEqual([expect.objectContaining({ id: info.id, state: "cleanup-unknown", primaryExited: true, exitCode: 0 })]);
  expect(() => pty.detach(info.id, "/other")).toThrow(); // directory-scoped
  // Detach relinquishes ownership and says so; nothing is signalled again.
  expect(pty.detach(info.id, "/project")).toEqual({ id: info.id, detached: true, cleanup: "unknown", primaryExited: true });
  expect(fake.spawned[0].killed).toBe(1);
  expect(pty.activity()).toEqual(IDLE);
});

it("a shell that exited by itself is idle; a failed kill stays unknown", async () => {
  const fake = fakeModule();
  const pty = new PtyService(fake.load);
  await pty.create("/project");
  const second = await pty.create("/project");
  fake.spawned[0].emit("done\r\n");
  fake.spawned[0].exit(0);
  expect(pty.activity().running).toBe(1);
  fake.spawned[1].failKill = true;
  pty.kill(second.id, "/project");
  expect(pty.activity()).toEqual({ ...IDLE, unconfirmed: 1, cleanupUnknown: 1 });
  expect(pty.closingList("/project")[0]).toMatchObject({ state: "cleanup-unknown", primaryExited: false });
});

it("closing is bounded: no exit within the deadline becomes cleanup-unknown without a second signal", async () => {
  const fake = fakeModule();
  const pty = new PtyService(fake.load, 20);
  const info = await pty.create("/project");
  pty.kill(info.id, "/project");
  expect(pty.closingList("/project")[0].state).toBe("closing");
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(pty.closingList("/project")[0]).toMatchObject({ state: "cleanup-unknown", primaryExited: false });
  expect(fake.spawned[0].killed).toBe(1); // a possibly reaped PID is never signalled again
  pty.kill(info.id, "/project"); // repeated close of a hidden shell is a no-op
  expect(fake.spawned[0].killed).toBe(1);
  // A late primary exit is recorded but still proves nothing about descendants.
  fake.spawned[0].exit(0);
  expect(pty.activity()).toEqual({ ...IDLE, unconfirmed: 1, cleanupUnknown: 1 });
  pty.shutdown();
});

it("the admission fence refuses new shells, including one still loading the module", async () => {
  const fake = fakeModule();
  let release!: () => void;
  const loaded = new Promise<void>(resolve => { release = resolve; });
  const pty = new PtyService(async () => { await loaded; return fake.load(); });
  const pending = pty.create("/project");
  expect(pty.activity().starting).toBe(1);
  pty.setAdmission(false);
  release();
  await expect(pending).rejects.toThrow(/обслуживание/);
  expect(fake.spawned).toHaveLength(0);
  expect(pty.activity()).toEqual(IDLE);
  await expect(pty.create("/project")).rejects.toThrow(/обслуживание/);
  pty.setAdmission(true);
  await pty.create("/project");
  expect(fake.spawned).toHaveLength(1);
});

it("Runtime.activity reports an owned terminal as not idle over HTTP", async () => {
  const fake = fakeModule();
  h = await harness({ ptyModule: fake.load });
  const dir = h.project("pty");
  const created = await h.request<{ id: string }>("POST", "/pty", { directory: dir, cols: 80, rows: 24 });
  expect(created.status).toBe(200);
  const busy = await h.request<{ idle: boolean; terminals: number; quiescent: boolean }>("GET", "/runtime/idle");
  expect(busy.body).toMatchObject({ idle: false, terminals: 1 });
  // Quit drain does not wait for a shell (shutdown terminates it), update idle does.
  expect(busy.body.quiescent).toBe(true);
  // Close returns at once (responsive), it does not wait for the process.
  expect((await h.request("DELETE", `/pty/${created.body.id}?directory=${encodeURIComponent(dir)}`)).status).toBe(204);
  expect((await h.request<{ idle: boolean }>("GET", "/runtime/idle")).body.idle).toBe(false);
  fake.spawned[0].exit(0);
  // Primary exit is not tree cleanup: still owned, still not idle, actionable.
  expect((await h.request<{ idle: boolean; terminals: number }>("GET", "/runtime/idle")).body).toMatchObject({ idle: false, terminals: 1 });
  const closing = await h.request<Array<{ id: string; state: string; detail: string }>>("GET", `/pty/closing?directory=${encodeURIComponent(dir)}`);
  expect(closing.body).toEqual([expect.objectContaining({ id: created.body.id, state: "cleanup-unknown" })]);
  expect(closing.body[0].detail).toMatch(/Отсоединить/);
  const detached = await h.request<{ cleanup: string }>("POST", `/pty/${created.body.id}/detach`, { directory: dir });
  expect(detached.body.cleanup).toBe("unknown");
  expect((await h.request<{ idle: boolean; terminals: number }>("GET", "/runtime/idle")).body).toMatchObject({ idle: true, terminals: 0 });
  expect((await h.request("POST", `/pty/${created.body.id}/detach`, { directory: dir })).status).toBe(404);
});

it("the obsolete self-waiting HTTP drain is gone", async () => {
  h = await harness();
  expect((await h.request("POST", "/runtime/drain", { deadlineMs: 10 })).status).toBe(404);
});
