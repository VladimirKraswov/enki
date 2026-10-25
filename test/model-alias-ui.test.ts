// Store projection of the runtime's durable post-selection model migration.
// Uses the actual RuntimeBackend/RuntimeClient route fixture; no fake agent loop,
// provider request, transition retry or automatic new user message. Written only.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session, ServerEvent } from "../src/api/types";
import type { ModelChoice } from "../src/state/modelChoice";
import type { RuntimeFixture } from "./helpers/runtime-fixture";

const OLD = { providerID: "former-opencode", modelID: "qwen-flash" };
const CANONICAL = { providerID: "sdk", modelID: "flash" };
const MANUAL = { providerID: "sdk", modelID: "manual" };
const session = (id: string, directory = "/p"): Session => ({ id, directory, projectID: directory, title: id,
  model: { providerID: OLD.providerID, id: OLD.modelID, variant: "medium" }, time: { created: 1, updated: 1 } });
const migrated = (sessionID = "a", from = OLD, to = CANONICAL): ServerEvent =>
  ({ type: "session.model_migrated", properties: { sessionID, from, to } });
const healthy = { healthy: true, version: "test", contract: 1, schema: 3, sdk: "0.85.1", node: "24", platform: "test", arch: "test",
  instance: "fixture-instance", startedAt: 1, host: "local", draining: false };
let store: any, fx: RuntimeFixture, fixture: typeof import("./helpers/runtime-fixture");
const choice = (id = "a"): ModelChoice | undefined => store.state.prefs.modelChoice[`session:${id}`];
const writes = () => fx.calls.filter(call => call.method !== "GET");

beforeEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
  fixture = await import("./helpers/runtime-fixture");
  store = (await import("../src/state/store")).store;
  fx = fixture.runtimeFixture();
  fixture.withProvider(fx, "sdk", ["flash", "manual"], ["medium", "high"]);
  fx.on("GET", "/sessions", () => [session("a"), session("b")]);
  fixture.bindStore(store, fx, { prefs: { modelChoice: { "session:a": { ...OLD, variant: "medium" }, "session:b": { ...OLD, variant: "high" },
    "/p": { ...OLD, variant: "medium" }, "*": { ...OLD, variant: null } } } });
  await store.setDirectory("/p", { sessionId: "a" });
  // Simulate a stale UI catalogue: the persisted old selector is still visible
  // although the runtime has resolved its missing SDK provider to another route.
  store.state = { ...store.state, connectedProviderIds: [...store.state.connectedProviderIds, OLD.providerID] };
  store.setDraft("keep this draft");
});
afterEach(() => { store?.dispose(); });

it("projects only the matching session override, preserving variant, current request, defaults and chat messages", () => {
  const defaults = { folder: store.state.prefs.modelChoice["/p"], global: store.state.prefs.modelChoice["*"], other: choice("b") };
  const chat = store.state.chat, revision = store.modelSelectionRevision;
  const operation = store.beginSending();
  store.state = { ...store.state, ui: { ...store.state.ui, sendError: "keep request error" } };
  expect(store.getModelChoice()).toEqual({ ...OLD, variant: "medium" });
  fx.emit(migrated(), "/p");
  expect(choice()).toEqual({ ...CANONICAL, variant: "medium" });
  expect(store.getModelChoice()).toEqual({ ...CANONICAL, variant: "medium" });
  expect(store.state.prefs.modelChoice["/p"]).toBe(defaults.folder);
  expect(store.state.prefs.modelChoice["*"]).toBe(defaults.global);
  expect(choice("b")).toBe(defaults.other);
  expect(store.state.chat).toBe(chat);
  expect(store.getDraft()).toBe("keep this draft");
  expect(store.state.ui).toMatchObject({ sending: true, sendError: "keep request error", toast: expect.stringContaining("flash") });
  expect(store.modelSelectionRevision).toBe(revision);
  expect(store.finishSending(operation)).toBe(true); // the same in-flight submission still owns completion
  expect(writes()).toEqual([]);
});

it("uses the latest variant and preserves a newer explicit manual model", () => {
  store.setModelChoice(OLD.providerID, OLD.modelID, "high");
  fx.emit(migrated(), "/p");
  expect(choice()).toEqual({ ...CANONICAL, variant: "high" });
  store.setModelChoice(MANUAL.providerID, MANUAL.modelID, null);
  const before = store.state;
  fx.emit(migrated(), "/p");
  expect(store.state).toBe(before);
  expect(choice()).toEqual({ ...MANUAL, variant: null });
  expect(writes()).toEqual([]);
});

it("honours plain-before-pi:: session precedence and makes replay silent without modifying the legacy key", () => {
  const legacy = { ...OLD, variant: "high" };
  const choices = { ...store.state.prefs.modelChoice, "pi::session:a": legacy };
  delete choices["session:a"];
  store.state = { ...store.state, prefs: { ...store.state.prefs, modelChoice: choices } };
  store.startGlobalStream(fx.backend, store.connectionGeneration);
  fx.emit(migrated(), "/p");
  expect(choice()).toEqual({ ...CANONICAL, variant: "high" });
  expect(store.state.prefs.modelChoice["pi::session:a"]).toBe(legacy);
  store.state = { ...store.state, ui: { ...store.state.ui, toast: "keep newer notice" } };
  const after = store.state;
  fx.emit(migrated(), "/p");
  fx.emitGlobal(migrated(), "/p");
  expect(store.state).toBe(after);
  store.setModelChoice(MANUAL.providerID, MANUAL.modelID, "medium");
  const manual = store.state;
  fx.emitGlobal(migrated(), "/p");
  expect(store.state).toBe(manual); // legacy alias must not override the plain manual choice
  expect(store.getModelChoice()).toEqual({ ...MANUAL, variant: "medium" });
  expect(writes()).toEqual([]);
});

it.each(["folder", "global", "pi-folder", "projectless"])("creates only a session override from an exact old %s choice", (source) => {
  const key = source === "global" ? "*" : source === "pi-folder" ? "pi::/p" : source === "projectless" ? "@chats" : "/p";
  const inherited = { ...OLD, variant: "high" };
  const choices = { [key]: inherited, "session:b": { ...MANUAL, variant: "medium" } };
  store.state = { ...store.state, prefs: { ...store.state.prefs, modelChoice: choices,
    ...(source === "projectless" ? { projectlessDirectories: ["/p"] } : {}) } };
  const before = { ...choices };
  fx.emit(migrated(), "/p");
  expect(store.state.prefs.modelChoice).toEqual({ ...before, "session:a": { ...CANONICAL, variant: "high" } });
  expect(store.state.prefs.modelChoice[key]).toBe(inherited);
  expect(store.getModelChoice()).toEqual({ ...CANONICAL, variant: "high" });
  expect(writes()).toEqual([]);
});

it("does not override a different inherited choice, and a background migration never changes the open chat or its notice", () => {
  const choices = { "/p": { ...MANUAL, variant: "high" }, "session:b": { ...OLD, variant: "medium" } };
  store.state = { ...store.state, prefs: { ...store.state.prefs, modelChoice: choices }, ui: { ...store.state.ui, toast: "open chat notice" } };
  const before = store.state;
  fx.emit(migrated(), "/p");
  expect(store.state).toBe(before);
  fx.emit(migrated("b"), "/p");
  expect(choice("b")).toEqual({ ...CANONICAL, variant: "medium" });
  expect(choice("a")).toBeUndefined();
  expect(store.state.activeSessionId).toBe("a");
  expect(store.state.ui.toast).toBe("open chat notice");
  expect(store.state.prefs.modelChoice["/p"]).toBe(choices["/p"]);
});

it("projects a known background folder only with its exact global-stream directory envelope", () => {
  store.startGlobalStream(fx.backend, store.connectionGeneration);
  store.state = { ...store.state, projectSessionLists: { "/q": { sessions: [session("q", "/q")], loading: false, loaded: true, error: null, limit: 50, hasMore: false } },
    prefs: { ...store.state.prefs, modelChoice: { ...store.state.prefs.modelChoice, "session:q": { ...OLD, variant: null } } } };
  const before = store.state;
  fx.emitGlobal(migrated("q"));
  fx.emitGlobal(migrated("q"), "/p");
  fx.emitGlobal(migrated("unknown"), "/q");
  expect(store.state).toBe(before);
  fx.emitGlobal(migrated("q"), "/q");
  expect(choice("q")).toEqual({ ...CANONICAL, variant: null });
  expect(choice("a")).toEqual({ ...OLD, variant: "medium" });
  expect(store.state.directory).toBe("/p");
  expect(writes()).toEqual([]);
});

it("rejects malformed payloads, wrong known-directory and read-only archive events without reads or writes", () => {
  const good = migrated().properties;
  const payloads: unknown[] = [null, [], {}, { ...good, sessionID: "unknown" }, { ...good, sessionID: 42 },
    { ...good, from: [] }, { ...good, to: { providerID: "", modelID: "flash" } },
    { ...good, from: { ...OLD, variant: "high" } }, { ...good, to: { ...CANONICAL, modelID: "x".repeat(1025) } },
    { ...good, to: { ...CANONICAL, providerID: "bad\nprovider" } }, { ...good, to: OLD }, { ...good, extra: true }];
  const before = store.state, calls = fx.calls.length;
  for (const properties of payloads) fx.emit({ type: "session.model_migrated", properties } as ServerEvent, "/p");
  expect(store.state).toBe(before);
  expect(fx.calls).toHaveLength(calls);
  store.startGlobalStream(fx.backend, store.connectionGeneration);
  fx.emitGlobal(migrated(), "/wrong");
  expect(store.state).toBe(before);
  store.state = { ...store.state, sessions: store.state.sessions.map((s: Session) => s.id === "a" ? { ...s, origin: { kind: "opencode" } } : s) };
  const archive = store.state;
  fx.emit(migrated(), "/p");
  expect(store.state).toBe(archive);
});

it("accepts the runtime's canonical selector even before the UI catalogue catches up", () => {
  const fresh = { providerID: "new-runtime-provider", modelID: "new-canonical-route" };
  fx.emit(migrated("a", OLD, fresh), "/p");
  expect(choice()).toEqual({ ...fresh, variant: "medium" });
  expect(store.state.ui.toast).toContain("new-canonical-route");
  // Normal catalogue refresh subsequently makes the same stored selector renderable.
  store.state = { ...store.state, connectedProviderIds: [...store.state.connectedProviderIds, fresh.providerID] };
  expect(store.getModelChoice()).toEqual({ ...fresh, variant: "medium" });
  expect(writes()).toEqual([]);
});

it("drops events from a replaced host even for the same session/directory, and drops stale connection or folder generations", () => {
  const old = fx.directoryStreams.at(-1)!;
  store.startGlobalStream(fx.backend, store.connectionGeneration);
  const global = fx.globalStreams.at(-1)!;
  const other = fixture.runtimeFixture({ connection: { endpoint: "http://127.0.0.1:43124", instance: "host-b" }, workspace: "ssh:other:22" });
  fixture.bindStore(store, other);
  const hostB = store.state;
  old.subscription.onEvent(migrated());
  global.onEvent({ directory: "/p", payload: migrated() });
  expect(store.state).toBe(hostB);
  expect(choice()).toEqual({ ...OLD, variant: "medium" });
  expect(other.calls).toEqual([]);
  fixture.bindStore(store, fx);
  store.connectionGeneration++;
  const reconnected = store.state;
  old.subscription.onEvent(migrated());
  expect(store.state).toBe(reconnected);
  store.startEventStream("/p", store.directoryGeneration);
  const current = fx.directoryStreams.at(-1)!;
  store.directoryGeneration++;
  current.subscription.onEvent(migrated());
  expect(store.state).toBe(reconnected);
});

it("leaves an in-flight manual selection intact; its later result wins over the automatic preference projection", async () => {
  let answer!: (value: unknown) => void;
  fx.on("GET", "/health", () => new Promise(resolve => { answer = resolve; }));
  fx.on("POST", "/commands", call => ({ id: (call.body as { id: string }).id, kind: "model.transition", sessionID: "a", state: "completed", createdAt: 1, updatedAt: 1 }));
  const beforeCalls = fx.made("GET", "/health").length;
  const selecting = store.selectModel(MANUAL.providerID, MANUAL.modelID, "high");
  await vi.waitFor(() => expect(fx.made("GET", "/health").length).toBeGreaterThan(beforeCalls));
  const revision = store.modelSelectionRevision;
  fx.emit(migrated(), "/p");
  expect(store.modelSelectionRevision).toBe(revision);
  expect(choice()).toEqual({ ...CANONICAL, variant: "medium" });
  answer(healthy);
  expect(await selecting).toBe(true);
  expect(choice()).toEqual({ ...MANUAL, variant: "high" });
  expect(fx.made("POST", "/commands").map(c => c.body)).toEqual([expect.objectContaining({ kind: "model.transition", payload: expect.objectContaining({ model: { ...MANUAL, variant: "high" } }) })]);
  expect(store.getDraft()).toBe("keep this draft");
});
