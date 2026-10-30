// Sidebar project/recent lists over the runtime catalogue. Host switches go
// through the store's real connectHost → doConnect path; only the native
// supervisor/SSH handshake (connectRuntime) is replaced by fixture backends.
// Retired: "shows Pi chats alongside OpenCode chats" — one runtime catalogue
// lists native chats and imported archives together.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RuntimeFixture } from "./helpers/runtime-fixture";
const hosts = vi.hoisted(() => ({ backends: {} as Record<string, unknown> }));
vi.mock("../src/agent/registry", async (original) => ({ ...(await original<typeof import("../src/agent/registry")>()),
  connectRuntime: vi.fn(async (target: { kind: string; host?: { id: string } }) => hosts.backends[target.kind === "local" ? "local" : target.host!.id]) }));
vi.mock("../src/native/sound", () => ({ completionChime: vi.fn(async () => {}) }));
let store: any, local: RuntimeFixture, other: RuntimeFixture;
let lists: Record<string, unknown[]>, recent: Array<{ sessions: unknown[]; cursor: number | null }>;
const session = (id: string, directory = "/work/a", updated = 1) => ({ id, directory, title: id, projectID: "fixture", time: { created: 1, updated } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
beforeEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v), removeItem: (k: string) => saved.delete(k) });
  const fixture = await import("./helpers/runtime-fixture");
  store = (await import("../src/state/store")).store;
  local = fixture.runtimeFixture();
  other = fixture.runtimeFixture({ connection: { endpoint: "http://127.0.0.1:43124", instance: "other" }, workspace: "ssh:other:22" });
  hosts.backends = { local: local.backend, other: other.backend };
  lists = {}; recent = [];
  for (const fx of [local, other]) {
    fx.on("GET", "/sessions", c => lists[c.query.directory] ?? [session(c.query.directory, c.query.directory)]);
    fx.on("GET", "/sessions/recent", () => recent.shift() ?? { sessions: [], cursor: null });
    fx.on("GET", "/projects", () => [{ id: "a", worktree: "/work/a" }, { id: "b", worktree: "/work/b" }]);
  }
  store.saveRemoteHost({ id: "other", name: "Other", target: "other", port: 22 });
  expect(await store.connectLocal()).toBe(true);
  await store.setDirectory("/work/a"); await store.selectSession("/work/a");
});
afterEach(() => { if (store?.projectRefreshTimer) clearTimeout(store.projectRefreshTimer); });
const listed = (directory: string) => store.state.projectSessionLists[directory]?.sessions.map((s: { id: string }) => s.id);

it("expands multiple projects without changing the current conversation, draft, or stream", async () => {
  store.state.prefs.drafts = { "/work/a": "unsent" };
  const streams = local.directoryStreams.length;
  store.toggleProject("/work/b"); await vi.waitFor(() => expect(store.state.projectSessionLists["/work/b"]?.loaded).toBe(true));
  expect(store.isProjectExpanded("/work/a")).toBe(true); expect(store.isProjectExpanded("/work/b")).toBe(true);
  expect(store.state.directory).toBe("/work/a"); expect(store.state.activeSessionId).toBe("/work/a");
  expect(store.state.prefs.drafts["/work/a"]).toBe("unsent");
  expect(local.directoryStreams.length).toBe(streams);
  store.toggleProject("/work/a");
  await store.connectLocal();
  expect(store.isProjectExpanded("/work/a")).toBe(false); expect(store.isProjectExpanded("/work/b")).toBe(true);
  const { flushPrefs, loadPrefs } = await import("../src/state/prefs"); flushPrefs();
  expect(loadPrefs().expandedProjects).toMatchObject({ "/work/a": false, "/work/b": true });
});

it("isolates exact directories and excludes subagent sessions", async () => {
  lists["/work/b"] = [session("b", "/work/b"), session("a"), { ...session("child", "/work/b"), parentID: "b" }];
  await store.loadProjectSessions("/work/b");
  expect(listed("/work/b")).toEqual(["b"]);
  expect(local.made("GET", "/sessions").at(-1)!.query).toMatchObject({ directory: "/work/b" });
});

it("keeps event updates/deletions that arrived during a slower list snapshot", async () => {
  const d = deferred<unknown[]>();
  local.on("GET", "/sessions", c => c.query.directory === "/work/b" ? d.promise : []);
  const loading = store.loadProjectSessions("/work/b");
  await vi.waitFor(() => expect(local.made("GET", "/sessions").some(c => c.query.directory === "/work/b")).toBe(true));
  local.emitGlobal({ type: "session.updated", properties: { info: { ...session("b", "/work/b", 3), title: "Renamed" } } } as never, "/work/b");
  local.emitGlobal({ type: "session.deleted", properties: { info: session("deleted", "/work/b") } } as never, "/work/b");
  d.resolve([session("b", "/work/b"), session("deleted", "/work/b")]); await loading;
  expect(store.state.projectSessionLists["/work/b"].sessions.map((s: { title: string }) => s.title)).toEqual(["Renamed"]);
});

it("ignores late results from a previous host and scopes expansion preferences", async () => {
  const d = deferred<unknown[]>();
  local.on("GET", "/sessions", c => c.query.directory === "/work/b" ? d.promise : []);
  store.toggleProject("/work/b");
  expect(await store.connectHost("other")).toBe(true);
  d.resolve([session("foreign", "/work/b")]); await Promise.resolve(); await Promise.resolve();
  expect(store.state.projectSessionLists["/work/b"]).toBeUndefined();
  expect(store.isProjectExpanded("/work/b")).toBe(false);
  expect(store.state.prefs.workspaceKey).toBe("ssh:other:22");
});

it("paginates recent sessions across projects and projectless directories without duplicates", async () => {
  recent = [{ sessions: [session("b", "/work/b", 3), session("chat", "/chats/one", 2)], cursor: 2 }, { sessions: [session("chat", "/chats/one", 2), session("a")], cursor: null }];
  await store.loadRecentSessions(); await store.loadRecentSessions(false, true);
  expect(local.made("GET", "/sessions/recent").at(-1)!.query).toEqual({ cursor: "2", limit: "20" });
  expect(store.state.recentSessionList.sessions.map((s: { id: string }) => s.id)).toEqual(["b", "chat", "a"]);
  expect(store.state.recentSessionList.hasMore).toBe(false);
});

it("updates rename/archive/restore/delete on a non-active project and in recent sessions", async () => {
  const b = session("b", "/work/b"); lists["/work/b"] = [b];
  await store.loadProjectSessions("/work/b"); recent = [{ sessions: [b], cursor: null }]; await store.loadRecentSessions();
  const updated = { ...b, title: "New title" }, archived = { ...updated, time: { ...b.time, archived: 123 } };
  let reply: unknown = updated;
  local.on("PATCH", "/sessions/:id", () => reply);
  local.on("DELETE", "/sessions/:id", () => undefined);
  await store.renameSession(b, updated.title);
  expect(store.state.projectSessionLists["/work/b"].sessions[0].title).toBe(updated.title);
  expect(store.state.recentSessionList.sessions[0].title).toBe(updated.title);
  reply = archived; await store.archiveSession(updated);
  expect(store.state.recentSessionList.sessions).toEqual([]);
  expect(store.state.archivedSessions).toEqual([]); expect(store.state.activeSessionId).toBe("/work/a");
  reply = updated; await store.unarchiveSession(archived);
  expect(store.state.recentSessionList.sessions[0].id).toBe("b");
  await store.deleteSession(updated);
  expect(store.state.projectSessionLists["/work/b"].sessions).toEqual([]); expect(store.state.recentSessionList.sessions).toEqual([]);
  expect(local.made("PATCH", "/sessions/:id").map(c => [c.params.id, c.query.directory])).toEqual([["b", "/work/b"], ["b", "/work/b"], ["b", "/work/b"]]);
  expect(local.made("DELETE", "/sessions/:id").map(c => [c.params.id, c.query.directory])).toEqual([["b", "/work/b"]]);
});

it("retries a failed project load and can request sessions beyond the first 50", async () => {
  local.on("GET", "/sessions", c => { if (c.query.directory === "/work/b") throw new TypeError("offline"); return []; });
  await store.loadProjectSessions("/work/b");
  expect(store.state.projectSessionLists["/work/b"].error).toBeTruthy();
  local.on("GET", "/sessions", c => c.query.directory === "/work/b" ? Array.from({ length: 50 }, (_, i) => session(`b${i}`, "/work/b")) : []);
  await store.loadProjectSessions("/work/b"); expect(store.state.projectSessionLists["/work/b"].hasMore).toBe(true);
  local.on("GET", "/sessions", () => [session("b", "/work/b")]);
  await store.loadProjectSessions("/work/b", { more: true });
  expect(local.made("GET", "/sessions").at(-1)!.query).toMatchObject({ directory: "/work/b", limit: "100" });
  expect(store.state.projectSessionLists["/work/b"].hasMore).toBe(false);
});

it("removes a project from the list without changing its current session or touching runtime data, and restores it", async () => {
  store.state.prefs.pinnedProjects = ["/work/a", "/work/b"];
  store.state.prefs.drafts = { "/work/a": "keep me" };
  store.removeProject("/work/a");
  expect(store.projectDirectories()).not.toContain("/work/a"); expect(store.isProjectHidden("/work/a")).toBe(true);
  expect(store.state.activeSessionId).toBe("/work/a"); expect(store.state.prefs.drafts["/work/a"]).toBe("keep me");
  await store.refreshProjects(); expect(store.projectDirectories()).not.toContain("/work/a");
  expect(local.calls.filter(c => c.method === "DELETE")).toEqual([]);
  store.restoreProject("/work/a"); expect(store.projectDirectories()).toContain("/work/a");
});

it("keeps hidden projects host-scoped and adding the folder explicitly restores it", async () => {
  store.removeProject("/work/a");
  await store.connectHost("other"); expect(store.isProjectHidden("/work/a")).toBe(false);
  await store.connectLocal(); expect(store.isProjectHidden("/work/a")).toBe(true);
  await store.addProjectDirectory("/work/a"); expect(store.isProjectHidden("/work/a")).toBe(false);
});

it("appends handoff drafts only to the recipient host/session, preserving existing text and the source draft", () => {
  store.state.prefs.drafts = { source: "source draft", target: "local target" };
  store.state.prefs.endpointState = { "ssh:other:22": { drafts: { target: "remote target" } } };
  store.saveHandoffDraft("ssh:other:22", session("target", "/other"), "handoff");
  expect(store.state.prefs.drafts.target).toBe("local target"); expect(store.state.prefs.drafts.source).toBe("source draft");
  expect(store.state.prefs.endpointState["ssh:other:22"].drafts.target).toBe("remote target\n\nhandoff");
  store.saveHandoffDraft(store.state.prefs.workspaceKey, session("target"), "local handoff");
  expect(store.state.prefs.drafts.target).toBe("local target\n\nlocal handoff");
});

it("refreshes project directories after background deletes, coalescing a burst without recreating chats", async () => {
  let projects=[{id:"a",worktree:"/work/a",sandboxes:[]},{id:"temp",worktree:"/work/temporary-task",sandboxes:[]}];
  local.on("GET","/projects",()=>projects); await store.refreshProjects();
  expect(store.projectDirectories()).toContain("/work/temporary-task");
  const before=local.made("GET","/projects").length;
  projects=projects.slice(0,1);
  for(let i=0;i<5;i++) local.emitGlobal({type:"session.deleted",properties:{sessionID:`temporary-${i}`,info:session(`temporary-${i}`,"/work/temporary-task")}},"/work/temporary-task");
  await vi.waitFor(()=>expect(store.projectDirectories()).not.toContain("/work/temporary-task"));
  expect(local.made("GET","/projects").length-before).toBe(1);
  expect(store.state.activeSessionId).toBe("/work/a");
  expect(local.calls.filter(c=>c.method==="POST"&&c.path==="/sessions")).toEqual([]);
});

it("a project snapshot begun before a delete cannot resurrect the deleted directory", async () => {
  const pending=deferred<unknown[]>(); local.on("GET","/projects",()=>pending.promise);
  const read=store.refreshProjects();
  local.emitGlobal({type:"session.deleted",properties:{sessionID:"old",info:session("old","/work/temporary-task")}},"/work/temporary-task");
  local.on("GET","/projects",()=>[{id:"a",worktree:"/work/a",sandboxes:[]}]);
  await vi.waitFor(()=>expect(local.made("GET","/projects").length).toBeGreaterThan(1));
  pending.resolve([{id:"stale",worktree:"/work/temporary-task",sandboxes:[]}]); await read;
  expect(store.projectDirectories()).not.toContain("/work/temporary-task");
});

it("retires old automatically pinned empty native worktrees once, preserving explicit empty projects and histories", async () => {
  const ghost="/work/deleted-worktree", explicit="/work/explicit-empty", legacy="/work/legacy-empty";
  store.state.prefs.projectPinCleanup={};store.state.prefs.pinnedProjects=[ghost,explicit,legacy,"/work/a"];
  store.state.prefs.lastSessionByDir[ghost]="00000000-0000-4000-8000-000000000001";
  store.state.prefs.lastSessionByDir[legacy]="ses_original";
  lists[ghost]=[];local.on("GET","/projects",()=>[{id:"a",worktree:"/work/a",sandboxes:[]}]);
  await store.refreshProjects();await vi.waitFor(()=>expect(store.isProjectHidden(ghost)).toBe(true));
  expect(store.projectDirectories()).not.toContain(ghost);expect(store.projectDirectories()).toContain(explicit);expect(store.projectDirectories()).toContain(legacy);
  expect(store.state.prefs.lastSessionByDir[ghost]).toBe("00000000-0000-4000-8000-000000000001");
  expect(local.calls.filter(c=>c.method==="DELETE")).toEqual([]);
  store.restoreProject(ghost); await store.refreshProjects();expect(store.projectDirectories()).toContain(ghost);
});
