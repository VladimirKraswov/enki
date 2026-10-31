// The «updates» desktop control command: the workshop's standard way to
// accept its own release without mouse input. The fake controller records the
// exact controller calls the visible Install control would have made.
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  running: false,
  installCalls: [] as boolean[],
  controller: {
    prepared: false,
    s: {
      channel: "stable" as const, busy: "", waiting: false, downloaded: false, error: "", notice: "",
      release: null as null | { available: boolean; version?: string; kind?: string; binary?: { state: string } },
      status: null as null | { nativeVersion: string; hot: { uiVersion: string }; build: { stage: string | null } },
    },
    snapshot() { return this.s; },
    async refresh() { return this.s.status; },
    async check() {
      this.s.release = { available: true, version: "2.0.99", kind: "source", binary: { state: "unavailable" } };
      this.s.status = { nativeVersion: "2.0.21", hot: { uiVersion: "2.0.21" }, build: { stage: null } };
    },
    async download() { this.s.downloaded = true; },
    async build() { this.s.status = { ...this.s.status!, build: { stage: "compiling" } }; },
    async install(running: boolean) { h.installCalls.push(running); this.s.waiting = running; },
    preparedFlag() { return this.prepared; },
    compiling() { return this.s.status?.build.stage === "compiling"; },
  },
}));
vi.mock("../src/updates/runtime", () => ({
  updates: {
    snapshot: () => h.controller.s,
    refresh: () => h.controller.refresh(),
    check: () => h.controller.check(),
    download: () => h.controller.download(),
    build: () => h.controller.build(),
    install: (running: boolean) => h.controller.install(running),
    prepared: () => h.controller.preparedFlag(),
    compiling: () => h.controller.compiling(),
  },
  agentsRunning: () => h.running,
}));

const { agentControlForTest } = await import("../src/control/bridge");
const run = (action: string) => agentControlForTest.execute("updates", { action }) as Promise<Record<string, unknown>>;

describe("desktop updates control", () => {
  it("reports an up-to-date snapshot before any release is checked", async () => {
    const status = await run("status");
    expect(status.available).toBe(false);
    expect(status.nativeVersion).toBeNull();
  });
  it("prepare checks the release and starts the local source build when no binary is ready", async () => {
    const prepared = await run("prepare");
    expect(prepared.version).toBe("2.0.99");
    expect(prepared.kind).toBe("source");
    expect(prepared.stage).toBe("compiling");
    expect(prepared.stageText).toBe("Сборка приложения");
  });
  it("apply refuses an unprepared build and defers while agents run", async () => {
    h.running = true;
    const early = await run("apply");
    expect(early.applied).toBe(false);
    expect(early.reason).toBe("not-prepared");
    h.controller.prepared = true;
    const deferred = await run("apply");
    expect(deferred.applied).toBe(false);
    expect(deferred.waiting).toBe(true);
    expect(deferred.reason).toBe("agents-running");
    expect(h.installCalls).toEqual([true]);
  });
  it("apply installs once the desktop is idle", async () => {
    h.running = false;
    h.controller.prepared = true;
    h.controller.s.release = { available: true, version: "2.0.99", kind: "source", binary: { state: "unavailable" } };
    const applied = await run("apply");
    expect(applied.applied).toBe(true);
    expect(h.installCalls.at(-1)).toBe(false);
  });
  it("rejects an unknown action without touching the controller", async () => {
    await expect(agentControlForTest.execute("updates", { action: "wipe" })).rejects.toThrow(/status, prepare or apply/);
  });
});
