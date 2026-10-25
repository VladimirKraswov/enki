// Acceptance regressions of the chat store over the runtime (shared route
// fixture). The runtime has one primary agent: the former agent-catalogue model
// step is replaced by the configured runtime model. Host switches use the real
// connectHost path with only connectRuntime replaced.
import { beforeEach, expect, it, vi } from "vitest";
import type { RuntimeFixture } from "./helpers/runtime-fixture";
const hosts = vi.hoisted(() => ({ backends: {} as Record<string, unknown> }));
vi.mock("../src/agent/registry", async (original) => ({ ...(await original<typeof import("../src/agent/registry")>()),
  connectRuntime: vi.fn(async (target: { kind: string; host?: { id: string } }) => hosts.backends[target.kind === "local" ? "local" : target.host!.id]) }));
let store: any, fx: RuntimeFixture, other: RuntimeFixture;
const deferred = () => { let resolve!: (v: unknown) => void; const promise = new Promise((r) => (resolve = r)); return { resolve, promise }; };
const emit = (event: unknown) => fx.emit(event as never, "/test/A");
beforeEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
  const fixture = await import("./helpers/runtime-fixture");
  const journal = (await import("../src/operations/journal")).operationJournal;
  vi.spyOn(journal as any, "storage").mockReturnValue({ list: async () => [], write: async () => {} });
  store = (await import("../src/state/store")).store;
  fx = fixture.runtimeFixture();
  fixture.withProvider(fx, "p", ["m"], []);
  other = fixture.runtimeFixture({ connection: { endpoint: "http://127.0.0.1:43124" }, workspace: "ssh:other:22" });
  hosts.backends = { local: fx.backend, other: other.backend };
  fx.on("POST", "/commands", c => ({ id: (c.body as { id: string }).id, kind: "prompt", sessionID: "x", state: "accepted", createdAt: 1, updatedAt: 1 }));
  store.saveRemoteHost({ id: "other", name: "Other", target: "other", port: 22 });
  expect(await store.connectLocal()).toBe(true);
  await store.setDirectory("/test/A");
});

it("resolves the configured runtime model with Medium before provider catalogue defaults", () => {
  store.state = { ...store.state, connectedProviderIds: ["deepseek", "local-qwen-next"], providerDefaults: { deepseek: "v4" },
    configModel: "local-qwen-next/qwen38-flash-next", prefs: { ...store.state.prefs, modelChoice: {} },
    providers: [{ id: "local-qwen-next", models: { "qwen38-flash-next": { id: "qwen38-flash-next", variants: { medium: {} } } } }] };
  expect(store.getModelChoice()).toEqual({ providerID: "local-qwen-next", modelID: "qwen38-flash-next", variant: "medium" });
});

it("does not submit a second prompt to a busy session", async () => {
  store.state = { ...store.state, activeSessionId: "ses_a" };
  emit({ type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } });
  store.setModelChoice("p", "m");
  expect(await store.sendPrompt("duplicate")).toBe(false);
  expect(fx.made("POST", "/commands")).toEqual([]);
});

it("late project-list responses cannot cross a changed runtime", async () => {
  const d = deferred();
  fx.on("GET", "/projects", () => d.promise);
  const pending = store.refreshProjects();
  await vi.waitFor(() => expect(fx.made("GET", "/projects").length).toBeGreaterThan(0));
  expect(await store.connectHost("other")).toBe(true);
  d.resolve([{ id: "old", worktree: "/old" }]);
  await pending;
  expect(store.state.projects).toEqual([]);
});

it("a delayed archive response cannot insert an A session into B", async () => {
  const d = deferred();
  fx.on("PATCH", "/sessions/:id", () => d.promise);
  const sess = { id: "ses_a", directory: "/test/A", title: "A", projectID: "p", time: { created: 1, updated: 1 } };
  const pending = store.archiveSession(sess);
  await store.setDirectory("/test/B");
  d.resolve({ ...sess, time: { ...sess.time, archived: 2 } });
  await pending;
  expect(store.state.archivedSessions).toEqual([]);
});

it("a history snapshot cannot erase a token delta received while it loads", async () => {
  store.state = { ...store.state, activeSessionId: "ses_a" };
  const d = deferred();
  fx.on("GET", "/sessions/:id/messages", () => d.promise);
  const pending = store.loadHistory("ses_a", "/test/A");
  const part = { id: "prt_a", sessionID: "ses_a", messageID: "msg_a", type: "text", text: "hello world" };
  emit({ type: "message.part.updated", properties: { part } });
  d.resolve({ messages: [{ info: { id: "msg_a", sessionID: "ses_a", role: "assistant", time: { created: 1 } }, parts: [{ ...part, text: "hello" }] }], before: null });
  await pending;
  expect(store.state.chat.sessions.ses_a.parts.prt_a.text).toBe("hello world");
});

it("keeps drafts and shell IDs partitioned by workspace", async () => {
  const { switchEndpointPrefs } = await import("../src/state/prefs");
  store.setDraft("draft A");
  store.setPtyId("/test/A", "pty_A");
  const b = switchEndpointPrefs(store.state.prefs, "http://127.0.0.1:43124", "ssh:other:22");
  expect(b.drafts).toEqual({});
  expect(b.ptyIds).toEqual({});
  expect(b.selectedDirectory).toBeNull();
  const a = switchEndpointPrefs(b, store.state.prefs.endpoint, store.state.prefs.workspaceKey);
  expect(a.drafts["new::/test/A"]).toBe("draft A");
  expect(a.ptyIds["/test/A"]).toBe("pty_A");
});

it("preserves a completion received before the prompt acknowledgement", async () => {
  store.state = { ...store.state, activeSessionId: "ses_a" };
  store.setModelChoice("p", "m");
  const d = deferred();
  fx.on("POST", "/commands", c => d.promise.then(() => ({ id: (c.body as { id: string }).id, kind: "prompt", sessionID: "ses_a", state: "accepted", createdAt: 1, updatedAt: 1 })));
  const pending = store.sendPrompt("task");
  await vi.waitFor(() => expect(fx.made("POST", "/commands")).toHaveLength(1));
  emit({ type: "session.status", properties: { sessionID: "ses_a", status: { type: "idle" } } });
  d.resolve(undefined);
  expect(await pending).toBe(true);
  expect(store.state.chat.sessions.ses_a.status.type).toBe("idle");
});

it("paginates beyond 200 messages with the runtime's opaque cursor without losing live output or duplicating records", async () => {
  store.state = { ...store.state, activeSessionId: "ses_a" };
  const messages = Array.from({ length: 205 }, (_, i) => ({ info: { id: `msg_${String(i).padStart(5, "0")}`, sessionID: "ses_a", role: "user", time: { created: i } }, parts: [] }));
  fx.on("GET", "/sessions/:id/messages", c => c.query.before === "opaque-next" ? { messages: messages.slice(0, 5), before: null } : { messages: messages.slice(5), before: "opaque-next" });
  await store.loadHistory("ses_a", "/test/A");
  emit({ type: "message.updated", properties: { info: { id: "msg_99999", sessionID: "ses_a", role: "assistant", time: { created: 1000 } } } });
  await store.loadOlderMessages("ses_a");
  expect(fx.made("GET", "/sessions/:id/messages").map(c => c.query.before ?? null)).toEqual([null, "opaque-next"]);
  expect(store.state.chat.sessions.ses_a.messageOrder).toHaveLength(206);
  expect(store.state.chat.sessions.ses_a.messageOrder[0]).toBe("msg_00000");
  expect(store.state.olderExhausted.ses_a).toBe(true);
});

it("does not double a delta already included in the HTTP history snapshot", async () => {
  store.state = { ...store.state, activeSessionId: "ses_a" };
  const d = deferred();
  fx.on("GET", "/sessions/:id/messages", () => d.promise);
  const part = { id: "prt_a", sessionID: "ses_a", messageID: "msg_a", type: "text", text: "hello" };
  emit({ type: "message.part.updated", properties: { part } });
  const pending = store.loadHistory("ses_a", "/test/A");
  emit({ type: "message.part.delta", properties: { sessionID: "ses_a", messageID: "msg_a", partID: "prt_a", field: "text", delta: " world" } });
  d.resolve({ messages: [{ info: { id: "msg_a", sessionID: "ses_a", role: "assistant", time: { created: 1 } }, parts: [{ ...part, text: "hello world" }] }], before: null });
  await pending;
  expect(store.state.chat.sessions.ses_a.parts.prt_a.text).toBe("hello world");
});
