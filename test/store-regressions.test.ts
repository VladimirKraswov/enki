vi.mock("../src/operations/ownership", () => ({ownWork: vi.fn(async () => {})}));
import { beforeEach, expect, it, vi } from "vitest";
const captured = vi.hoisted(() => ({ stream: null as any }));
vi.mock("../src/api/events", () => ({
  globalEventStreamUrl: () => "http://localhost/global/event",
  eventStreamUrl: () => "http://127.0.0.1:4096/event",
  runEventStream: vi.fn((opts) => {
    captured.stream = opts;
    return Promise.resolve();
  }),
}));
let store: any;
const session = (id: string, directory = "/test/A", agent = "qwen-build") => ({
  id,
  directory,
  title: id,
  projectID: "test",
  agent,
  time: { created: 1, updated: 1 },
});
const flush = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};
it('Hub readiness holds the original prompt and reserves the model before exactly one engine dispatch', async () => {
  store.state = {...store.state, activeSessionId: 'ses_a', sessions: [session('ses_a')], connectedProviderIds: ['local-qwen-next']};
  store.commitModelChoice('local-qwen-next', 'qwen38-flash-next', 'medium'); store.setDraft('write a story');
  const {HubModelServices} = await import('../src/models/hub');
  const {modelServices} = await import('../src/models/services');
  let ready = false;
  const calls: string[] = [];
  const route = {service:'gpu',label:'GPU',providerID:'local-qwen-next',modelID:'qwen38-flash-next',target:'qwen38-flash-next',agent:'opencode'};
  const hub = new HubModelServices({identity:async()=> 'hub-test',request:async(path,body:any)=>{
    calls.push(path + ':' + (body?.mode ?? ''));
    if(path==='catalog')return {schema:1,routes:[route]} as any;
    return {schema:1,operation_id:'12345678-1234-1234-1234-123456789012',phase:ready?'ready':'loading',ready,
      active_model:ready?route.target:null,target_model:route.target,elapsed_seconds:1,active_requests:0,error:null,loader:null} as any;
  }});
  modelServices.attachHub(hub); await hub.refresh();
  const prompt = vi.spyOn(store.client,'prompt').mockResolvedValue(undefined);
  const sending = store.sendPrompt('write a story');
  await vi.waitFor(()=>expect(calls).toContain('prepare:select'));
  expect(prompt).not.toHaveBeenCalled(); expect(store.getDraft()).toBe('write a story');
  ready = true;
  expect(await sending).toBe(true); expect(prompt).toHaveBeenCalledOnce();
  expect(calls).toContain('prepare:run');
  expect(prompt.mock.calls[0][2].parts[0]).toEqual({type:'text',text:'write a story'});
});
it('Stop while Hub is loading withdraws preparation, preserves the draft and never sends to the agent', async () => {
  store.state = {...store.state, activeSessionId:'ses_a',sessions:[session('ses_a')],connectedProviderIds:['local-qwen-next']};
  store.commitModelChoice('local-qwen-next','qwen38-flash-next','medium'); store.setDraft('keep me');
  const {HubModelServices} = await import('../src/models/hub');
  const {modelServices} = await import('../src/models/services');
  const route = {service:'gpu',label:'GPU',providerID:'local-qwen-next',modelID:'qwen38-flash-next',target:'qwen38-flash-next',agent:'opencode'};
  const request = vi.fn(async(path:string)=>path==='catalog'?{schema:1,routes:[route]}:{schema:1,operation_id:'12345678-1234-1234-1234-123456789012',phase:'loading',ready:false,
    active_model:null,target_model:route.target,elapsed_seconds:1,active_requests:0,error:null,loader:null});
  const hub = new HubModelServices({identity:async()=> 'hub-test',request:request as any});
  modelServices.attachHub(hub); await hub.refresh();
  const prompt = vi.spyOn(store.client,'prompt').mockResolvedValue(undefined);
  const sending = store.sendPrompt('keep me');
  await vi.waitFor(()=>expect(request.mock.calls.some(([p])=>p==='prepare')).toBe(true));
  store.cancelPreparation();
  expect(await sending).toBe(false); expect(store.getDraft()).toBe('keep me'); expect(prompt).not.toHaveBeenCalled();
  await vi.waitFor(()=>expect(request.mock.calls.some(([p])=>p==='release')).toBe(true));
});
it('a reservation failure after creating the first chat leaves the prompt in that chat draft', async()=>{
  store.state={...store.state,activeSessionId:null,sessions:[],connectedProviderIds:['local-qwen-next']};
  store.commitModelChoice('local-qwen-next','qwen38-flash-next','medium');store.setDraft('preserve first prompt');
  vi.spyOn(store.client,'createSession').mockResolvedValue(session('ses_created'));
  const {modelServices}=await import('../src/models/services');
  vi.spyOn(modelServices,'reserve').mockRejectedValue(new Error('Hub offline'));
  const prompt=vi.spyOn(store.client,'prompt').mockResolvedValue(undefined);
  expect(await store.sendPrompt('preserve first prompt')).toBe(false);
  expect(store.state.activeSessionId).toBe('ses_created');expect(store.getDraft()).toBe('preserve first prompt');expect(prompt).not.toHaveBeenCalled();
});
it('routes access changes to Pi and keeps OpenCode out of its permissions', async () => {
  const piSession = { ...session('pi:access'), permission: [] };
  store.state.activeSessionId = piSession.id;
  store.state.sessions = [piSession];
  store.state.prefs.sessionEngine = { [piSession.id]: 'pi' };
  const pi = store.engine('pi');
  const updated = vi.spyOn(pi, 'updateSession').mockImplementation(async (_id: unknown, patch: any) => ({ ...piSession, ...patch }));
  const wrong = vi.spyOn(store.backend, 'updateSession');
  await store.setAccessMode('full');
  expect(updated).toHaveBeenCalledOnce();
  expect(wrong).not.toHaveBeenCalled();
  expect(store.getAccessMode()).toBe('full');
});
it('OpenCode reconnect cannot erase a running Pi session or another project', async () => {
  const { emptySessionChat } = await import('../src/state/chatReducer');
  store.state.prefs.sessionEngine = { 'pi:active': 'pi' };
  store.state.chat.sessions = {
    'pi:active': { ...emptySessionChat(), status: { type: 'busy' } },
    'ses_other': { ...emptySessionChat(), status: { type: 'busy' } },
    'ses_stale': { ...emptySessionChat(), status: { type: 'busy' } },
  };
  store.activityDirectories.set('ses_other', '/other');
  await store.resyncAfterReconnect('/test/A', store.directoryGeneration, false);
  expect(store.state.chat.sessions['pi:active'].status.type).toBe('busy');
  expect(store.state.chat.sessions.ses_other.status.type).toBe('busy');
  expect(store.state.chat.sessions.ses_stale.status.type).toBe('idle');
});
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  captured.stream = null;
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  const journal = (await import('../src/operations/journal')).operationJournal;
  // These regressions exercise store routing. Native durability is independently
  // fault-tested; a mocked native host has no SQLite IPC bridge.
  vi.spyOn(journal as any, 'storage').mockReturnValue({list: async () => [], write: async () => {}});
  store = (await import("../src/state/store")).store;
  store.state = {
    ...store.state,
    connection: { ...store.state.connection, phase: "connected" },
  };
  vi.spyOn(store.client, "vcs").mockResolvedValue(null);
  vi.spyOn(store.client, "listSessions").mockResolvedValue([]);
  vi.spyOn(store.client, "sessionStatuses").mockResolvedValue({});
  vi.spyOn(store.client, "pendingPermissions").mockResolvedValue([]);
  vi.spyOn(store.client, "pendingQuestions").mockResolvedValue([]);
  vi.spyOn(store.client, "messages").mockResolvedValue({ messages: [] });
  // Project switches reload metadata as well. Keep these unit tests independent
  // of an owner's running server and its response time.
  vi.spyOn(store.client, "providers").mockResolvedValue({ all: [], connected: [], default: {} });
  vi.spyOn(store.client, "agents").mockResolvedValue([]);
  vi.spyOn(store.client, "config").mockResolvedValue({});
  vi.spyOn(store, "configureSharedTools").mockResolvedValue(undefined);
  await store.setDirectory("/test/A");
});
it("R1: session.created must not invalidate the current project SSE stream", async () => {
  const stream = captured.stream;
  stream.onEvent({
    type: "session.created",
    properties: { info: session("ses_new") },
  });
  await flush();
  stream.onEvent({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_new",
        sessionID: "ses_new",
        role: "user",
        time: { created: 2 },
      },
    },
  });
  expect(store.state.chat.sessions.ses_new?.messages.msg_new).toBeDefined();
});
it("R2: an explicit agent selection must override the old session agent", () => {
  store.state = {
    ...store.state,
    activeSessionId: "ses_a",
    sessions: [session("ses_a")],
  };
  store.setAgentOverride("/test/A", "plan");
  expect(store.getAgentChoice()).toBe("plan");
});
it("R3: a late session creation from project A must not select it inside project B", async () => {
  let resolve!: (s: unknown) => void;
  vi.spyOn(store.client, "createSession").mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = store.createSessionNow("A task");
  await store.setDirectory("/test/B");
  resolve(session("ses_a"));
  await pending;
  expect(store.state.directory).toBe("/test/B");
  expect(store.state.activeSessionId).not.toBe("ses_a");
  expect(store.state.sessions.some((s: any) => s.id === "ses_a")).toBe(false);
});
it("R4: reconnect must replace stale busy status with authoritative idle", async () => {
  captured.stream.onEvent({
    type: "session.status",
    properties: { sessionID: "ses_a", status: { type: "busy" } },
  });
  store.state = {
    ...store.state,
    activeSessionId: "ses_a",
    sessions: [session("ses_a")],
  };
  vi.mocked(store.client.listSessions).mockResolvedValue([session("ses_a")]);
  vi.mocked(store.client.sessionStatuses).mockResolvedValue({
    ses_a: { type: "idle" },
  });
  captured.stream.onState("open");
  await flush();
  expect(store.state.chat.sessions.ses_a.status.type).toBe("idle");
});
it("R5: accepting a prompt must preserve a new draft typed while awaiting acknowledgement", async () => {
  store.state = {
    ...store.state,
    activeSessionId: "ses_a",
    sessions: [session("ses_a")],
    connectedProviderIds: ["local-qwen-next"],
  };
  store.setModelChoice("local-qwen-next", "qwen38-flash-next", "medium");
  let resolve!: () => void;
  vi.spyOn(store.client, "prompt").mockImplementation(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  const pending = store.sendPrompt("first task");
  store.setDraft("next task typed during request");
  await flush();
  resolve();
  await pending;
  expect(store.getDraft()).toBe("next task typed during request");
});

it('workshop manual requests carry the permanent release authorization without changing the draft',async()=>{
 const s=session('workshop');store.state.activeSessionId=s.id;store.state.sessions=[s];
 store.state.prefs.workshop={directory:s.directory,sourceDirectory:'/source',session:s};
 store.state.connectedProviderIds=['p'];store.setModelChoice('p','m','medium');
 const prompt=vi.spyOn(store.client,'prompt').mockResolvedValue(undefined);
 expect(await store.sendPrompt('Исправь цвет')).toBe(true);
 const body=prompt.mock.calls[0][2];expect(body.parts[0]).toEqual({type:'text',text:'Исправь цвет'});
 expect(body.parts.find(p=>p.type==='text' && p.metadata?.arvelaWorkshopRelease)).toMatchObject({type:'text',synthetic:true,metadata:{arvelaWorkshopRelease:1}});
 expect(body.variant).toBe('medium');
});

it('workshop queued corrections retain release authorization when steering now',async()=>{
 const s=session('workshop');store.state.activeSessionId=s.id;store.state.sessions=[s];
 store.state.prefs.workshop={directory:s.directory,sourceDirectory:'/source',session:s};
 store.state.connectedProviderIds=['p'];store.setModelChoice('p','m','medium');store.state.statuses[s.id]={type:'busy'};
 const prompt=vi.spyOn(store.client,'prompt').mockResolvedValue(undefined);
 expect(store.enqueuePrompt('Также исправь тест')).toBe(true);
 await store.steerQueued(store.getQueue()[0].id);
 expect(prompt).toHaveBeenCalledOnce();expect(prompt.mock.calls[0][2].parts.find(p=>p.type==='text' && p.metadata?.arvelaWorkshopRelease)).toMatchObject({synthetic:true,metadata:{arvelaWorkshopRelease:1}});
});

it('Stop during manual preparation prevents a late POST and retains the draft', async () => {
  store.state = { ...store.state, activeSessionId: 'ses_a', sessions: [session('ses_a')], connectedProviderIds: ['local-qwen-next'] };
  store.setModelChoice('local-qwen-next', 'qwen38-flash-next', 'medium');
  store.setDraft('keep this draft');
  let ready!: () => void;
  vi.mocked(store.configureSharedTools).mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve; }));
  vi.spyOn(store.client, 'prompt').mockResolvedValue(undefined);
  vi.spyOn(store.client, 'abort').mockResolvedValue(undefined);
  const sending = store.sendPrompt('keep this draft');
  await flush();
  await store.stopSession('ses_a');
  ready();
  expect(await sending).toBe(false);
  expect(store.client.prompt).not.toHaveBeenCalled();
  expect(store.getDraft()).toBe('keep this draft');
});

it('leaving and returning to a chat invalidates its unfinished manual preparation', async () => {
  store.state = { ...store.state, activeSessionId: 'ses_a', sessions: [session('ses_a')], connectedProviderIds: ['local-qwen-next'] };
  store.setModelChoice('local-qwen-next', 'qwen38-flash-next', 'medium');
  let ready!: () => void;
  vi.mocked(store.configureSharedTools).mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve; }));
  vi.spyOn(store.client, 'prompt').mockResolvedValue(undefined);
  const sending = store.sendPrompt('old preparation');
  await flush();
  await store.selectSession('ses_b');
  await store.selectSession('ses_a');
  ready();
  expect(await sending).toBe(false);
  expect(store.client.prompt).not.toHaveBeenCalled();
});

it('completion of cancelled preparation cannot unlock a newer send in another chat', async () => {
  store.state = { ...store.state, activeSessionId: 'ses_a', sessions: [session('ses_a')], connectedProviderIds: ['local-qwen-next'] };
  store.setModelChoice('local-qwen-next', 'qwen38-flash-next', 'medium');
  const ready: Array<() => void> = [];
  vi.mocked(store.configureSharedTools).mockImplementation(() => new Promise<void>(resolve => { ready.push(resolve); }));
  const prompt = vi.spyOn(store.client, 'prompt').mockResolvedValue(undefined);
  const old = store.sendPrompt('old'); await flush();
  await store.selectSession('ses_b');
  store.setModelChoice('local-qwen-next', 'qwen38-flash-next', 'medium');
  const current = store.sendPrompt('current'); await flush();
  expect(ready).toHaveLength(2);
  ready[0](); await old;
  expect(store.state.ui.sending).toBe(true);
  ready[1](); expect(await current).toBe(true);
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(prompt.mock.calls[0][0]).toBe('ses_b');
  expect(store.state.ui.sending).toBe(false);
});

it('leaving and returning to a chat invalidates unfinished queued preparation', async () => {
  store.state = { ...store.state, activeSessionId: 'ses_a', sessions: [session('ses_a')], statuses: { ses_a: { type: 'busy' } }, connectedProviderIds: ['local-qwen-next'] };
  store.setModelChoice('local-qwen-next', 'qwen38-flash-next', 'medium');
  const { modelServices } = await import('../src/models/services');
  let ready!: () => void;
  vi.spyOn(modelServices, 'ensure').mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve; }));
  const prompt = vi.spyOn(store.client, 'prompt').mockResolvedValue(undefined);
  expect(store.enqueuePrompt('queued')).toBe(true);
  const sending = store.steerQueued(store.getQueue()[0].id);
  await flush();
  await store.selectSession('ses_b'); await store.selectSession('ses_a');
  ready(); await sending;
  expect(prompt).not.toHaveBeenCalled();
  expect(store.getQueue()[0].state).toBe('ready');
  expect(store.isQueueArmed()).toBe(false);
});

it('Stop after a POST keeps acknowledgement ownership and clears only its submitted draft', async () => {
  store.state = { ...store.state, activeSessionId: 'ses_a', sessions: [session('ses_a')], connectedProviderIds: ['local-qwen-next'] };
  store.setModelChoice('local-qwen-next', 'qwen38-flash-next', 'medium');
  store.setDraft('submitted');
  let acknowledge!: () => void;
  const prompt = vi.spyOn(store.client, 'prompt').mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve; }));
  vi.spyOn(store.client, 'abort').mockResolvedValue(undefined);
  const sending = store.sendPrompt('submitted');
  await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
  await store.stopSession('ses_a');
  expect(store.state.ui.sending).toBe(true);
  acknowledge();
  expect(await sending).toBe(true);
  expect(store.getDraft()).toBe('');
  expect(store.state.ui.sending).toBe(false);
  expect(prompt).toHaveBeenCalledOnce();
});

it("waits for local browser MCP attachment before delivering the first prompt", async () => {
  const images=await import("../src/images/context");
  const staged=vi.spyOn(images,"stageImagePromptContext").mockResolvedValue(undefined);
  const platform = await import("../src/native/platform");
  vi.spyOn(platform, "isNative").mockReturnValue(true);
  store.state = { ...store.state, activeSessionId: "ses_a", sessions: [session("ses_a")],
    connectedProviderIds: ["local-qwen-next"], prefs: { ...store.state.prefs, browser: { enabled: true } } };
  store.setModelChoice("local-qwen-next", "qwen38-flash-next", "medium");
  let resolve!: () => void;
  const setup = vi.spyOn(store, "configureBrowser").mockReturnValue(new Promise<void>(r => { resolve = r; }));
  const prompt = vi.spyOn(store.client, "prompt").mockResolvedValue(undefined);
  const pending = store.sendPrompt("Use the built-in browser");
  await flush(); expect(setup).toHaveBeenCalledOnce(); expect(prompt).not.toHaveBeenCalled();
  resolve(); await pending; expect(prompt).toHaveBeenCalledOnce();
  expect(staged).toHaveBeenCalledWith(expect.objectContaining({engine:"opencode",sessionId:"ses_a",directory:"/test/A",parts:[],local:true}));
  expect(staged.mock.calls[0][0].messageId).toBe(prompt.mock.calls[0][2].messageID);
});

it("does not attach local browser tools when delivering to a remote endpoint", async () => {
  const platform = await import("../src/native/platform");
  vi.spyOn(platform, "isNative").mockReturnValue(true);
  store.state = { ...store.state, activeSessionId: "ses_a", sessions: [session("ses_a")],
    connectedProviderIds: ["local-qwen-next"], prefs: { ...store.state.prefs, endpoint: "http://192.168.1.22:4096", browser: { enabled: true } } };
  store.setModelChoice("local-qwen-next", "qwen38-flash-next", "medium");
  const setup = vi.spyOn(store, "configureBrowser").mockResolvedValue(undefined);
  const prompt = vi.spyOn(store.client, "prompt").mockResolvedValue(undefined);
  await store.sendPrompt("Remote task"); expect(setup).not.toHaveBeenCalled(); expect(prompt).toHaveBeenCalledOnce();
});

it("aborts a session with its own project directory, not whichever project is open", async () => {
  // The sidebar shows running work from other projects. Aborting used the open
  // project's directory, so OpenCode answered 404 and the run kept going.
  const abort = vi.spyOn(store.client, "abort").mockResolvedValue(undefined);
  vi.mocked(store.client.listSessions).mockImplementation(async (dir: string) =>
    dir === "/test/B" ? [session("ses_other", "/test/B")] : [],
  );
  await store.setDirectory("/test/B");
  vi.spyOn(store, "configureSharedTools").mockResolvedValue(undefined);
  await store.setDirectory("/test/A");
  await store.stopSession("ses_other");
  expect(abort).toHaveBeenCalledWith("ses_other", "/test/B");
});

it("routes a stop to the project the session was created in, not the one now open", async () => {
  // A chat started in project A keeps running while the user moves to project B.
  // Aborting it with B's directory made OpenCode answer 404 and the run continued.
  store.state = {
    ...store.state,
    connectedProviderIds: ["local-qwen-next"],
  };
  store.setModelChoice("local-qwen-next", "qwen38-flash-next", "medium");
  vi.spyOn(store.client, "createSession").mockResolvedValue(
    session("ses_created", "/test/A"),
  );
  vi.spyOn(store.client, "prompt").mockResolvedValue(undefined);
  const abort = vi.spyOn(store.client, "abort").mockResolvedValue(undefined);
  expect(await store.sendPrompt("long task")).toBe(true);
  expect(store.state.activeSessionId).toBe("ses_created");

  await store.setDirectory("/test/B");
  await store.stopSession("ses_created");
  expect(abort).toHaveBeenCalledWith("ses_created", "/test/A");
});

const scheduled = () => ({ id: "job", server: store.state.prefs.workspaceKey ?? store.state.prefs.endpoint, directory: "/test/A", sessionID: "ses_a", engine: "opencode", title: "CI", prompt: "check", minutes: 15, model: { providerID: "local-qwen-next", modelID: "qwen38-flash-next", variant: "medium" }, enabled: true, nextAt: 0, state: "ready" as const });
const scheduledSetup = () => {
 store.state = { ...store.state, activeSessionId: "ses_a", sessions: [session("ses_a")], connection: { ...store.state.connection, streamState: "open" } };
 vi.spyOn(store.client, "getSession").mockResolvedValue(session("ses_a"));
};
it("scheduled prompts preserve drafts, attachments and the saved reasoning model", async()=>{
 scheduledSetup();store.setDraft("user typing");const prompt=vi.spyOn(store.client,"prompt").mockResolvedValue(undefined);
 expect(await store.runScheduledTask(scheduled())).toEqual({kind:"sent"});expect(store.getDraft()).toBe("user typing");
 expect(prompt).toHaveBeenCalledWith("ses_a","/test/A",expect.objectContaining({model:{providerID:"local-qwen-next",modelID:"qwen38-flash-next"},variant:"medium",parts:[{type:"text",text:"check"},expect.objectContaining({type:"text",synthetic:true,metadata:{enkiScheduleWake:1}}),expect.objectContaining({synthetic:true,metadata:{arvelaResponseLanguage:1}}),expect.objectContaining({synthetic:true,metadata:{arvelaToolWorkflow:1}}),expect.objectContaining({synthetic:true,metadata:{enkiSchedules:1}})]}));
});
it('scheduled workshop prompts also retain permanent release authorization',async()=>{
 scheduledSetup();const s=session('ses_a');store.state.prefs.workshop={directory:s.directory,sourceDirectory:'/source',session:s};
 const prompt=vi.spyOn(store.client,'prompt').mockResolvedValue(undefined);
 expect(await store.runScheduledTask(scheduled())).toEqual({kind:'sent'});
 expect(prompt.mock.calls[0][2].parts.find(p=>p.type==='text' && p.metadata?.arvelaWorkshopRelease)).toMatchObject({synthetic:true,metadata:{arvelaWorkshopRelease:1}});
});
it('cancelling a scheduled task during model readiness never sends it afterward', async () => {
  scheduledSetup();
  const { modelServices } = await import('../src/models/services');
  let ready!: () => void;
  vi.spyOn(modelServices, 'ensure').mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve; }));
  const prompt = vi.spyOn(store.client, 'prompt').mockResolvedValue(undefined);
  const cancel = new AbortController();
  const operation = store.runScheduledTask(scheduled(), cancel.signal);
  await vi.waitFor(() => expect(ready).toBeTypeOf('function'));
  cancel.abort(); ready();
  expect(await operation).toEqual({ kind: 'cancelled' });
  expect(prompt).not.toHaveBeenCalled();
});
it('Stop during scheduled readiness prevents a late POST even without scheduler cancellation', async () => {
  scheduledSetup();
  const { modelServices } = await import('../src/models/services');
  let ready!: () => void;
  vi.spyOn(modelServices, 'ensure').mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve; }));
  const prompt = vi.spyOn(store.client, 'prompt').mockResolvedValue(undefined);
  vi.spyOn(store.client, 'abort').mockResolvedValue(undefined);
  const operation = store.runScheduledTask(scheduled());
  await vi.waitFor(() => expect(ready).toBeTypeOf('function'));
  await store.stopSession('ses_a'); ready();
  expect(await operation).toEqual({ kind: 'cancelled' });
  expect(prompt).not.toHaveBeenCalled();
});
it("scheduled prompts never route to another server or bypass a pending permission",async()=>{
 scheduledSetup();const prompt=vi.spyOn(store.client,"prompt").mockResolvedValue(undefined);
 expect((await store.runScheduledTask({...scheduled(),server:"other"})).kind).toBe("waiting");
 vi.mocked(store.client.pendingPermissions).mockResolvedValue([{id:"approval",sessionID:"ses_a"}] as any);
 expect((await store.runScheduledTask(scheduled())).kind).toBe("waiting");expect(prompt).not.toHaveBeenCalled();
});
it("scheduled preflight is cancelled by a connection switch and locks manual sends",async()=>{
 scheduledSetup();let resolve!:(s:unknown)=>void;vi.mocked(store.client.getSession).mockImplementation(()=>new Promise(r=>{resolve=r;}));
 const prompt=vi.spyOn(store.client,"prompt").mockResolvedValue(undefined),pending=store.runScheduledTask(scheduled());
 expect(await store.sendPrompt("manual")).toBe(false);store.connectionGeneration++;resolve(session("ses_a"));
 expect((await pending).kind).toBe("waiting");expect(prompt).not.toHaveBeenCalled();
});
it("rechecks busy state after asynchronous setup, rejects archived and changed-engine chats",async()=>{
 scheduledSetup();const prompt=vi.spyOn(store.client,"prompt").mockResolvedValue(undefined);
 vi.mocked(store.client.sessionStatuses).mockResolvedValueOnce({}).mockResolvedValueOnce({ses_a:{type:"busy"}});
 expect((await store.runScheduledTask(scheduled())).kind).toBe("waiting");expect(prompt).not.toHaveBeenCalled();
 vi.mocked(store.client.getSession).mockResolvedValue({...session("ses_a"),time:{created:1,updated:1,archived:2}});
 await expect(store.runScheduledTask(scheduled())).rejects.toThrow();
 await expect(store.runScheduledTask({...scheduled(),engine:"pi"})).rejects.toThrow();
});
it("a deleted chat, a vanished model and a server refusal are definite non-deliveries, not uncertain ones",async()=>{
 const { ApiError } = await import("../src/api/client"), { ScheduleBlocked } = await import("../src/schedules/tasks");
 scheduledSetup();const prompt=vi.spyOn(store.client,"prompt").mockResolvedValue(undefined);
 vi.mocked(store.client.getSession).mockRejectedValueOnce(new ApiError(404,"secret body"));
 await expect(store.runScheduledTask(scheduled())).rejects.toBeInstanceOf(ScheduleBlocked);
 vi.mocked(store.client.providers).mockResolvedValueOnce({all:[{id:"local-qwen-next",models:{other:{id:"other",providerID:"local-qwen-next"}}}],connected:["local-qwen-next"],default:{}});
 await expect(store.runScheduledTask(scheduled())).rejects.toThrow(/qwen38-flash-next/);
 expect(prompt).not.toHaveBeenCalled();
 prompt.mockRejectedValueOnce(new ApiError(400,"secret body"));
 const refused=store.runScheduledTask(scheduled());
 await expect(refused).rejects.toBeInstanceOf(ScheduleBlocked);await expect(refused).rejects.not.toThrow(/secret/);
});
it("a withdrawn or failed read-only check sends nothing and is simply retried later",async()=>{
 scheduledSetup();const prompt=vi.spyOn(store.client,"prompt").mockResolvedValue(undefined);
 vi.mocked(store.client.getSession).mockImplementationOnce(()=>new Promise(()=>{}));
 const abort=new AbortController(),pending=store.runScheduledTask(scheduled(),abort.signal);abort.abort();
 expect(await pending).toEqual({kind:"cancelled"});
 vi.mocked(store.client.sessionStatuses).mockRejectedValueOnce(new Error("network"));
 expect((await store.runScheduledTask(scheduled())).kind).toBe("waiting");expect(prompt).not.toHaveBeenCalled();
 // Every lock was released: the next check proceeds and sends exactly once.
 expect(await store.runScheduledTask(scheduled())).toEqual({kind:"sent"});expect(prompt).toHaveBeenCalledOnce();
});
it("a manual send blocked by a scheduled check explains itself and keeps the draft",async()=>{
 scheduledSetup();store.setDraft("mine");let resolve!:(s:unknown)=>void;
 vi.mocked(store.client.getSession).mockImplementation(()=>new Promise(r=>{resolve=r;}));
 vi.spyOn(store.client,"prompt").mockResolvedValue(undefined);const pending=store.runScheduledTask(scheduled());
 expect(await store.sendPrompt("mine")).toBe(false);expect(store.state.ui.sendError).toMatch(/запланированное/);expect(store.getDraft()).toBe("mine");
 resolve(session("ses_a"));await pending;
});

it("browser profile selects real Low only in the explicit chat and preserves manual Medium", async () => {
  store.state = { ...store.state, activeSessionId: "ses_a", sessions: [session("ses_a")], connectedProviderIds:["local-qwen-next"],
    providers:[{id:"local-qwen-next",models:{"qwen38-flash-next":{id:"qwen38-flash-next",providerID:"local-qwen-next",capabilities:{reasoning:true},variants:{low:{},medium:{}}}}}] };
  store.setModelChoice("local-qwen-next","qwen38-flash-next","medium");
  const beforeGlobal = store.state.prefs.modelChoice["*"];
  store.setBrowserTask(true); expect(store.getModelChoice().variant).toBe("low");
  const prompt = vi.spyOn(store.client,"prompt").mockResolvedValue(undefined);
  await store.sendPrompt("Navigate the fixture");
  expect(prompt.mock.calls[0][2].variant).toBe("low");
  expect(store.state.prefs.modelChoice["*"]).toEqual(beforeGlobal);
  store.state.chat.sessions.ses_a.status={type:"idle"};
  store.setModelChoice("local-qwen-next","qwen38-flash-next","medium");
  store.setBrowserTask(false); expect(store.getModelChoice().variant).toBe("medium");
  store.state.activeSessionId="ses_b"; expect(store.browserTaskActive()).toBe(false);
});
it("does not silently substitute unsupported Low or change a running browser chat", () => {
  store.state = { ...store.state, activeSessionId:"ses_a", sessions:[session("ses_a")], connectedProviderIds:["local-qwen-next"],
    providers:[{id:"local-qwen-next",models:{"qwen38-flash-next":{id:"qwen38-flash-next",providerID:"local-qwen-next",variants:{medium:{}}}}}] };
  store.setModelChoice("local-qwen-next","qwen38-flash-next","medium"); store.setBrowserTask(true);
  expect(store.getModelChoice().variant).toBe("medium");
  store.state.chat.sessions.ses_a={...store.state.chat.sessions.ses_a,status:{type:"busy"}};
  store.setBrowserTask(false); expect(store.browserTaskActive()).toBe(true);
});

it("retains an explicit manual Low when the browser profile is disabled", () => {
  store.state={...store.state,activeSessionId:"ses_a",sessions:[session("ses_a")],connectedProviderIds:["local-qwen-next"],providers:[{id:"local-qwen-next",models:{"qwen38-flash-next":{id:"qwen38-flash-next",providerID:"local-qwen-next",variants:{low:{},medium:{}}}}}]};
  store.setModelChoice("local-qwen-next","qwen38-flash-next","medium"); store.setBrowserTask(true);
  store.setModelChoice("local-qwen-next","qwen38-flash-next","low"); store.setBrowserTask(false);
  expect(store.getModelChoice().variant).toBe("low");
});

it("starts the browser before exposing a newly created browser task panel", async () => {
  const integration=await import("../src/browser/integration");
  vi.spyOn(store,"ensureChatWorkspace").mockImplementation(async () => { await store.setDirectory("/test/browser-owned"); return true; });
  vi.spyOn(store,"createSessionNow").mockImplementation(async () => {store.state.activeSessionId="browser-test"; return session("browser-test","/test/browser-owned");});
  vi.spyOn(store,"configureBrowser").mockResolvedValue(undefined);
  let resolve!: (value: unknown) => void;
  const started=vi.spyOn(integration,"openSessionBrowser").mockReturnValue(new Promise(r => {resolve=r;}));
  const pending=store.newBrowserTask(); await vi.waitFor(() => expect(started).toHaveBeenCalled());
  expect(started).toHaveBeenCalledWith({directory:"/test/browser-owned",engine:"opencode",sessionId:"browser-test"},expect.any(Function),null,null);
  expect(store.state.ui.browserOpen).toBe(false); resolve({browserOpen:true}); await pending;
  expect(store.state.ui.browserOpen).toBe(true);
});

it("waits for common tool preparation and preserves draft if preparation fails",async()=>{
 store.state={...store.state,activeSessionId:"ses_a",sessions:[session("ses_a")],connectedProviderIds:["local-qwen-next"]};
 store.setModelChoice("local-qwen-next","qwen38-flash-next","medium");
 store.setDraft("own draft");
 vi.spyOn(store,"configureSharedTools").mockRejectedValue(new Error("Shared MCP missing dependency"));
 const prompt=vi.spyOn(store.client,"prompt").mockResolvedValue(undefined);
 expect(await store.sendPrompt("own draft")).toBe(false);
 expect(prompt).not.toHaveBeenCalled();expect(store.getDraft()).toBe("own draft");
});

it("healthy transport with failed project reads preserves state and blocks dispatch until read-only recovery", async () => {
  const { ApiError } = await import("../src/api/client");
  store.state.activeSessionId = "ses_a";
  store.state.sessions = [session("ses_a")];
  store.state.chat.sessions.ses_a = { messages: {}, messageOrder: [], status: { type: "busy" } };
  store.state.prefs.queues = { ses_a: [{ id: "q", directory: "/test/A", text: "queued", state: "ready", model: {providerID:"p",modelID:"m"} }] };
  store.queueArmed.add("ses_a");
  const prompt = vi.spyOn(store.client, "prompt");
  vi.mocked(store.client.sessionStatuses).mockRejectedValue(new ApiError(500, "EPERM: lstat project"));
  await store.refreshSessions();
  expect(store.state.connection.phase).toBe("connected");
  expect(store.state.connection.statusError).toContain("отказ доступа");
  expect(store.state.activeSessionId).toBe("ses_a");
  expect(store.state.chat.sessions.ses_a).toBeDefined();
  expect(await store.sendPrompt("new prompt")).toBe(false);
  expect(store.queueArmed.has("ses_a")).toBe(false);
  vi.mocked(store.client.sessionStatuses).mockResolvedValue({});
  vi.mocked(store.client.listSessions).mockResolvedValue([session("ses_a")]);
  await store.retryProjectAccess();
  expect(store.state.connection.statusError).toBeNull();
  expect(store.state.activeSessionId).toBe("ses_a");
  expect(prompt).not.toHaveBeenCalled();
});
it("a late failure of project recovery does not contaminate the newly selected project", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(store.client.sessionStatuses).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const recovery = store.retryProjectAccess();
  await store.setDirectory("/test/B");
  reject(new Error("old A failure"));
  await recovery;
  expect(store.state.connection.statusError).toBeNull();
  expect(store.state.directory).toBe("/test/B");
});

it("a Pi listing failure does not mark the healthy OpenCode project inaccessible", async () => {
  vi.spyOn(store, "piListFor").mockRejectedValue(new Error("Pi listing failed"));
  await store.refreshSessions();
  expect(store.state.ui.sessionListError).toContain("Pi listing failed");
  expect(store.state.connection.statusError).toBeNull();
});

it('preserves full access when creating a Pi chat before its first prompt', async () => {
  store.state.activeSessionId = null;
  store.state.prefs.projectEngine = { '/test/A': 'pi' };
  store.state.prefs.newAccess = 'full';
  store.piInstalled = true;
  const created = await store.createSessionNow('Pi full access');
  expect(created).not.toBeNull();
  expect(store.state.prefs.piSessions[created.id].permission).toContainEqual({ permission: '*', pattern: '*', action: 'allow' });
  expect(store.getAccessMode()).toBe('full');
});
it('subscribes to Pi before the first Pi chat exists in a local project', () => {
  store.state.prefs.piSessions = {};
  store.state.prefs.projectEngine = {};
  const subscribe = vi.spyOn(store.engine('pi'), 'subscribeDirectory').mockImplementation(() => {});
  store.startPiStream('/test/A', store.directoryGeneration);
  expect(subscribe).toHaveBeenCalledWith('/test/A', expect.objectContaining({signal: expect.any(AbortSignal)}));
});

it('restores cleared Pi follow-ups in their original draft without replacing typed text', () => {
  store.state.prefs.drafts = { 'pi-origin': 'already typed', 'pi-other': 'other chat' };
  store.engine('pi').host.onQueueCleared('/test/A', 'pi-origin', ['correction', 'next']);
  expect(store.state.prefs.drafts['pi-origin']).toBe('already typed\n\ncorrection\n\nnext');
  expect(store.state.prefs.drafts['pi-other']).toBe('other chat');
  expect(store.state.prefs.drafts['/test/A']).toBeUndefined();
});
it('keeps recovered Pi text on the local computer after an SSH workspace switch', () => {
  store.state.prefs.endpoint = 'http://127.0.0.1:5555';
  store.state.prefs.workspaceKey = 'ssh:other';
  store.state.prefs.localEndpoint = 'http://127.0.0.1:4096';
  store.state.prefs.drafts = { 'pi-origin': 'remote untouched' };
  store.state.prefs.endpointState = { 'http://127.0.0.1:4096': { drafts: { 'pi-origin': 'local' } } };
  store.engine('pi').host.onQueueCleared('/test/A', 'pi-origin', ['restored']);
  expect(store.state.prefs.drafts['pi-origin']).toBe('remote untouched');
  expect(store.state.prefs.endpointState['http://127.0.0.1:4096'].drafts['pi-origin']).toBe('local\n\nrestored');
});
it('Stop cancels only its own Pi dialog before aborting the child', async () => {
  store.state.prefs.sessionEngine = { 'pi-dialog': 'pi' };
  store.state.ui.piDialog = { sessionId:'pi-dialog',key:'owned-key',request:{id:'question'} };
  const pi = store.engine('pi'), events: string[] = [];
  vi.spyOn(pi,'answerDialog').mockImplementation(async()=>{events.push('cancel');});
  vi.spyOn(pi,'abort').mockImplementation(async()=>{events.push('abort');});
  await store.stopSession('pi-dialog');
  expect(events).toEqual(['cancel','abort']);expect(store.state.ui.piDialog).toBeNull();
});

it('Pi approval remains visible on transport failure and is tied to its exact request', async () => {
  const pi = store.engine('pi');
  const dialog = {key: 'key', directory: '/test/A', sessionId: 'pi:test', request: {type: 'extension_ui_request', id:'one', method:'confirm'}};
  store.state.ui.piDialog = dialog;
  const post = vi.spyOn(pi, 'answerDialog').mockRejectedValueOnce(Error('pipe closed')).mockResolvedValue(undefined);
  await expect(store.answerPiDialog({confirmed:true}, {key:'key',id:'one'})).rejects.toThrow('pipe closed');
  expect(store.state.ui.piDialog).toBe(dialog);
  expect(store.state.ui.toast).toContain('не доставлен');
  await store.answerPiDialog({confirmed:true}, {key:'key',id:'old'});
  expect(post).toHaveBeenCalledTimes(1);
  await store.answerPiDialog({confirmed:true}, {key:'key',id:'one'});
  expect(post).toHaveBeenLastCalledWith('key','one',{confirmed:true});
  expect(store.state.ui.piDialog).toBeNull();
});
it('two Pi permission requests are queued, never overwritten or answered together', async () => {
  const pi = store.engine('pi');
  const request = (id: string) => ({key: id, directory:'/test/A',sessionId:id,request:{id,method:'confirm',type:'extension_ui_request'}});
  const post = vi.spyOn(pi,'answerDialog').mockResolvedValue(undefined);
  pi.host.onDialog(request('first')); pi.host.onDialog(request('second'));
  expect(store.state.ui.piDialog.request.id).toBe('first');
  await store.answerPiDialog({confirmed:true},{key:'first',id:'first'});
  expect(store.state.ui.piDialog.request.id).toBe('second');
  expect(post).toHaveBeenCalledTimes(1);
  pi.host.onDialogExpired('second','second');
  expect(store.state.ui.piDialog).toBeNull();
});

it('acknowledges dictation text and its receipt atomically and never appends it twice',()=>{
 store.state.prefs.drafts={voice:'Existing'};const workspace=store.state.prefs.workspaceKey??store.state.prefs.endpoint;
 store.appendDictation(workspace,'voice','новая фраза','dictation-receipt');
 store.appendDictation(workspace,'voice','новая фраза','dictation-receipt');
 expect(store.state.prefs.drafts.voice).toBe('Existing новая фраза');
 expect(store.state.prefs.dictationReceipts).toContain('dictation-receipt');
});
it('retains the receipt after a failed draft save, so retry persists without duplicating text',()=>{
 const workspace=store.state.prefs.workspaceKey??store.state.prefs.endpoint;
 const write=vi.spyOn(localStorage,'setItem').mockImplementationOnce(()=>{throw Error('disk full');});
 expect(()=>store.appendDictation(workspace,'voice','новый текст','failed-save-receipt')).toThrow(/сохранить/);
 store.appendDictation(workspace,'voice','новый текст','failed-save-receipt');
 expect(store.state.prefs.drafts.voice).toBe('новый текст');write.mockRestore();
});
it('delivers dictation to its original workspace even after navigation',()=>{
 const current=store.state.prefs.workspaceKey??store.state.prefs.endpoint;
 store.state.prefs.endpointState={...store.state.prefs.endpointState,old:{drafts:{voice:'Old'}}};
 store.appendDictation('old','voice','сохранено','old-workspace-receipt');
 expect(store.state.prefs.endpointState.old.drafts.voice).toBe('Old сохранено');
 expect(store.state.prefs.drafts.voice).toBeUndefined();expect(store.state.prefs.workspaceKey??store.state.prefs.endpoint).toBe(current);
});

it('compaction uses the selected session only and never resumes it automatically',async()=>{
 const {modelServices}=await import('../src/models/services');
 vi.spyOn(modelServices,'ensure').mockResolvedValue(undefined);
 const summarize=vi.spyOn(store.client,'summarize').mockResolvedValue(undefined);
 const prompt=vi.spyOn(store.client,'prompt').mockResolvedValue(undefined);
 store.state={...store.state,activeSessionId:'ses_a',sessions:[session('ses_a')],statuses:{},connectedProviderIds:['local-qwen-next']};
 store.setModelChoice('local-qwen-next','qwen38-flash-next','medium');
 await store.compactSession('another');expect(summarize).not.toHaveBeenCalled();
 await store.compactSession('ses_a');expect(summarize).toHaveBeenCalledExactlyOnceWith('ses_a','/test/A','local-qwen-next','qwen38-flash-next');
 expect(prompt).not.toHaveBeenCalled();
});
it('navigation or a new busy turn during compaction preparation prevents a late summary request',async()=>{
 const {modelServices}=await import('../src/models/services');
 let release!:()=>void;vi.spyOn(modelServices,'ensure').mockImplementation(()=>new Promise<void>(r=>release=r));
 const summarize=vi.spyOn(store.client,'summarize').mockResolvedValue(undefined);
 store.state={...store.state,activeSessionId:'ses_a',sessions:[session('ses_a')],statuses:{},connectedProviderIds:['local-qwen-next']};
 store.setModelChoice('local-qwen-next','qwen38-flash-next','medium');
 const first=store.compactSession('ses_a');await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
 store.state={...store.state,activeSessionId:'ses_b'};release();await first;expect(summarize).not.toHaveBeenCalled();
 store.state={...store.state,activeSessionId:'ses_a'};
 const next=store.compactSession('ses_a');await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
 store.observeSessionStatus('ses_a',{type:'busy'},'/test/A');release();await next;
 expect(summarize).not.toHaveBeenCalled();
});

it('a pending compaction blocks a racing manual prompt without clearing its draft',async()=>{
 const {modelServices}=await import('../src/models/services');vi.spyOn(modelServices,'ensure').mockResolvedValue(undefined);
 let finish!:()=>void;vi.spyOn(store.client,'summarize').mockImplementation(()=>new Promise<void>(r=>finish=r));
 const prompt=vi.spyOn(store.client,'prompt').mockResolvedValue(undefined);
 store.state={...store.state,activeSessionId:'ses_a',sessions:[session('ses_a')],statuses:{},connectedProviderIds:['local-qwen-next']};
 store.setModelChoice('local-qwen-next','qwen38-flash-next','medium');store.setDraft('keep my task');
 const pending=store.compactSession('ses_a');await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
 expect(await store.sendPrompt('keep my task')).toBe(false);expect(store.getDraft()).toBe('keep my task');expect(prompt).not.toHaveBeenCalled();
 finish();await pending;
});
it('switching chats cancels only the obsolete history read, preserving active agent state',async()=>{
 store.state={...store.state,activeSessionId:null,directory:'/test/A',sessions:[session('a'),session('b')]};
 let obsolete:AbortSignal|undefined;
 const messages=vi.spyOn(store.client,'messages').mockImplementation((id:any,opts:any)=>{
   if(id==='b')return Promise.resolve({messages:[]});
   obsolete=opts.signal;
   return new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true}));
 });
 const abort=vi.spyOn(store.client,'abort').mockResolvedValue(undefined);
 const first=store.selectSession('a');await flush();expect(obsolete?.aborted).toBe(false);
 await store.selectSession('b');await first;
 expect(obsolete?.aborted).toBe(true);expect(store.state.activeSessionId).toBe('b');
 expect(store.state.ui.historyError).toBeNull();expect(abort).not.toHaveBeenCalled();expect(messages).toHaveBeenCalledTimes(2);
});
it('shows a cached target immediately while project metadata is still loading, and respects a newer selection',async()=>{
 const {emptySessionChat}=await import('../src/state/chatReducer');
 const cached=emptySessionChat();store.state.chat.sessions.cached=cached;
 let ready!:(value:any)=>void;
 vi.spyOn(store.client,'providers').mockImplementation(()=>new Promise(resolve=>{ready=resolve;}));
 const opening=store.openChat(session('cached','/test/B'));
 expect(store.state.directory).toBe('/test/B');expect(store.state.activeSessionId).toBe('cached');
 expect(store.state.chat.sessions.cached).toBe(cached);expect(store.state.ui.runtimeLoading).toBe(true);
 await store.selectSession('newer');
 ready({all:[],connected:[],default:{}});await opening;
 expect(store.state.activeSessionId).toBe('newer');
});
it('invalidates shared and browser attachments on a global reload even without a session ID',async()=>{
 const capabilities=await import('../src/capabilities/integration'),browser=await import('../src/browser/integration');
 const shared=vi.spyOn(capabilities,'invalidateCapabilities'),attached=vi.spyOn(browser,'invalidateBrowserSetup');
 const backend=store.backend;let subscription:any;
 vi.spyOn(backend,'subscribeAll').mockImplementation((s:any)=>{subscription=s;});
 store.startGlobalStream(backend,store.connectionGeneration);
 subscription.onEvent({directory:'global',payload:{type:'global.disposed',properties:{}}});
 expect(shared).toHaveBeenCalledOnce();expect(attached).toHaveBeenCalledOnce();
});
