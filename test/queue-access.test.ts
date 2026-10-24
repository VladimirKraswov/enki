import { beforeEach, expect, it, vi } from "vitest";
import { accessRules, accessMode } from "../src/state/access";
import { newMessageId } from "../src/state/queue";
import { isQueuePausingError } from "../src/state/promptQueue";
vi.mock("../src/api/events", () => ({
  globalEventStreamUrl: () => "http://localhost/global/event",
  eventStreamUrl: () => "",
  runEventStream: vi.fn(() => Promise.resolve()),
}));
let store: any;
const flush = () => new Promise((r) => setTimeout(r, 0));
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  store = (await import("../src/state/store")).store;
  store.state = {
    ...store.state,
    directory: "/test",
    activeSessionId: "ses_a",
    connection: {
      ...store.state.connection,
      phase: "connected",
      streamState: "open",
    },
    statuses: { ses_a: { type: "busy" } },
    connectedProviderIds: ["p"],
  };
  store.setModelChoice("p", "m", "medium");
  vi.spyOn(store.client, "prompt").mockResolvedValue(undefined);
});
const status = (type: string) =>
  store.handleEvent({
    type: "session.status",
    properties: { sessionID: "ses_a", status: { type } },
  });
it('does not clear a text draft or arm a queue when durable storage fails', () => {
  store.setDraft('keep this task');
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  expect(store.enqueuePrompt('keep this task')).toBe(false);
  expect(store.getDraft()).toBe('keep this task');
  expect(store.getQueue()).toEqual([]);
  expect(store.isQueueArmed()).toBe(false);
  expect(store.state.ui.sendError).toContain('сохранить');
});

it("queues during generation, sends exactly once on idle, and retains captured model", async () => {
  store.setDraft("next");
  expect(store.enqueuePrompt("next")).toBe(true);
  expect(store.getDraft()).toBe("");
  expect(store.client.prompt).not.toHaveBeenCalled();
  store.setModelChoice("p", "other");
  status("idle");
  status("idle");
  await flush();
  expect(store.client.prompt).toHaveBeenCalledTimes(1);
  expect(store.client.prompt.mock.calls[0][2].model.modelID).toBe("m");
  expect(store.getQueue()).toEqual([]);
});
it("steers through the existing engine loop without aborting and ignores double clicks", async () => {
  const abort = vi.spyOn(store.client, "abort");
  store.enqueuePrompt("correction");
  const id = store.getQueue()[0].id;
  await Promise.all([store.steerQueued(id), store.steerQueued(id)]);
  expect(store.client.prompt).toHaveBeenCalledTimes(1);
  expect(abort).not.toHaveBeenCalled();
});
it("stop/error pause queued execution and never auto-retry uncertain POST outcomes", async () => {
  vi.spyOn(store.client, "abort").mockResolvedValue(undefined);
  store.enqueuePrompt("later");
  await store.stopSession("ses_a");
  status("idle");
  await flush();
  expect(store.client.prompt).not.toHaveBeenCalled();
  vi.mocked(store.client.prompt).mockRejectedValue(new Error("timeout"));
  store.resumeQueue();
  await flush();
  expect(store.getQueue()[0].state).toBe("uncertain");
  status("idle");
  store.resumeQueue();
  await flush();
  expect(store.client.prompt).toHaveBeenCalledTimes(1);
});
it('explains a blocked Now operation and keeps the request instead of silently doing nothing',async()=>{
 store.enqueuePrompt('correction');store.state.connection.statusError='status probe failed';
 await store.steerQueued(store.getQueue()[0].id);
 expect(store.client.prompt).not.toHaveBeenCalled();expect(store.getQueue()[0].state).toBe('ready');
 expect(store.state.ui.toast).toContain('Восстановите подключение');
});
it("session error does not trigger the remaining queue on idle", async () => {
  store.enqueuePrompt("later");
  store.handleEvent({
    type: "session.error",
    properties: {
      sessionID: "ses_a",
      error: { name: "Aborted", data: { message: "stopped" } },
    },
  });
  status("idle");
  await flush();
  expect(store.client.prompt).not.toHaveBeenCalled();
  expect(store.isQueueArmed()).toBe(false);
});
it("a recoverable message error keeps the queue armed and drains the next item", async () => {
  store.enqueuePrompt("first"); store.enqueuePrompt("second");
  store.handleEvent({type:"session.error",properties:{sessionID:"ses_a",error:{name:"APIError",data:{statusCode:500,message:"Internal error"}}}});
  expect(store.isQueueArmed()).toBe(true);
  status("idle"); await flush();
  expect(store.client.prompt).toHaveBeenCalledTimes(1);
  expect(store.getQueue()).toHaveLength(1);
});
it("classifies fatal or explicit-stop errors as pausing, recoverable ones as retryable", () => {
  expect(isQueuePausingError("Insufficient Balance")).toBe(true);
  expect(isQueuePausingError("The response was aborted.")).toBe(true);
  expect(isQueuePausingError("Достигнут лимит ответа модели. Можно сжать контекст и продолжить работу.")).toBe(false);
  expect(isQueuePausingError("Нет соединения с API модели. Проверьте подключение к сервису модели.")).toBe(false);
  expect(isQueuePausingError("Internal error")).toBe(false);
  expect(isQueuePausingError(null)).toBe(false);
});
it("keeps queue in its original session and does not bypass permission waits", async () => {
  store.enqueuePrompt("later");
  store.state.activeSessionId = "ses_b";
  status("idle");
  await flush();
  expect(store.client.prompt).not.toHaveBeenCalled();
  store.state.activeSessionId = "ses_a";
  store.state.chat.permissions.per_a = {
    id: "per_a",
    sessionID: "ses_a",
    permission: "edit",
  };
  await store.steerQueued(store.getQueue()[0].id);
  expect(store.client.prompt).not.toHaveBeenCalled();
});
it("restored queue requires explicit resumption and dictation cannot leak across endpoints", async () => {
  store.state.prefs.queues = {
    ses_a: [
      {
        id: "q",
        text: "later",
        directory: "/test",
        sessionID: "ses_a",
        model: { providerID: "p", modelID: "m" },
        state: "ready",
      },
    ],
  };
  status("idle");
  await flush();
  expect(store.client.prompt).not.toHaveBeenCalled();
  store.appendDictation("http://127.0.0.1:9999", "ses_old", "recognized");
  expect(store.getDraft()).toBe("");
  expect(
    store.state.prefs.endpointState["http://127.0.0.1:9999"].drafts.ses_old,
  ).toBe("recognized");
});
it('routes delayed dictation to its SSH workspace even when tunnels reuse one loopback endpoint', () => {
  store.state.prefs.workspaceKey = 'ssh:current';
  store.state.prefs.endpointState = { 'ssh:previous': { drafts: { ses_a: 'old draft' } } };
  store.setDraft('current draft');
  store.appendDictation('ssh:previous', 'ses_a', 'recognized');
  expect(store.getDraft()).toBe('current draft');
  expect(store.state.prefs.endpointState['ssh:previous'].drafts.ses_a).toBe('old draft recognized');
  store.appendDictation('ssh:current', 'ses_a', 'here');
  expect(store.getDraft()).toBe('current draft here');
});
it("applies permission changes only to the selected session and rejects busy changes", async () => {
  store.state.sessions = [{ id: "ses_a", permission: [] }];
  const update = vi
    .spyOn(store.client, "updateSession")
    .mockResolvedValue({ id: "ses_a", permission: accessRules("read") });
  await store.setAccessMode("read");
  expect(update).not.toHaveBeenCalled();
  status("idle");
  await store.setAccessMode("read");
  expect(update).toHaveBeenCalledWith(
    "ses_a",
    { permission: accessRules("read") },
    "/test",
  );
  expect(store.getAccessMode()).toBe("read");
});
it("access mapping is explicit and message IDs retain engine-compatible width and ordering", () => {
  expect(accessRules("full")[0]).toEqual({
    permission: "*",
    pattern: "*",
    action: "allow",
  });
  expect(accessMode(accessRules("ask"))).toBe("ask");
  expect(
    accessMode([{ permission: "bash", pattern: "*", action: "deny" }]),
  ).toBe("custom");
  const a = newMessageId(),
    b = newMessageId();
  expect(a).toMatch(/^msg_[a-zA-Z0-9]{26}$/);
  expect(b > a).toBe(true);
});

it("returning to an endpoint makes interrupted sends reviewable, never stranded or auto-replayed", async () => {
  const { switchEndpointPrefs } = await import("../src/state/prefs");
  const item = {
    id: "q",
    text: "task",
    directory: "/test",
    sessionID: "ses_a",
    model: { providerID: "p", modelID: "m" },
    state: "sending" as const,
  };
  const original = { ...store.state.prefs, queues: { ses_a: [item] } };
  const other = switchEndpointPrefs(original, "http://127.0.0.1:4097");
  const back = switchEndpointPrefs(other, original.endpoint);
  expect(back.queues?.ses_a[0].state).toBe("uncertain");
});

it("explicit recovery clears the old error and drains both items without a busy event", async () => {
  store.enqueuePrompt("first"); store.enqueuePrompt("second");
  store.handleEvent({type:"session.error",properties:{sessionID:"ses_a",error:{data:{message:"Insufficient Balance"}}}});
  expect(store.queueRecoveryReason()).toContain("Недостаточно средств");
  status("idle"); await flush(); expect(store.client.prompt).not.toHaveBeenCalled();
  store.setModelChoice("p","other","medium"); expect(store.queueHasDifferentModel()).toBe(true);
  store.resumeQueue(true); await flush();
  expect(store.client.prompt.mock.calls[0][2].model.modelID).toBe("other");
  status("idle"); await flush();
  expect(store.client.prompt).toHaveBeenCalledTimes(2);
  expect(store.client.prompt.mock.calls[1][2].model.modelID).toBe("other");
  expect(store.getQueue()).toHaveLength(0);
});
it("a new provider error pauses again after explicit recovery", async () => {
  store.enqueuePrompt("first"); store.enqueuePrompt("second");
  store.handleEvent({type:"session.error",properties:{sessionID:"ses_a",error:{data:{message:"Insufficient Balance"}}}});
  store.resumeQueue(); await flush();
  store.handleEvent({type:"session.error",properties:{sessionID:"ses_a",error:{data:{message:"Insufficient Balance"}}}});
  status("idle"); await flush();
  expect(store.client.prompt).toHaveBeenCalledTimes(1); expect(store.getQueue()).toHaveLength(1);
  expect(store.isQueueArmed()).toBe(false);
});

it("an error arriving before POST acceptance is not replaced by a synthetic busy status", async () => {
  let accepted!: () => void;
  vi.mocked(store.client.prompt).mockImplementation(() => new Promise<void>(resolve => { accepted = resolve; }));
  store.enqueuePrompt("first"); store.enqueuePrompt("second"); status("idle"); await flush();
  store.handleEvent({type:"session.error",properties:{sessionID:"ses_a",error:{data:{message:"Insufficient Balance"}}}});
  accepted(); await flush();
  expect(store.isRunning()).toBe(false); expect(store.isQueueArmed()).toBe(false);
  expect(store.getQueue()).toHaveLength(1); expect(store.client.prompt).toHaveBeenCalledTimes(1);
});

it('defers a busy race during preparation without pausing or posting, then drains once on idle', async () => {
 const {modelServices}=await import('../src/models/services');
 vi.spyOn(modelServices,'ensure').mockImplementationOnce(async()=>{status('busy');}).mockResolvedValue(undefined);
 store.enqueuePrompt('next after race'); status('idle'); await flush();
 expect(store.client.prompt).not.toHaveBeenCalled();
 expect(store.getQueue()[0]).toMatchObject({state:'ready',error:undefined});
 expect(store.isQueueArmed()).toBe(true);
 status('idle');status('idle');await flush();
 expect(store.client.prompt).toHaveBeenCalledTimes(1);
 expect(store.getQueue()).toHaveLength(0);
});
it('a permission arriving during preparation waits without turning into a queue error',async()=>{
 const {modelServices}=await import('../src/models/services');
 vi.spyOn(modelServices,'ensure').mockImplementationOnce(async()=>{store.state.chat.permissions.per_late={id:'per_late',sessionID:'ses_a',permission:'edit'};}).mockResolvedValue(undefined);
 store.enqueuePrompt('after permission');status('idle');await flush();
 expect(store.client.prompt).not.toHaveBeenCalled();expect(store.isQueueArmed()).toBe(true);
 expect(store.getQueue()[0]).toMatchObject({state:'ready',error:undefined});
 store.handleEvent({type:'permission.v2.replied',properties:{requestID:'per_late',sessionID:'ses_a'}});await flush();
 expect(store.client.prompt).toHaveBeenCalledTimes(1);
});
it('legacy session.idle dispatches an armed queue exactly once',async()=>{
 store.enqueuePrompt('legacy idle');
 store.handleEvent({type:'session.idle',properties:{sessionID:'ses_a'}});
 store.handleEvent({type:'session.idle',properties:{sessionID:'ses_a'}});await flush();
 expect(store.client.prompt).toHaveBeenCalledTimes(1);
});

it('a busy event during reservation waits and does not lose the captured model', async () => {
 const {modelServices}=await import('../src/models/services');
 vi.spyOn(modelServices,'reserve').mockImplementationOnce(async()=>{status('busy');}).mockResolvedValue(undefined);
 store.enqueuePrompt('after reservation');status('idle');await flush();
 expect(store.client.prompt).not.toHaveBeenCalled();expect(store.isQueueArmed()).toBe(true);
 expect(store.getQueue()[0]).toMatchObject({state:'ready',error:undefined});
 store.setModelChoice('p','other');status('idle');await flush();
 expect(store.client.prompt).toHaveBeenCalledTimes(1);
 expect(store.client.prompt.mock.calls[0][2].model.modelID).toBe('m');
});
it('Stop while preparation is waiting never rearms the queue',async()=>{
 const {modelServices}=await import('../src/models/services');
 let finish!:()=>void;
 vi.spyOn(modelServices,'ensure').mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
 vi.spyOn(store.client,'abort').mockResolvedValue(undefined);
 store.enqueuePrompt('keep paused');status('idle');await flush();
 await store.stopSession('ses_a');finish();await flush();status('idle');await flush();
 expect(store.client.prompt).not.toHaveBeenCalled();expect(store.isQueueArmed()).toBe(false);
 expect(store.getQueue()).toHaveLength(1);expect(store.getQueue()[0].state).toBe('ready');
});
it('explicit resume acknowledges an old ready-item error without rebinding its model',async()=>{
 store.enqueuePrompt('saved task');
 store.state.prefs.queues.ses_a[0].error='Агент снова занят. Возобновите очередь после текущего ответа.';
 store.queueArmed.delete('ses_a');store.setModelChoice('p','other');
 store.resumeQueue();
 expect(store.getQueue()[0].error).toBeUndefined();
 expect(store.getQueue()[0].model.modelID).toBe('m');
 status('idle');await flush();expect(store.client.prompt).toHaveBeenCalledTimes(1);
});

it('a busy event during durable journal preparation cancels the unsent record and waits',async()=>{
 const {operationJournal}=await import('../src/operations/journal');
 const dispatch=operationJournal.dispatch.bind(operationJournal);
 vi.spyOn(operationJournal,'dispatch').mockImplementationOnce((input,current,send)=>dispatch(input,current,async()=>{status('busy');return send();}));
 store.enqueuePrompt('journal race');status('idle');await flush();
 expect(store.client.prompt).not.toHaveBeenCalled();expect(store.isQueueArmed()).toBe(true);
 expect(store.getQueue()[0]).toMatchObject({state:'ready',error:undefined});
 const records=await operationJournal.list(store.state.prefs.workspaceKey??store.state.prefs.endpoint);
 expect(records).toHaveLength(1);expect(records[0].state).toBe('cancelled');
 status('idle');await flush();expect(store.client.prompt).toHaveBeenCalledTimes(1);
});

it('failed durable acknowledgement of a saved error does not resume the queue',()=>{
 store.enqueuePrompt('keep paused');
 store.state.prefs.queues.ses_a[0].error='old preparation error';store.queueArmed.delete('ses_a');
 vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw Error('quota');});
 store.resumeQueue();
 expect(store.isQueueArmed()).toBe(false);expect(store.getQueue()[0].error).toBe('old preparation error');
 expect(store.client.prompt).not.toHaveBeenCalled();
});

it('reordering persists complete queue items and dispatches the new head once',async()=>{
 store.enqueuePrompt('first');store.enqueuePrompt('second');store.enqueuePrompt('third');
 const [a,b,c]=store.getQueue();b.error='saved warning';
 expect(store.reorderQueued(c.id,a.id)).toBe(true);
 expect(store.getQueue()).toEqual([c,a,b]);expect(store.isQueueArmed()).toBe(true);
 const {loadPrefs}=await import('../src/state/prefs');
 expect(loadPrefs().queues.ses_a.map((item:any)=>item.id)).toEqual([c.id,a.id,b.id]);
 expect(store.reorderQueued(c.id,null)).toBe(true);expect(store.getQueue()).toEqual([a,b,c]);
 expect(store.reorderQueued(b.id,a.id)).toBe(true);
 status('idle');await flush();
 expect(store.client.prompt).toHaveBeenCalledTimes(1);expect(store.client.prompt.mock.calls[0][2].parts[0].text).toBe('second');
});
it('reordering cannot bypass sending, uncertain delivery, missing IDs or locks',async()=>{
 store.enqueuePrompt('a');store.enqueuePrompt('b');const [a,b]=store.getQueue();
 expect(store.reorderQueued(a.id,a.id)).toBe(false);expect(store.reorderQueued('missing',a.id)).toBe(false);expect(store.reorderQueued(a.id,'missing')).toBe(false);
 store.queueLocks.add('ses_a');expect(store.reorderQueued(b.id,a.id)).toBe(false);store.queueLocks.clear();
 a.state='uncertain';expect(store.reorderQueued(b.id,a.id)).toBe(false);a.state='sending';expect(store.reorderQueued(b.id,a.id)).toBe(false);a.state='ready';
 store.state.ui.sending=true;expect(store.reorderQueued(b.id,a.id)).toBe(false);
});
it('reordering retains a paused queue and rolls back when durable storage fails',()=>{
 store.enqueuePrompt('a');store.enqueuePrompt('b');store.queueArmed.clear();const [a,b]=store.getQueue();
 expect(store.reorderQueued(b.id,a.id)).toBe(true);expect(store.isQueueArmed()).toBe(false);
 vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw Error('quota');});
 expect(store.reorderQueued(a.id,b.id)).toBe(false);expect(store.getQueue()).toEqual([b,a]);
});

it('a correction keeps the running session and remaining queue intact without aborting',async()=>{
 const abort=vi.spyOn(store.client,'abort');
 store.enqueuePrompt('later first');store.enqueuePrompt('clarification');store.enqueuePrompt('later second');
 const [a,b,c]=store.getQueue();
 await Promise.all([store.steerQueued(b.id),store.steerQueued(b.id)]);
 expect(abort).not.toHaveBeenCalled();expect(store.client.prompt).toHaveBeenCalledTimes(1);
 expect(store.client.prompt.mock.calls[0][0]).toBe('ses_a');
 expect(store.client.prompt.mock.calls[0][2].parts[0]).toMatchObject({text:'clarification',metadata:{arvelaSteering:1}});
 expect(store.isRunning()).toBe(true);expect(store.getQueue()).toEqual([a,c]);
});
