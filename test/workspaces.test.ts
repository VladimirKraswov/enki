// Projects, projectless chats and SSH workspaces over the runtime. Projectless
// chat folders are created by the runtime where it runs (POST /workspaces/chat);
// SSH runtimes are reached through the store's real connectHost path with only
// the native handshake (connectRuntime) replaced by fixture backends.
// (The former modelServices.reserve call before sends is gone; sends go straight
// to POST /commands after the local readiness seam.)
import "fake-indexeddb/auto";
import { beforeEach, expect, it, vi } from "vitest";
import type { RuntimeFixture } from "./helpers/runtime-fixture";
const hosts = vi.hoisted(() => ({ connect: null as null | ((target: { kind: string; host?: { id: string } }) => Promise<unknown>) }));
vi.mock("../src/agent/registry", async (original) => ({ ...(await original<typeof import("../src/agent/registry")>()),
  connectRuntime: vi.fn(async (target: { kind: string; host?: { id: string } }) => hosts.connect!(target)) }));
let store: any, fx: RuntimeFixture, fixture: typeof import("./helpers/runtime-fixture"), chats: string[];
const session = (id: string, directory: string) => ({ id, directory, title: id, projectID: "global", time: { created: 1, updated: 1 } });
const defer = () => { let resolve!: (x: unknown) => void; const promise = new Promise<unknown>((r) => (resolve = r)); return { promise, resolve }; };
const commands = (f = fx) => f.made("POST", "/commands").map(c => c.body as { sessionID: string; directory: string; payload: { parts: Array<Record<string, unknown>> } });
function runtime(options: Parameters<typeof fixture.runtimeFixture>[0] = {}) {
  const f = fixture.runtimeFixture(options);
  fixture.withProvider(f, "p", ["m"], ["medium"]);
  f.on("POST", "/workspaces/chat", () => ({ root: "/home/test/chats", directory: chats.shift() ?? "/home/test/chats/extra" }));
  f.on("POST", "/sessions", c => session("ses_chat", (c.body as { directory: string }).directory));
  f.on("POST", "/commands", c => ({ id: (c.body as { id: string }).id, kind: "prompt", sessionID: "x", state: "accepted", createdAt: 1, updatedAt: 1 }));
  return f;
}
beforeEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
  fixture = await import("./helpers/runtime-fixture");
  const journal = (await import("../src/operations/journal")).operationJournal;
  vi.spyOn(journal as any, "storage").mockReturnValue({ list: async () => [], write: async () => {} });
  store = (await import("../src/state/store")).store;
  chats = ["/home/test/chats/one", "/home/test/chats/two"];
  fx = runtime();
  hosts.connect = async target => { if (target.kind === "local") return fx.backend; throw new Error("no remote"); };
  expect(await store.connectLocal()).toBe(true);
  store.setModelChoice("p", "m", "medium");
});

it("New Chat leaves the old session and project, preserves their draft, and creates nothing in the runtime", async () => {
  await store.setDirectory("/project");
  store.state.prefs.lastSessionByDir["/project"] = "ses_old";
  store.state.activeSessionId = "ses_old";
  store.setDraft("unfinished old draft");
  await store.newSession();
  expect(store.state.directory).toBeNull();
  expect(store.state.activeSessionId).toBeNull();
  expect(store.isProjectless()).toBe(true);
  expect(store.state.prefs.drafts.ses_old).toBe("unfinished old draft");
  expect(fx.made("POST", "/sessions")).toEqual([]);
  expect(fx.made("POST", "/workspaces/chat")).toEqual([]);
});

it("choosing a project for a new chat does not resume that project's previous session", async () => {
  store.state.prefs.lastSessionByDir["/project"] = "ses_old";
  await store.setDirectory("/project");
  expect(store.state.activeSessionId).toBeNull();
  await store.setDirectory("/project", { restoreSession: true });
  expect(store.state.activeSessionId).toBe("ses_old");
});

it("the first projectless send creates an isolated runtime workspace and routes the real prompt there", async () => {
  store.setDraft("hello");
  expect(await store.sendPrompt("hello")).toBe(true);
  expect(fx.made("POST", "/workspaces/chat")).toHaveLength(1);
  expect(fx.made("POST", "/sessions")[0].body).toMatchObject({ directory: "/home/test/chats/one", model: { providerID: "p", modelID: "m", variant: "medium" } });
  expect(commands()).toEqual([expect.objectContaining({ sessionID: "ses_chat", directory: "/home/test/chats/one",
    payload: expect.objectContaining({ parts: expect.arrayContaining([{ type: "text", text: "hello" }]) }) })]);
  expect(store.chatSessions().map((s: { id: string }) => s.id)).toEqual(["ses_chat"]);
  expect(store.projectDirectories()).not.toContain("/home/test/chats/one");
  expect(store.state.prefs.drafts["new::"]).toBeUndefined();
});

it("sends a prepared file with the prompt and removes only the accepted attachments", async () => {
  const { attachmentDrafts, attachmentScope } = await import("../src/attachments/drafts");
  await store.setDirectory("/project");
  store.state = { ...store.state, activeSessionId: "ses_file", sessions: [session("ses_file", "/project")] };
  store.setModelChoice("p", "m", "medium");
  store.setDraft("review this");
  const scope = attachmentScope(store.state.prefs.workspaceKey, "/project", "ses_file");
  const [file] = await attachmentDrafts.add(scope, [new File(["hello"], "notes.txt", { type: "text/plain" })]);
  expect(await store.sendPrompt("review this", [file])).toBe(true);
  expect(commands()[0].payload.parts.slice(0, 2)).toEqual([{ type: "text", text: "review this" }, expect.objectContaining({ type: "file", mime: "text/plain", filename: "notes.txt" })]);
  expect(attachmentDrafts.snapshot(scope)).toEqual([]);
  expect(store.getDraft()).toBe("");
});

it("keeps an attachment and the text draft after a refused send", async () => {
  const { attachmentDrafts, attachmentScope } = await import("../src/attachments/drafts");
  await store.setDirectory("/project");
  store.state = { ...store.state, activeSessionId: "ses_failure", sessions: [session("ses_failure", "/project")] };
  store.setModelChoice("p", "m", "medium");
  store.setDraft("keep this");
  const scope = attachmentScope(store.state.prefs.workspaceKey, "/project", "ses_failure");
  const [file] = await attachmentDrafts.add(scope, [new File(["hello"], "notes.txt", { type: "text/plain" })]);
  fx.on("POST", "/commands", () => { throw new fixture.RuntimeReply(503, { message: "runtime unavailable" }); });
  expect(await store.sendPrompt("keep this", [file])).toBe(false);
  expect(attachmentDrafts.snapshot(scope).map(x => x.name)).toEqual(["notes.txt"]);
  expect(store.getDraft()).toBe("keep this");
  expect(store.state.ui.sendError).toContain("runtime unavailable");
});

it("workspace preparation guards a double Enter and cannot send after a project switch", async () => {
  const pending = defer();
  fx.on("POST", "/workspaces/chat", () => pending.promise);
  const first = store.sendPrompt("first");
  await vi.waitFor(() => expect(fx.made("POST", "/workspaces/chat")).toHaveLength(1));
  expect(await store.sendPrompt("duplicate")).toBe(false);
  await store.setDirectory("/different-project");
  pending.resolve({ root: "/home/test/chats", directory: "/home/test/chats/stale" });
  expect(await first).toBe(false);
  expect(store.state.directory).toBe("/different-project");
  expect(commands()).toEqual([]);
  expect(store.state.prefs.projectlessDirectories ?? []).not.toContain("/home/test/chats/stale");
});

it("returns a new chat workspace before its unrelated session index finishes loading", async () => {
  fx.on("GET", "/sessions", () => new Promise(() => {}));
  expect(await store.ensureChatWorkspace()).toBe(true);
  expect(store.state.directory).toBe("/home/test/chats/one");
  expect(store.state.ui.workspacePreparing).toBe(false);
});

it("each new projectless chat gets a new workspace; cached chats reopen in their own directory", async () => {
  await store.ensureChatWorkspace();
  const one = session("ses_one", store.state.directory);
  store.state.prefs.projectlessSessions = [one];
  await store.newSession();
  await store.ensureChatWorkspace();
  expect(store.state.directory).toBe("/home/test/chats/two");
  fx.on("GET", "/sessions", c => (c.query.directory === one.directory ? [one] : []));
  await store.openChat(one);
  expect(store.state.directory).toBe(one.directory);
  expect(store.state.activeSessionId).toBe("ses_one");
  expect(fx.made("GET", "/sessions/:id/messages").some(c => c.params.id === "ses_one" && c.query.directory === one.directory)).toBe(true);
});

const remoteHost = { id: "remote", name: "Remote", target: "host", port: 4096 };
it("an SSH reconnect on a new forwarding port keeps its own history and never inherits local drafts or terminals", async () => {
  store.setDraft("local draft"); store.setPtyId("/same", "pty_local");
  store.saveRemoteHost(remoteHost);
  const ports = [runtime({ connection: { endpoint: "http://127.0.0.1:49101", token: "a".repeat(43) }, workspace: "ssh:host:4096" }),
    runtime({ connection: { endpoint: "http://127.0.0.1:49199", token: "b".repeat(43) }, workspace: "ssh:host:4096" })];
  hosts.connect = async target => (target.kind === "local" ? fx.backend : ports.shift()!.backend);
  expect(await store.connectHost("remote")).toBe(true);
  expect(store.getDraft()).toBe(""); expect(store.state.prefs.ptyIds).toEqual({});
  store.setDraft("remote draft"); store.setPtyId("/same", "pty_remote");
  expect(await store.connectHost("remote")).toBe(true);
  expect(store.state.prefs.workspaceKey).toBe("ssh:host:4096");
  expect(store.backend.endpoint).toBe("http://127.0.0.1:49199");
  expect(store.getDraft()).toBe("remote draft"); expect(store.state.prefs.ptyIds["/same"]).toBe("pty_remote");
  await store.connectHost("local");
  expect(store.getDraft()).toBe("local draft"); expect(store.state.prefs.ptyIds["/same"]).toBe("pty_local");
});

it("a failed remote connection disables sending and never silently executes on this computer", async () => {
  store.saveRemoteHost(remoteHost);
  hosts.connect = async target => { if (target.kind === "local") return fx.backend; throw new Error("SSH unavailable"); };
  expect(await store.connectHost("remote")).toBe(false);
  expect(store.state.connection).toMatchObject({ phase: "disconnected", error: expect.stringContaining("SSH unavailable") });
  expect(await store.sendPrompt("reboot this machine")).toBe(false);
  expect(commands()).toEqual([]);
  expect(fx.made("POST", "/sessions")).toEqual([]);
});

it("an HTTP error from the runtime never starts or switches to another runtime", async () => {
  const { connectRuntime } = await import("../src/agent/registry");
  const before = vi.mocked(connectRuntime).mock.calls.length;
  fx.on("GET", "/health", () => { throw new fixture.RuntimeReply(503, { message: "draining" }); });
  expect(await store.connectLocal()).toBe(false);
  expect(vi.mocked(connectRuntime).mock.calls.length - before).toBe(1);
  expect(store.state.connection).toMatchObject({ phase: "disconnected", error: expect.stringContaining("draining") });
  expect(store.backend).toBe(fx.backend);
  expect(fx.made("POST", "/commands")).toEqual([]);
});

it("a late remote handshake cannot replace a newer Local selection", async () => {
  store.saveRemoteHost(remoteHost);
  const pending = defer();
  const late = runtime({ connection: { endpoint: "http://127.0.0.1:49102" }, workspace: "ssh:host:4096" });
  hosts.connect = async target => (target.kind === "local" ? fx.backend : pending.promise);
  const first = store.connectHost("remote");
  await store.connectHost("local");
  pending.resolve(late.backend);
  expect(await first).toBe(false);
  expect(store.backend.endpoint).toBe(fx.backend.endpoint);
  expect(store.state.prefs.activeHost).toBe("local");
  expect(late.made("GET", "/health")).toEqual([]);
});

it("the remote runtime's bearer is sent on requests but never serialized in prefs", async () => {
  store.saveRemoteHost(remoteHost);
  const token = "s".repeat(43);
  const remote = runtime({ connection: { endpoint: "http://127.0.0.1:49101", token }, workspace: "ssh:host:4096" });
  hosts.connect = async target => (target.kind === "local" ? fx.backend : remote.backend);
  await store.connectHost("remote");
  expect(store.client.authorization().Authorization).toBe(`Bearer ${token}`);
  expect(JSON.stringify(store.state.prefs)).not.toContain(token);
});

it("remote workspace creation happens on the selected SSH runtime, never on this computer", async () => {
  store.saveRemoteHost(remoteHost);
  const remote = runtime({ connection: { endpoint: "http://127.0.0.1:49101" }, workspace: "ssh:host:4096" });
  hosts.connect = async target => (target.kind === "local" ? fx.backend : remote.backend);
  await store.connectHost("remote");
  await store.ensureChatWorkspace();
  expect(remote.made("POST", "/workspaces/chat")).toHaveLength(1);
  expect(fx.made("POST", "/workspaces/chat")).toEqual([]);
});

it("refresh removes externally deleted chats from the local index without deleting any runtime session", async () => {
  await store.ensureChatWorkspace();
  store.state.prefs.projectlessSessions = [session("ses_deleted", store.state.directory)];
  fx.on("GET", "/sessions", () => []);
  await store.refreshSessions();
  expect(store.chatSessions()).toEqual([]);
  expect(fx.made("DELETE", "/sessions/:id")).toEqual([]);
});

it("the terminal shortcut creates a workspace without sending a model request", async () => {
  await store.toggleTerminal();
  expect(store.state.prefs.layout.bottomOpen).toBe(true);
  expect(store.state.directory).toBe("/home/test/chats/one");
  await store.toggleTerminal();
  expect(store.state.prefs.layout.bottomOpen).toBe(false);
  expect(fx.made("POST", "/workspaces/chat")).toHaveLength(1);
  expect(commands()).toEqual([]);
});

it("manual non-Git projects survive a runtime project-list refresh without showing chat directories", async () => {
  await store.addProjectDirectory("/project-without-git");
  await store.newSession();
  await store.ensureChatWorkspace();
  await store.refreshProjects();
  expect(store.projectDirectories()).toContain("/project-without-git");
  expect(store.projectDirectories()).not.toContain("/home/test/chats/one");
  expect(store.state.prefs.pinnedProjects).toContain("/project-without-git");
});

it("configured models default to Medium when supported, without inventing unsupported variants", () => {
  store.state.prefs.modelChoice = {};
  store.state.configModel = "p/m";
  store.state.connectedProviderIds = ["p"];
  store.state.providers = [{ id: "p", models: { m: { id: "m", variants: { medium: {} } } } }];
  expect(store.getModelChoice().variant).toBe("medium");
  store.state.providers[0].models.m.variants = {};
  expect(store.getModelChoice().variant).toBeNull();
});

it("keeps model and effort choices within a session, without changing another session or new chats", () => {
  store.state = { ...store.state, directory: "/project", connectedProviderIds: ["local-qwen-next", "local-qwen38"],
    prefs: { ...store.state.prefs, modelChoice: { "/project": { providerID: "local-qwen-next", modelID: "flash", variant: "medium" } } },
    sessions: [{ ...session("ses_flash", "/project"), model: { id: "flash", providerID: "local-qwen-next", variant: "medium" } },
      { ...session("ses_v100", "/project"), model: { id: "qwen27", providerID: "local-qwen38", variant: "low" } }],
    activeSessionId: "ses_v100" };
  expect(store.getModelChoice()).toEqual({ providerID: "local-qwen38", modelID: "qwen27", variant: "low" });
  store.setModelChoice("local-qwen38", "qwen27", "xhigh");
  expect(store.getModelChoice().variant).toBe("xhigh");
  expect(store.state.prefs.modelChoice["/project"].modelID).toBe("flash");
  store.state = { ...store.state, activeSessionId: "ses_flash" };
  expect(store.getModelChoice()).toEqual({ providerID: "local-qwen-next", modelID: "flash", variant: "medium" });
  store.state = { ...store.state, activeSessionId: null };
  expect(store.getModelChoice()).toEqual({ providerID: "local-qwen-next", modelID: "flash", variant: "medium" });
});

it("keeps agent selection per session while preserving the new-chat default", () => {
  store.state = { ...store.state, directory: "/project", configDefaultAgent: "qwen-build",
    prefs: { ...store.state.prefs, agentChoice: { "/project": "qwen-build" } },
    sessions: [{ ...session("ses_a", "/project"), agent: "qwen-build" }, { ...session("ses_b", "/project"), agent: "qwen-v100-build" }],
    activeSessionId: "ses_b" };
  expect(store.getAgentChoice()).toBe("qwen-v100-build");
  store.setAgentOverride("/project", "plan");
  expect(store.getAgentChoice()).toBe("plan");
  expect(store.state.prefs.agentChoice["/project"]).toBe("qwen-build");
  store.state = { ...store.state, activeSessionId: "ses_a" };
  expect(store.getAgentChoice()).toBe("qwen-build");
  store.state = { ...store.state, activeSessionId: null };
  expect(store.getAgentChoice()).toBe("qwen-build");
});

it("a workspace failure preserves the unassigned draft and never falls back to HOME", async () => {
  store.setDraft("keep me");
  fx.on("POST", "/workspaces/chat", () => { throw new fixture.RuntimeReply(507, { message: "disk unavailable" }); });
  expect(await store.sendPrompt("keep me")).toBe(false);
  expect(store.getDraft()).toBe("keep me");
  expect(store.state.directory).toBeNull();
  expect(store.state.ui.sendError).toContain("disk unavailable");
  expect(fx.made("POST", "/sessions")).toEqual([]);
  expect(commands()).toEqual([]);
});
