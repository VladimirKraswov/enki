// Store glue for the single Enki Runtime: event routing, snapshot mirror,
// single-engine resolution and workspace keys. Written, NOT RUN.
import { describe, expect, it, vi } from "vitest";
import type { DialogRequestDTO, QueueStateDTO } from "../src-tauri/resources/agent/src/protocol";
import { AgentDialogs, applySnapshot, routeRuntimeEvent, type RuntimeSyncHost } from "../src/state/runtimeSync";
import { DEFAULT_ENGINE, engineForDirectory, engineForSession, engineOptions, legacyModelScope, modelScope } from "../src/state/engines";
import { isKnownBackend, workspaceKey } from "../src/agent/registry";

function host(): RuntimeSyncHost & { [K in keyof RuntimeSyncHost]: ReturnType<typeof vi.fn> } {
  return { queue: vi.fn(), replaceQueues: vi.fn(), dialog: vi.fn(), schedule: vi.fn(), notice: vi.fn(), broker: vi.fn() } as never;
}
const dialog = (id: string, directory = "/p"): DialogRequestDTO =>
  ({ id, sessionID: "s1", directory, method: "confirm", title: "?", deadline: Date.now() + 1000 });
const queue = (sessionID: string): QueueStateDTO => ({ sessionID, armed: true, pausedReason: null, items: [] });

describe("routeRuntimeEvent", () => {
  it("mirrors queue updates and keeps them away from the chat reducer", () => {
    const h = host();
    expect(routeRuntimeEvent({ type: "queue.updated", properties: { sessionID: "s1", queue: queue("s1") } }, h, new AgentDialogs())).toBe(true);
    expect(h.queue).toHaveBeenCalledWith(queue("s1"));
  });

  it("shows dialogs in arrival order and removes them only on replied/expired", () => {
    const h = host(), dialogs = new AgentDialogs();
    routeRuntimeEvent({ type: "dialog.asked", properties: { dialog: dialog("d1") } }, h, dialogs);
    routeRuntimeEvent({ type: "dialog.asked", properties: { dialog: dialog("d2") } }, h, dialogs);
    routeRuntimeEvent({ type: "dialog.asked", properties: { dialog: dialog("d1") } }, h, dialogs); // duplicate replay
    expect(dialogs.all().map(d => d.id)).toEqual(["d1", "d2"]);
    expect(h.dialog).toHaveBeenLastCalledWith(expect.objectContaining({ id: "d1" }));
    routeRuntimeEvent({ type: "dialog.expired", properties: { sessionID: "s1", requestID: "d1", by: "deadline" } }, h, dialogs);
    expect(dialogs.current()?.id).toBe("d2");
    expect(h.notice).toHaveBeenCalledWith("s1", expect.stringContaining("истёк"));
  });

  it("forwards broker relays with their id, method and params", () => {
    const h = host();
    routeRuntimeEvent({ type: "broker.request", properties: { id: "b1", method: "hub.lease", params: { a: 1 } } }, h, new AgentDialogs());
    expect(h.broker).toHaveBeenCalledWith({ id: "b1", method: "hub.lease", params: { a: 1 } });
  });

  it("reports schedule changes and removals", () => {
    const h = host(), task = { id: "t1" };
    routeRuntimeEvent({ type: "schedule.updated", properties: { sessionID: "s1", task } }, h, new AgentDialogs());
    routeRuntimeEvent({ type: "schedule.removed", properties: { sessionID: "s1", id: "t1" } }, h, new AgentDialogs());
    expect(h.schedule).toHaveBeenNthCalledWith(1, "s1", task, "t1");
    expect(h.schedule).toHaveBeenNthCalledWith(2, "s1", null, "t1");
  });

  // Replaces the retired global.disposed invalidation (config-reload.test.ts):
  // the runtime's own producer (Runtime.saveSettings) reaches a real consumer.
  it("hands validated runtime.settings to the settings consumer and drops malformed ones", () => {
    const h = { ...host(), settings: vi.fn() };
    const settings = { defaultPolicy: "full", extensionPaths: [], useUserPiResources: false, noDiscoveredExtensions: true,
      gitProgram: null, compaction: { enabled: false }, browserEnabled: true, lspEnabled: false };
    expect(routeRuntimeEvent({ type: "runtime.settings", properties: { settings } }, h, new AgentDialogs())).toBe(true);
    expect(h.settings).toHaveBeenCalledExactlyOnceWith(settings);
    expect(routeRuntimeEvent({ type: "runtime.settings", properties: { settings: { defaultPolicy: "root" } } }, h, new AgentDialogs())).toBe(true);
    expect(routeRuntimeEvent({ type: "runtime.settings", properties: {} }, h, new AgentDialogs())).toBe(true);
    expect(h.settings).toHaveBeenCalledOnce();
  });

  it("leaves chat events to the reducer", () => {
    const h = host();
    expect(routeRuntimeEvent({ type: "message.part.updated", properties: {} }, h, new AgentDialogs())).toBe(false);
    expect(routeRuntimeEvent({ type: "session.status", properties: { sessionID: "s1" } }, h, new AgentDialogs())).toBe(false);
  });
});

describe("applySnapshot", () => {
  it("is authoritative for the folder's queues and dialogs only", () => {
    const h = host(), dialogs = new AgentDialogs();
    dialogs.add(dialog("other", "/elsewhere"));
    dialogs.add(dialog("stale", "/p"));
    const snapshot = { seq: 1, instance: "i", statuses: {}, permissions: [], dialogs: [dialog("fresh", "/p")], queues: [queue("s1")], schedules: [],
      activity: { running: 0, queued: 0, pending: 0, idle: true } };
    applySnapshot(snapshot, "/p", id => id === "s2", h, dialogs);
    expect(dialogs.all().map(d => d.id)).toEqual(["other", "fresh"]);
    const [queues, scope] = h.replaceQueues.mock.calls[0] as [QueueStateDTO[], (id: string) => boolean];
    expect(queues).toEqual([queue("s1")]);
    expect(scope("s1")).toBe(true);   // listed
    expect(scope("s2")).toBe(true);   // owned by the folder, emptied while away
    expect(scope("s9")).toBe(false);  // another folder keeps its mirror
  });
});

describe("single engine", () => {
  it("resolves every folder and chat to the runtime", () => {
    expect(DEFAULT_ENGINE).toBe("pi");
    expect(engineForDirectory({}, "/work")).toBe("pi");
    expect(engineForSession({}, "ses_old", "/work")).toBe("pi");
    expect(engineForSession({}, null, null)).toBe("pi");
    expect(engineOptions({}).map(o => o.id)).toEqual(["pi"]);
  });

  it("writes plain model keys and reads former Pi keys as fallback", () => {
    expect(modelScope("pi", "session:s1")).toBe("session:s1");
    expect(legacyModelScope("session:s1")).toBe("pi::session:s1");
  });

  it("keys workspaces stably and never confuses local with remote", () => {
    expect(workspaceKey({ kind: "local" })).toBe("enki-runtime:local");
    expect(workspaceKey({ kind: "remote", host: { id: "h", name: "H", target: "me@box", port: 22 } })).toBe("ssh:me@box:22");
    expect(isKnownBackend("pi")).toBe(true);
    expect(isKnownBackend("opencode")).toBe(false);
  });
});
