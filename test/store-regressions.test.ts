// Store regressions over the single Enki Runtime, via the shared route fixture
// (the production RuntimeBackend/RuntimeClient; only the loopback wire is in
// memory). Prompts are durable commands: POST /commands {id, kind:"prompt"}.
//
// Preparation gates use the current local readiness seam (ensureLocal); the
// removed UI Hub reserve/ensure orchestration is not reintroduced.
//
// Moved to their actual owners (not re-implemented here):
//  - Hub readiness/lease before dispatch, Stop while Hub loads → runtime
//    test/integration/cancel-and-hub.test.ts, model-context-hub.test.ts;
//  - all scheduled-task delivery cases (runScheduledTask is gone) → runtime
//    test/scheduler-unit.test.ts and test/integration/schedules.test.ts;
//  - Pi follow-up restoration after a cleared SDK queue → runtime
//    PromptQueue.restoreUndelivered (queue-unit / integration queue);
//  - engine routing (OpenCode vs Pi listing/stream/access) → retired: one engine.
import { beforeEach, expect, it, vi } from "vitest";
import type { RuntimeFixture } from "./helpers/runtime-fixture";

let store: any, fx: RuntimeFixture, fixture: typeof import("./helpers/runtime-fixture");
const session = (id: string, directory = "/test/A") => ({ id, directory, title: id, projectID: "test", time: { created: 1, updated: 1 } });
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
const commands = () => fx.made("POST", "/commands").map(c => c.body as { id: string; kind: string; sessionID: string; directory: string; payload: { parts: Array<Record<string, unknown>>; model: Record<string, unknown> } });
const accepted = (id: string) => ({ id, kind: "prompt", sessionID: "x", state: "accepted", createdAt: 1, updatedAt: 1 });
let sessions: Record<string, unknown[]>;
beforeEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  fixture = await import("./helpers/runtime-fixture");
  const journal = (await import("../src/operations/journal")).operationJournal;
  // Native journal durability is fault-tested separately; a mocked host has no SQLite IPC.
  vi.spyOn(journal as any, "storage").mockReturnValue({ list: async () => [], write: async () => {} });
  store = (await import("../src/state/store")).store;
  fx = fixture.runtimeFixture();
  fixture.withProvider(fx, "local-qwen-next", ["qwen38-flash-next"], ["low", "medium"]);
  sessions = { "/test/A": [], "/test/B": [] };
  fx.on("GET", "/sessions", c => sessions[c.query.directory] ?? []);
  fx.on("POST", "/commands", c => accepted((c.body as { id: string }).id));
  fx.on("POST", "/sessions/:id/stop", () => ({ stopped: true }));
  fixture.bindStore(store, fx);
  await store.setDirectory("/test/A");
});
const choose = (sessionId: string | null, variant = "medium") => {
  if (sessionId) store.state = { ...store.state, activeSessionId: sessionId, sessions: [session(sessionId)] };
  store.setModelChoice("local-qwen-next", "qwen38-flash-next", variant);
};
const stream = (directory = "/test/A") => fx.directoryStreams.filter(s => s.directory === directory && !s.subscription.signal.aborted).at(-1)!.subscription;

it("R1: session.created must not invalidate the current project stream", async () => {
  const before = stream();
  fx.emit({ type: "session.created", properties: { info: session("ses_new") } } as never, "/test/A");
  await flush();
  expect(before.signal.aborted).toBe(false);
  fx.emit({ type: "message.updated", properties: { info: { id: "msg_new", sessionID: "ses_new", role: "user", time: { created: 2 } } } } as never, "/test/A");
  expect(store.state.chat.sessions.ses_new?.messages.msg_new).toBeDefined();
});

it("R2: an explicit agent selection overrides the old session agent", () => {
  store.state = { ...store.state, activeSessionId: "ses_a", sessions: [{ ...session("ses_a"), agent: "build" }] };
  store.setAgentOverride("/test/A", "plan");
  expect(store.getAgentChoice()).toBe("plan");
});

it("R3: a late session creation from project A is not selected inside project B", async () => {
  let resolve!: (value: unknown) => void;
  fx.on("POST", "/sessions", () => new Promise(r => { resolve = r; }));
  const pending = store.createSessionNow("A task");
  await vi.waitFor(() => expect(fx.made("POST", "/sessions")).toHaveLength(1));
  await store.setDirectory("/test/B");
  resolve(session("ses_a"));
  await pending;
  expect(store.state.directory).toBe("/test/B");
  expect(store.state.activeSessionId).not.toBe("ses_a");
  expect(store.state.sessions.some((s: { id: string }) => s.id === "ses_a")).toBe(false);
  expect(fx.made("POST", "/sessions")[0].body).toMatchObject({ directory: "/test/A" });
});

it("R4: a reconnect replaces stale busy status with the runtime's authoritative idle", async () => {
  sessions["/test/A"] = [session("ses_a")];
  fx.emit({ type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } } as never, "/test/A");
  store.state = { ...store.state, activeSessionId: "ses_a", sessions: [session("ses_a")] };
  expect(store.isRunning("ses_a")).toBe(true);
  fx.on("GET", "/sessions/status", () => ({}));
  stream().onState("open");
  await vi.waitFor(() => expect(store.state.chat.sessions.ses_a.status.type).toBe("idle"));
});

it("a reconnect of one project cannot erase running work of another project", async () => {
  const { emptySessionChat } = await import("../src/state/chatReducer");
  sessions["/test/B"] = [session("ses_other", "/test/B")];
  await store.setDirectory("/test/B");
  await store.setDirectory("/test/A");
  store.state.chat.sessions = {
    ses_other: { ...emptySessionChat(), status: { type: "busy" } },
    ses_stale: { ...emptySessionChat(), status: { type: "busy" } },
  };
  stream().onState("open");
  await vi.waitFor(() => expect(store.state.chat.sessions.ses_stale.status.type).toBe("idle"));
  expect(store.state.chat.sessions.ses_other.status.type).toBe("busy");
});

// The window's only preparation step before POST /commands is the local
// model-service readiness seam (`modelServices.ensureLocal`, store.sendPrompt);
// Hub readiness and the whole-turn lease belong to the runtime dispatcher.
const gateEnsure = async () => {
  const { modelServices } = await import("../src/models/services");
  const ready: Array<() => void> = [];
  vi.spyOn(modelServices, "ensureLocal").mockImplementation(() => new Promise<void>(resolve => { ready.push(resolve); }));
  return ready;
};

// The permanent release authorization is runtime turn policy (system prompt,
// re-read per turn: agent test/turn-policy.test.ts "re-reads the workshop flag
// per turn…"). The window sends only the user's own words, never a duplicate.
it("workshop manual requests carry only the user's text; the runtime owns the release authorization", async () => {
  const s = session("workshop"); choose("workshop");
  store.state.prefs.workshop = { directory: s.directory, sourceDirectory: "/source", session: s };
  store.setDraft("Исправь цвет");
  expect(await store.sendPrompt("Исправь цвет")).toBe(true);
  const [command] = commands();
  expect(command.payload.parts).toEqual([{ type: "text", text: "Исправь цвет" }]);
  expect(command.payload.model.variant).toBe("medium");
  expect(store.getDraft()).toBe("");
});

it("Stop during manual preparation prevents a late command and retains the draft", async () => {
  choose("ses_a"); store.setDraft("keep this draft");
  const ready = await gateEnsure();
  const sending = store.sendPrompt("keep this draft");
  await vi.waitFor(() => expect(ready).toHaveLength(1));
  await store.stopSession("ses_a");
  ready[0]();
  expect(await sending).toBe(false);
  expect(commands()).toEqual([]);
  expect(store.getDraft()).toBe("keep this draft");
  expect(fx.made("POST", "/sessions/:id/stop").map(c => [c.params.id, c.query.directory])).toEqual([["ses_a", "/test/A"]]);
});

it("leaving and returning to a chat invalidates its unfinished preparation", async () => {
  choose("ses_a");
  const ready = await gateEnsure();
  const sending = store.sendPrompt("old preparation");
  await vi.waitFor(() => expect(ready).toHaveLength(1));
  await store.selectSession("ses_b"); await store.selectSession("ses_a");
  ready[0]();
  expect(await sending).toBe(false);
  expect(commands()).toEqual([]);
});

it("completion of a cancelled preparation cannot unlock or redirect a newer send in another chat", async () => {
  choose("ses_a");
  const ready = await gateEnsure();
  const old = store.sendPrompt("old");
  await vi.waitFor(() => expect(ready).toHaveLength(1));
  await store.selectSession("ses_b");
  choose("ses_b");
  const current = store.sendPrompt("current");
  await vi.waitFor(() => expect(ready).toHaveLength(2));
  ready[0](); await old;
  expect(store.state.ui.sending).toBe(true);
  ready[1]();
  expect(await current).toBe(true);
  expect(commands().map(c => c.sessionID)).toEqual(["ses_b"]);
  expect(store.state.ui.sending).toBe(false);
});

it("Stop after the command was sent keeps acknowledgement ownership and clears only the submitted draft", async () => {
  choose("ses_a"); store.setDraft("submitted");
  let acknowledge!: () => void;
  fx.on("POST", "/commands", c => new Promise(r => { acknowledge = () => r(accepted((c.body as { id: string }).id)); }));
  const sending = store.sendPrompt("submitted");
  await vi.waitFor(() => expect(commands()).toHaveLength(1));
  await store.stopSession("ses_a");
  expect(store.state.ui.sending).toBe(true);
  acknowledge();
  expect(await sending).toBe(true);
  expect(store.getDraft()).toBe("");
  expect(store.state.ui.sending).toBe(false);
  expect(commands()).toHaveLength(1);
});

it("a failed preparation keeps the draft and sends nothing", async () => {
  choose("ses_a"); store.setDraft("own draft");
  const { modelServices } = await import("../src/models/services");
  vi.spyOn(modelServices, "ensureLocal").mockRejectedValue(new Error("Сервис модели недоступен"));
  expect(await store.sendPrompt("own draft")).toBe(false);
  expect(commands()).toEqual([]);
  expect(store.getDraft()).toBe("own draft");
  expect(store.state.ui.sendError).toContain("Сервис модели недоступен");
});

it("a refused first command after creating the chat leaves the prompt in that chat's draft", async () => {
  store.state = { ...store.state, activeSessionId: null, sessions: [] };
  store.setModelChoice("local-qwen-next", "qwen38-flash-next", "medium");
  store.setDraft("preserve first prompt");
  fx.on("POST", "/sessions", () => session("ses_created"));
  fx.on("POST", "/commands", c => ({ ...accepted((c.body as { id: string }).id), state: "rejected", error: "Модель недоступна" }));
  expect(await store.sendPrompt("preserve first prompt")).toBe(false);
  expect(store.state.activeSessionId).toBe("ses_created");
  expect(store.getDraft()).toBe("preserve first prompt");
  expect(store.state.ui.sendError).toContain("Модель недоступна");
});

it("waits for local browser tools before delivering the first prompt, and stages image context under the command id", async () => {
  const images = await import("../src/images/context");
  const staged = vi.spyOn(images, "stageImagePromptContext").mockResolvedValue(undefined);
  const platform = await import("../src/native/platform");
  vi.spyOn(platform, "isNative").mockReturnValue(true);
  choose("ses_a");
  store.state = { ...store.state, prefs: { ...store.state.prefs, browser: { enabled: true } } };
  let resolve!: () => void;
  const setup = vi.spyOn(store, "configureBrowser").mockReturnValue(new Promise<void>(r => { resolve = r; }));
  const pending = store.sendPrompt("Use the built-in browser");
  await vi.waitFor(() => expect(setup).toHaveBeenCalledOnce());
  expect(commands()).toEqual([]);
  resolve(); expect(await pending).toBe(true);
  expect(commands()).toHaveLength(1);
  expect(staged).toHaveBeenCalledWith(expect.objectContaining({ engine: "pi", sessionId: "ses_a", directory: "/test/A", parts: [], local: true }));
  expect(staged.mock.calls[0][0].messageId).toBe(commands()[0].id);
});

it("stops a session with its own project directory, not whichever project is open", async () => {
  sessions["/test/B"] = [session("ses_other", "/test/B")];
  await store.setDirectory("/test/B");
  await store.setDirectory("/test/A");
  await store.stopSession("ses_other");
  expect(fx.made("POST", "/sessions/:id/stop").map(c => [c.params.id, c.query.directory])).toEqual([["ses_other", "/test/B"]]);
});

it("routes a stop to the project the chat was created in, not the one now open", async () => {
  store.state = { ...store.state, activeSessionId: null, sessions: [] };
  store.setModelChoice("local-qwen-next", "qwen38-flash-next", "medium");
  fx.on("POST", "/sessions", () => session("ses_created", "/test/A"));
  expect(await store.sendPrompt("long task")).toBe(true);
  expect(store.state.activeSessionId).toBe("ses_created");
  await store.setDirectory("/test/B");
  await store.stopSession("ses_created");
  expect(fx.made("POST", "/sessions/:id/stop").map(c => [c.params.id, c.query.directory])).toEqual([["ses_created", "/test/A"]]);
});

const providers = (variants: Record<string, object>) => [{ id: "local-qwen-next", models: { "qwen38-flash-next": { id: "qwen38-flash-next", providerID: "local-qwen-next", capabilities: { reasoning: true }, variants } } }];

it("the browser profile selects a real Low only in the explicit chat and preserves the manual Medium", async () => {
  choose("ses_a");
  store.state = { ...store.state, providers: providers({ low: {}, medium: {} }) };
  const beforeGlobal = store.state.prefs.modelChoice["*"];
  store.setBrowserTask(true);
  expect(store.getModelChoice().variant).toBe("low");
  expect(await store.sendPrompt("Navigate the fixture")).toBe(true);
  expect(commands()[0].payload.model.variant).toBe("low");
  expect(store.state.prefs.modelChoice["*"]).toEqual(beforeGlobal);
  store.state.chat.sessions.ses_a = { ...store.state.chat.sessions.ses_a, status: { type: "idle" } };
  store.setModelChoice("local-qwen-next", "qwen38-flash-next", "medium");
  store.setBrowserTask(false);
  expect(store.getModelChoice().variant).toBe("medium");
  store.state = { ...store.state, activeSessionId: "ses_b" };
  expect(store.browserTaskActive()).toBe(false);
});

it("never substitutes an unsupported Low and does not change a running browser chat", () => {
  choose("ses_a");
  store.state = { ...store.state, providers: providers({ medium: {} }) };
  store.setBrowserTask(true);
  expect(store.getModelChoice().variant).toBe("medium");
  store.state.chat.sessions.ses_a = { ...store.state.chat.sessions.ses_a, status: { type: "busy" } };
  store.setBrowserTask(false);
  expect(store.browserTaskActive()).toBe(true);
});

it("retains an explicit manual Low when the browser profile is disabled", () => {
  choose("ses_a");
  store.state = { ...store.state, providers: providers({ low: {}, medium: {} }) };
  store.setBrowserTask(true);
  store.setModelChoice("local-qwen-next", "qwen38-flash-next", "low");
  store.setBrowserTask(false);
  expect(store.getModelChoice().variant).toBe("low");
});

it("starts the browser before exposing a newly created browser task panel", async () => {
  const integration = await import("../src/browser/integration");
  vi.spyOn(store, "ensureChatWorkspace").mockImplementation(async () => { await store.setDirectory("/test/browser-owned"); return true; });
  vi.spyOn(store, "createSessionNow").mockImplementation(async () => { store.state.activeSessionId = "browser-test"; return session("browser-test", "/test/browser-owned"); });
  vi.spyOn(store, "configureBrowser").mockResolvedValue(undefined);
  let resolve!: (value: unknown) => void;
  const started = vi.spyOn(integration, "openSessionBrowser").mockReturnValue(new Promise(r => { resolve = r; }) as never);
  const pending = store.newBrowserTask();
  await vi.waitFor(() => expect(started).toHaveBeenCalled());
  expect(started).toHaveBeenCalledWith({ directory: "/test/browser-owned", engine: "pi", sessionId: "browser-test" }, expect.any(Function), null, null);
  expect(store.state.ui.browserOpen).toBe(false);
  resolve({ browserOpen: true }); await pending;
  expect(store.state.ui.browserOpen).toBe(true);
});

it("a healthy runtime with failed project reads keeps the chat and blocks dispatch until recovery", async () => {
  sessions["/test/A"] = [session("ses_a")];
  choose("ses_a");
  fx.on("GET", "/sessions/status", () => { throw new fixture.RuntimeReply(500, { message: "EPERM: operation not permitted, lstat '/test/A'" }); });
  await store.refreshSessions();
  expect(store.state.connection.phase).toBe("connected");
  expect(store.state.connection.statusError).toContain("отказ доступа");
  expect(store.state.activeSessionId).toBe("ses_a");
  expect(await store.sendPrompt("new prompt")).toBe(false);
  fx.on("GET", "/sessions/status", () => ({}));
  await store.retryProjectAccess();
  expect(store.state.connection.statusError).toBeNull();
  expect(store.state.activeSessionId).toBe("ses_a");
  expect(commands()).toEqual([]);
});

it("a late failure of project recovery does not contaminate the newly selected project", async () => {
  let reject!: (error: unknown) => void;
  fx.on("GET", "/sessions/status", () => new Promise((_, fail) => { reject = fail; }));
  const recovery = store.retryProjectAccess();
  await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
  fx.on("GET", "/sessions/status", () => ({}));
  await store.setDirectory("/test/B");
  reject(new fixture.RuntimeReply(500, { message: "EPERM: old A failure" }));
  await recovery;
  expect(store.state.connection.statusError).toBeNull();
  expect(store.state.directory).toBe("/test/B");
});

it("preserves full access when creating a chat before its first prompt", async () => {
  store.state = { ...store.state, activeSessionId: null, prefs: { ...store.state.prefs, newAccess: "full" } };
  fx.on("POST", "/sessions", c => ({ ...session("ses_full"), permission: (c.body as { permission: unknown }).permission }));
  const created = await store.createSessionNow("Full access");
  expect(created?.id).toBe("ses_full");
  expect(fx.made("POST", "/sessions")[0].body).toMatchObject({ directory: "/test/A", permission: [{ permission: "*", pattern: "*", action: "allow" }] });
  expect(store.getAccessMode()).toBe("full");
});

it("subscribes to the folder's durable stream before its first chat exists", () => {
  expect(store.state.sessions).toEqual([]);
  expect(fx.directoryStreams.filter(s => s.directory === "/test/A" && !s.subscription.signal.aborted)).toHaveLength(1);
});

const dialog = (id: string) => ({ id, sessionID: "ses_a", directory: "/test/A", method: "confirm", title: `Подтвердите ${id}`, deadline: Date.now() + 60_000 });

it("an extension dialog stays visible on transport failure, is tied to its exact request and is never auto-answered", async () => {
  fx.emit({ type: "dialog.asked", properties: { dialog: dialog("one") } } as never, "/test/A");
  expect(store.state.ui.agentDialog?.id).toBe("one");
  expect(fx.made("POST", "/dialogs/:id/reply")).toEqual([]);
  let fail = true;
  fx.on("POST", "/dialogs/:id/reply", () => { if (fail) { fail = false; throw new TypeError("connection reset"); } return undefined; });
  await expect(store.answerAgentDialog({ confirmed: true }, "one")).rejects.toBeTruthy();
  expect(store.state.ui.agentDialog?.id).toBe("one");
  expect(store.state.ui.toast).toContain("не доставлен");
  await store.answerAgentDialog({ confirmed: true }, "old");
  expect(fx.made("POST", "/dialogs/:id/reply")).toHaveLength(1);
  await store.answerAgentDialog({ confirmed: true }, "one");
  expect(fx.made("POST", "/dialogs/:id/reply").map(c => [c.params.id, c.body])).toEqual([["one", { confirmed: true }], ["one", { confirmed: true }]]);
  expect(store.state.ui.agentDialog ?? null).toBeNull();
});

it("two extension dialogs are shown in order, never overwritten or answered together, and expire by id", async () => {
  fx.on("POST", "/dialogs/:id/reply", () => undefined);
  fx.emit({ type: "dialog.asked", properties: { dialog: dialog("first") } } as never, "/test/A");
  fx.emit({ type: "dialog.asked", properties: { dialog: dialog("second") } } as never, "/test/A");
  expect(store.state.ui.agentDialog?.id).toBe("first");
  await store.answerAgentDialog({ confirmed: true }, "first");
  expect(store.state.ui.agentDialog?.id).toBe("second");
  expect(fx.made("POST", "/dialogs/:id/reply").map(c => c.params.id)).toEqual(["first"]);
  fx.emit({ type: "dialog.expired", properties: { sessionID: "ses_a", requestID: "second", by: "deadline" } } as never, "/test/A");
  expect(store.state.ui.agentDialog ?? null).toBeNull();
});

it("acknowledges dictation text and its receipt atomically and never appends it twice", () => {
  store.state.prefs.drafts = { voice: "Existing" };
  const workspace = store.state.prefs.workspaceKey;
  store.appendDictation(workspace, "voice", "новая фраза", "dictation-receipt");
  store.appendDictation(workspace, "voice", "новая фраза", "dictation-receipt");
  expect(store.state.prefs.drafts.voice).toBe("Existing новая фраза");
  expect(store.state.prefs.dictationReceipts).toContain("dictation-receipt");
});

it("retains the receipt after a failed draft save, so a retry persists without duplicating text", () => {
  const workspace = store.state.prefs.workspaceKey;
  const write = vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => { throw Error("disk full"); });
  expect(() => store.appendDictation(workspace, "voice", "новый текст", "failed-save-receipt")).toThrow(/сохранить/);
  store.appendDictation(workspace, "voice", "новый текст", "failed-save-receipt");
  expect(store.state.prefs.drafts.voice).toBe("новый текст"); write.mockRestore();
});

it("delivers dictation to its original workspace even after navigation", () => {
  const current = store.state.prefs.workspaceKey;
  store.state.prefs.endpointState = { ...store.state.prefs.endpointState, old: { drafts: { voice: "Old" } } };
  store.appendDictation("old", "voice", "сохранено", "old-workspace-receipt");
  expect(store.state.prefs.endpointState.old.drafts.voice).toBe("Old сохранено");
  expect(store.state.prefs.drafts.voice).toBeUndefined();
  expect(store.state.prefs.workspaceKey).toBe(current);
});

// Manual compaction is a current-model runtime command: the window names the
// session only, never a model (the runtime refuses another one and leases the
// model the SDK actually summarizes with: agent integration/model-context-hub).
it("compaction uses the selected session only, sends no UI model and never starts a prompt", async () => {
  choose("ses_a");
  await store.compactSession("another");
  expect(commands()).toEqual([]);
  await store.compactSession("ses_a");
  expect(commands()).toEqual([expect.objectContaining({ kind: "compact", sessionID: "ses_a", directory: "/test/A", id: expect.stringMatching(/^compact-/), payload: {} })]);
  expect(commands().some(c => c.kind === "prompt")).toBe(false);
});

// No awaited preparation precedes the compact command any more, so there is no
// late window to race; the same invariant holds at submission time.
it("a chat the user left or a busy turn never receives a summary request", async () => {
  choose("ses_a");
  store.state = { ...store.state, activeSessionId: "ses_b" };
  await store.compactSession("ses_a");
  store.state = { ...store.state, activeSessionId: "ses_a" };
  fx.emit({ type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } } as never, "/test/A");
  await store.compactSession("ses_a");
  expect(commands()).toEqual([]);
});

it("a pending compaction blocks a racing manual prompt without clearing its draft", async () => {
  choose("ses_a"); store.setDraft("keep my task");
  let finish!: () => void;
  fx.on("POST", "/commands", c => new Promise(r => { finish = () => r(accepted((c.body as { id: string }).id)); }));
  const pending = store.compactSession("ses_a");
  await vi.waitFor(() => expect(commands()).toHaveLength(1));
  expect(await store.sendPrompt("keep my task")).toBe(false);
  expect(store.getDraft()).toBe("keep my task");
  expect(commands().map(c => c.kind)).toEqual(["compact"]);
  finish(); await pending;
});

it("switching chats cancels only the obsolete history read and never stops agent work", async () => {
  store.state = { ...store.state, activeSessionId: null, sessions: [session("a"), session("b")] };
  fx.on("GET", "/sessions/:id/messages", c => c.params.id === "b" ? { messages: [], before: null } : new Promise(() => {}));
  const first = store.selectSession("a");
  await vi.waitFor(() => expect(fx.made("GET", "/sessions/:id/messages").filter(c => c.params.id === "a")).toHaveLength(1));
  const obsolete = fx.made("GET", "/sessions/:id/messages").find(c => c.params.id === "a")!.signal!;
  expect(obsolete.aborted).toBe(false);
  await store.selectSession("b"); await first;
  expect(obsolete.aborted).toBe(true);
  expect(store.state.activeSessionId).toBe("b");
  expect(store.state.ui.historyError).toBeNull();
  expect(fx.made("POST", "/sessions/:id/stop")).toEqual([]);
});

it("shows a cached target immediately while project metadata loads, and respects a newer selection", async () => {
  const { emptySessionChat } = await import("../src/state/chatReducer");
  const cached = emptySessionChat(); store.state.chat.sessions.cached = cached;
  let ready!: () => void;
  fx.on("GET", "/providers", () => new Promise(resolve => { ready = () => resolve({ all: [], connected: [], default: {} }); }));
  const opening = store.openChat(session("cached", "/test/B"));
  expect(store.state.directory).toBe("/test/B");
  expect(store.state.activeSessionId).toBe("cached");
  expect(store.state.chat.sessions.cached).toBe(cached);
  expect(store.state.ui.runtimeLoading).toBe(true);
  await store.selectSession("newer");
  await vi.waitFor(() => expect(ready).toBeTypeOf("function"));
  ready(); await opening;
  expect(store.state.activeSessionId).toBe("newer");
});

it("R5: accepting a prompt preserves a new draft typed while awaiting the acknowledgement", async () => {
  choose("ses_a");
  let release!: () => void;
  fx.on("POST", "/commands", c => new Promise(r => { release = () => r(accepted((c.body as { id: string }).id)); }));
  store.setDraft("first task");
  const pending = store.sendPrompt("first task");
  await vi.waitFor(() => expect(commands()).toHaveLength(1));
  store.setDraft("next task typed during request");
  release();
  expect(await pending).toBe(true);
  expect(store.getDraft()).toBe("next task typed during request");
  expect(commands()[0]).toMatchObject({ kind: "prompt", sessionID: "ses_a", directory: "/test/A", id: expect.stringMatching(/^msg_/),
    payload: { model: { providerID: "local-qwen-next", modelID: "qwen38-flash-next", variant: "medium" }, parts: expect.arrayContaining([{ type: "text", text: "first task" }]) } });
});
