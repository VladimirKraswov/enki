// Background activity and unread attention from the runtime-wide stream
// (GET /events?all=1 → backend.subscribeAll). Host switches use the store's
// real connectHost path; only the native handshake (connectRuntime) is replaced.
import { beforeEach, expect, it, vi } from "vitest";
import type { RuntimeFixture } from "./helpers/runtime-fixture";

const chime = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const hosts = vi.hoisted(() => ({ backends: {} as Record<string, unknown> }));
vi.mock("../src/agent/registry", async (original) => ({ ...(await original<typeof import("../src/agent/registry")>()),
  connectRuntime: vi.fn(async (target: { kind: string; host?: { id: string } }) => hosts.backends[target.kind === "local" ? "local" : target.host!.id]) }));
vi.mock("../src/native/sound", () => ({ completionChime: chime }));

let store: any, local: RuntimeFixture, other: RuntimeFixture, Reply: typeof import("./helpers/runtime-fixture").RuntimeReply;
let getSession: (id: string, directory: string) => unknown;
const session = (id: string, directory: string) => ({ id, directory, title: id, projectID: "fixture", time: { created: 1, updated: 1 } });
const status = (id: string, directory: string, type: "busy" | "idle" | "retry", fx = local) =>
  fx.emitGlobal({ type: "session.status", properties: { sessionID: id, status: { type } } } as never, directory);
beforeEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) });
  vi.stubGlobal("document", { hidden: false, hasFocus: vi.fn(() => true) });
  chime.mockClear();
  const fixture = await import("./helpers/runtime-fixture");
  Reply = fixture.RuntimeReply;
  store = (await import("../src/state/store")).store;
  local = fixture.runtimeFixture();
  other = fixture.runtimeFixture({ connection: { endpoint: "http://127.0.0.1:43124", instance: "other" }, workspace: "ssh:other:22" });
  hosts.backends = { local: local.backend, other: other.backend };
  getSession = (id, directory) => session(id, directory);
  for (const fx of [local, other]) {
    fx.on("GET", "/sessions", c => (c.query.directory === "/work/a" ? [session("ses_a", "/work/a")] : []));
    fx.on("GET", "/sessions/:id", c => getSession(c.params.id, c.query.directory));
  }
  store.saveRemoteHost({ id: "other", name: "Other", target: "other", port: 22 });
  expect(await store.connectLocal()).toBe(true);
  expect(local.globalStreams.filter(s => !s.signal.aborted)).toHaveLength(1);
});

it("shows work in progress, then unread completion only after leaving and clears it when opened", async () => {
  await store.setDirectory("/work/a");
  await store.selectSession("ses_a");
  status("ses_a", "/work/a", "busy");
  expect(store.activityStatus("ses_a").type).toBe("busy");
  expect(store.isRunning("ses_a")).toBe(true);
  expect(store.hasRunningInDirectory("/work/a")).toBe(true);
  expect(store.isUnread("ses_a")).toBe(false);
  await store.setDirectory("/work/b");
  status("ses_a", "/work/a", "idle");
  expect(store.activityStatus("ses_a").type).toBe("idle");
  expect(store.isRunning("ses_a")).toBe(false);
  expect(store.hasRunningInDirectory("/work/a")).toBe(false);
  expect(store.isUnread("ses_a")).toBe(true);
  expect(store.hasUnreadInDirectory("/work/a")).toBe(true);
  const { flushPrefs, loadPrefs } = await import("../src/state/prefs");
  await Promise.resolve();
  flushPrefs();
  expect(loadPrefs().unreadSessions?.ses_a?.directory).toBe("/work/a");
  expect(chime).toHaveBeenCalledTimes(1);
  status("ses_a", "/work/a", "idle");
  expect(chime).toHaveBeenCalledTimes(1);
  await store.setDirectory("/work/a");
  await store.selectSession("ses_a");
  expect(store.isUnread("ses_a")).toBe(false);
  expect(store.hasUnreadInDirectory("/work/a")).toBe(false);
  expect(store.state.prefs.unreadSessions?.ses_a).toBeUndefined();
});

it("clears unread when a project row restores an already visible completed session", async () => {
  await store.setDirectory("/work/a");
  await store.selectSession("ses_a");
  status("ses_a", "/work/a", "busy");
  await store.setDirectory("/work/b");
  status("ses_a", "/work/a", "idle");
  expect(store.isUnread("ses_a")).toBe(true);
  await store.setDirectory("/work/a", { restoreSession: true });
  expect(store.state.activeSessionId).toBe("ses_a");
  expect(store.isUnread("ses_a")).toBe(false);
});

it("does not flag a completion being watched, but preserves one finished while the window is unfocused", async () => {
  await store.setDirectory("/work/a");
  await store.selectSession("ses_a");
  status("ses_a", "/work/a", "busy");
  status("ses_a", "/work/a", "idle");
  expect(store.isUnread("ses_a")).toBe(false);
  expect(chime).not.toHaveBeenCalled();
  status("ses_a", "/work/a", "retry");
  vi.mocked(document.hasFocus).mockReturnValue(false);
  status("ses_a", "/work/a", "idle");
  expect(store.isUnread("ses_a")).toBe(true);
  expect(chime).toHaveBeenCalledTimes(1);
  vi.mocked(document.hasFocus).mockReturnValue(true);
  store.markReadIfViewing();
  expect(store.isUnread("ses_a")).toBe(false);
});

it("keeps a result unread while the selected conversation is scrolled up", async () => {
  await store.setDirectory("/work/a");
  await store.selectSession("ses_a");
  store.setConversationAtBottom(false);
  status("ses_a", "/work/a", "busy");
  status("ses_a", "/work/a", "idle");
  expect(store.isUnread("ses_a")).toBe(true);
  store.setConversationAtBottom(true);
  expect(store.isUnread("ses_a")).toBe(false);
  expect(chime).toHaveBeenCalledTimes(1);
});

it("a delayed event from the previous host cannot mark the new host unread", async () => {
  const stale = local.globalStreams.filter(s => !s.signal.aborted).at(-1)!;
  status("ses_a", "/work/a", "busy");
  expect(await store.connectHost("other")).toBe(true);
  stale.onEvent({ directory: "/work/a", payload: { type: "session.status", properties: { sessionID: "ses_a", status: { type: "idle" } } } } as never);
  expect(store.isUnread("ses_a")).toBe(false);
  expect(chime).not.toHaveBeenCalled();
});

it("removes attention when a session is deleted elsewhere", async () => {
  await store.setDirectory("/work/a");
  await store.setDirectory("/work/b");
  status("ses_a", "/work/a", "busy");
  status("ses_a", "/work/a", "idle");
  expect(store.hasUnreadInDirectory("/work/a")).toBe(true);
  local.emitGlobal({ type: "session.deleted", properties: { sessionID: "ses_a" } } as never, "/work/a");
  expect(store.hasUnreadInDirectory("/work/a")).toBe(false);
  expect(store.activityStatus("ses_a")).toBeUndefined();
});

it("does not show project attention or chime for a hidden subagent", async () => {
  getSession = (id, directory) => ({ ...session(id, directory), parentID: "root" });
  status("child", "/work/b", "busy"); status("child", "/work/b", "idle");
  await vi.waitFor(() => expect(local.made("GET", "/sessions/:id").some(c => c.params.id === "child")).toBe(true));
  await new Promise(r => setTimeout(r, 0));
  expect(store.hasUnreadInDirectory("/work/b")).toBe(false);
  expect(store.isUnread("child")).toBe(false);
  expect(chime).not.toHaveBeenCalled();
});

it("reconciles persisted child, archived and deleted marks while keeping a root outside the first page", async () => {
  store.state.prefs.unreadSessions = Object.fromEntries(["child", "archived", "deleted", "old-root"].map(id => [id, { time: 1, directory: "/work/b" }]));
  store.state.prefs.projectlessSessions = [session("deleted", "/work/b")];
  getSession = (id, directory) => {
    if (id === "deleted") throw new Reply(404, { message: "gone" });
    const s = session(id, directory);
    return id === "child" ? { ...s, parentID: "root" } : id === "archived" ? { ...s, time: { ...s.time, archived: 2 } } : s;
  };
  await store.loadProjectSessions("/work/b");
  expect(Object.keys(store.state.prefs.unreadSessions)).toEqual(["old-root"]);
  expect(store.state.projectSessionLists["/work/b"].sessions.map((s: { id: string }) => s.id)).toContain("old-root");
  expect(store.hasUnreadInDirectory("/work/b")).toBe(true);
  expect(chime).not.toHaveBeenCalled();
});

it("keeps unread on network errors and ignores a late metadata response after deletion", async () => {
  store.state.prefs.unreadSessions = { offline: { time: 1, directory: "/work/b" } };
  getSession = () => { throw new TypeError("offline"); };
  await store.loadProjectSessions("/work/b");
  expect(store.isUnread("offline")).toBe(true);
  let resolve!: (s: unknown) => void;
  getSession = () => new Promise(r => { resolve = r; });
  status("late", "/work/b", "busy"); status("late", "/work/b", "idle");
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  local.emitGlobal({ type: "session.deleted", properties: { sessionID: "late" } } as never, "/work/b");
  resolve(session("late", "/work/b")); await new Promise(r => setTimeout(r, 0));
  expect(store.isUnread("late")).toBe(false);
  expect(chime).not.toHaveBeenCalled();
});

it("does not mark a hidden conversation read while the full-page settings are open", async () => {
  await store.setDirectory("/work/a"); await store.selectSession("ses_a");
  store.setUi({ settingsOpen: true });
  status("ses_a", "/work/a", "busy"); status("ses_a", "/work/a", "idle");
  store.markReadIfViewing(); expect(store.isUnread("ses_a")).toBe(true);
  store.setUi({ settingsOpen: false }); expect(store.isUnread("ses_a")).toBe(false);
});

it("a background projectless chat keeps its spinner and unread result across the new-chat screen", async () => {
  const chat = session("ses_chat", "/home/test/chats/one");
  store.state.prefs.projectlessDirectories = [chat.directory];
  store.state.prefs.projectlessSessions = [chat];
  status(chat.id, chat.directory, "busy");
  expect(store.chatSessions()).toHaveLength(1);
  expect(store.activityStatus(chat.id).type).toBe("busy");
  await store.newSession();
  status(chat.id, chat.directory, "idle");
  expect(store.isUnread(chat.id)).toBe(true);
  expect(store.state.directory).toBeNull();
  expect(store.chatSessions()[0].id).toBe(chat.id);
});

const permissionRequest=(id:string)=>({id,sessionID:'ses_a',permission:'bash',patterns:['echo fixture'],metadata:{tool:'bash'},tool:{callID:id}});
it('reconciles other permissions closed by always even when their reply event was missed',async()=>{
  await store.setDirectory('/work/a');await store.selectSession('ses_a');
  const first=permissionRequest('first'),second=permissionRequest('second');
  local.emit({type:'permission.asked',properties:first} as never);local.emit({type:'permission.asked',properties:second} as never);
  local.on('POST','/permissions/:id/reply',()=>undefined);local.on('GET','/permissions',()=>[]);
  await store.replyPermission(first,'always');
  expect(store.pendingInteraction('ses_a').permissions).toEqual([]);
});
it('deduplicates a double click while the same permission reply is pending',async()=>{
  await store.setDirectory('/work/a');await store.selectSession('ses_a');const req=permissionRequest('double');
  local.emit({type:'permission.asked',properties:req} as never);
  let finish!:(v:unknown)=>void;const gate=new Promise(resolve=>{finish=resolve;});
  local.on('POST','/permissions/:id/reply',()=>gate);
  const first=store.replyPermission(req,'always'),second=store.replyPermission(req,'always');
  finish(undefined);await Promise.all([first,second]);
  expect(local.made('POST','/permissions/:id/reply')).toHaveLength(1);
});
it('a delayed permission ACK cannot clear a same-id request in another workspace',async()=>{
  await store.setDirectory('/work/a');await store.selectSession('ses_a');const req=permissionRequest('same-id');
  local.emit({type:'permission.asked',properties:req} as never);
  let finish!:(v:unknown)=>void;const gate=new Promise(resolve=>{finish=resolve;});local.on('POST','/permissions/:id/reply',()=>gate);
  const reply=store.replyPermission(req,'always');await store.connectHost('other');await store.setDirectory('/work/a');await store.selectSession('ses_a');
  other.emit({type:'permission.asked',properties:req} as never);
  finish(undefined);await reply;
  expect(store.pendingInteraction('ses_a').permissions.map((p:{id:string})=>p.id)).toEqual(['same-id']);
});
it('refreshes policy-settled permission cards after explicitly selecting full access',async()=>{
  await store.setDirectory('/work/a');await store.selectSession('ses_a');const req=permissionRequest('policy');
  local.emit({type:'permission.asked',properties:req} as never);
  local.on('PATCH','/sessions/:id',call=>({...session('ses_a','/work/a'),permission:(call.body as {permission:unknown}).permission}));
  local.on('GET','/permissions',()=>[]);
  await store.setAccessMode('full');expect(store.pendingInteraction('ses_a').permissions).toEqual([]);
});
it('a reply event during reconciliation wins over an older permissions snapshot',async()=>{
  await store.setDirectory('/work/a');await store.selectSession('ses_a');const first=permissionRequest('race-first'),second=permissionRequest('race-second');
  local.emit({type:'permission.asked',properties:first} as never);local.emit({type:'permission.asked',properties:second} as never);
  local.on('POST','/permissions/:id/reply',()=>undefined);
  let finish!:(value:unknown)=>void,readStarted=false;const read=new Promise(resolve=>{finish=resolve;});local.on('GET','/permissions',()=>{readStarted=true;return read;});
  const answer=store.replyPermission(first,'always');await vi.waitFor(()=>expect(readStarted).toBe(true));
  local.emit({type:'permission.replied',properties:{sessionID:'ses_a',requestID:second.id,reply:'once'}} as never);
  const newer={...permissionRequest('newer'),permission:'edit'};local.emit({type:'permission.asked',properties:newer} as never);
  finish([first,second]);await answer;expect(store.pendingInteraction('ses_a').permissions.map((p:{id:string})=>p.id)).toEqual(['newer']);
});

it('a lost ACK is reconciled by reading pending requests without replay or a false approval claim',async()=>{
  await store.setDirectory('/work/a');await store.selectSession('ses_a');const req=permissionRequest('lost-ack');
  local.emit({type:'permission.asked',properties:req} as never);
  local.on('POST','/permissions/:id/reply',()=>{throw new TypeError('lost response');});local.on('GET','/permissions',()=>[]);
  expect(await store.replyPermission(req,'always')).toBe(false);
  expect(local.made('POST','/permissions/:id/reply')).toHaveLength(1);expect(store.pendingInteraction('ses_a').permissions).toEqual([]);
});
it('fallback snapshots remove permissions answered while the event stream was away',async()=>{
  await store.setDirectory('/work/a');await store.selectSession('ses_a');const req=permissionRequest('snapshot-stale');
  local.emit({type:'permission.asked',properties:req} as never);
  const {emptySnapshot}=await import('./helpers/runtime-fixture');local.on('GET','/snapshot',()=>emptySnapshot());
  await store.restorePiRuntime('/work/a');expect(store.pendingInteraction('ses_a').permissions).toEqual([]);
});
it('question replies arriving during a fallback snapshot cannot reappear from its old result',async()=>{
  await store.setDirectory('/work/a');await store.selectSession('ses_a');
  const req={id:'question-race',sessionID:'ses_a',questions:[{question:'Fixture?'}]};local.emit({type:'question.asked',properties:req} as never);
  const {emptySnapshot}=await import('./helpers/runtime-fixture');let finish!:(v:unknown)=>void,started=false;const snapshot=new Promise(resolve=>{finish=resolve;});
  local.on('GET','/snapshot',()=>{started=true;return snapshot;});const restoring=store.restorePiRuntime('/work/a');await vi.waitFor(()=>expect(started).toBe(true));
  local.emit({type:'question.replied',properties:{sessionID:'ses_a',requestID:req.id,answers:[['yes']]}} as never);
  finish({...emptySnapshot(),questions:[req]});await restoring;expect(store.pendingInteraction('ses_a').questions).toEqual([]);
});
it('a confirmed question answer invalidates older snapshots even if its event was lost',async()=>{
  await store.setDirectory('/work/a');await store.selectSession('ses_a');
  const req={id:'question-ack',sessionID:'ses_a',questions:[{question:'Fixture?'}]};local.emit({type:'question.asked',properties:req} as never);
  const {emptySnapshot}=await import('./helpers/runtime-fixture');let finish!:(v:unknown)=>void,started=false;const snapshot=new Promise(resolve=>{finish=resolve;});
  local.on('GET','/snapshot',()=>{started=true;return snapshot;});const restoring=store.restorePiRuntime('/work/a');await vi.waitFor(()=>expect(started).toBe(true));
  local.on('POST','/questions/:id/reply',()=>undefined);expect(await store.replyQuestion(req,[['yes']])).toBe(true);
  finish({...emptySnapshot(),questions:[req]});await restoring;expect(store.pendingInteraction('ses_a').questions).toEqual([]);
});
