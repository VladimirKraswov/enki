import 'fake-indexeddb/auto';
// Store ↔ runtime authority, over the shared route fixture.
// - Lost-ACK reconciliation (Store.reconcileOperation): only the exact ledger
//   that received a send may disprove it; a pre-2.0 (OpenCode / Pi CLI) record
//   answered 404 by the 2.0 ledger stays "unknown"; a definite answer of the
//   receiving ledger settles the record; nothing is ever resent.
// - `runtime.settings` (Runtime.saveSettings producer) reaches the store's
//   settings consumer only from the current runtime's stream; nothing is re-sent.
import { beforeEach, expect, it, vi } from "vitest";
import type { Operation } from "../src/operations/journal";
import type { RuntimeFixture } from "./helpers/runtime-fixture";

const HOST = "00000000-0000-4000-8000-000000000001";
let store: any, fx: RuntimeFixture, journal: any, writes: Operation[];
const record = (patch: Partial<Operation> = {}): Operation => ({ id: "msg_lost", workspace: "", engine: "pi", sessionId: "ses_a", directory: "/p", source: "manual", sourceId: null,
  text: "сделай отчёт", attachments: null, model: "p/m", state: "uncertain", updatedAt: 1, authority: `runtime:${HOST}`, ...patch });
beforeEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
  const fixture = await import("./helpers/runtime-fixture");
  journal = (await import("../src/operations/journal")).operationJournal;
  writes = [];
  vi.spyOn(journal, "storage").mockReturnValue({ list: async () => [], write: async (next: Operation) => { writes.push(next); } });
  store = (await import("../src/state/store")).store;
  fx = fixture.runtimeFixture();
  fixture.bindStore(store, fx);
  store.state = { ...store.state, runtime: { version: "test", sdk: "x", host: "local", instance: "fixture-instance", hostId: HOST } };
});
const lost = (patch: Partial<Operation> = {}) => record({ workspace: store.state.prefs.workspaceKey, ...patch });

it("the receiving ledger's 404 settles the record as refused; nothing is resent", async () => {
  const { RuntimeReply } = await import("./helpers/runtime-fixture");
  fx.on("GET", "/commands/:id", () => { throw new RuntimeReply(404, { message: "Команда не найдена." }); });
  expect(await store.reconcileOperation(lost())).toContain("не получала");
  expect(writes.map(w => w.state)).toEqual(["refused"]);
  expect(fx.made("POST", "/commands")).toEqual([]);
});

it("a definite rejected/cancelled answer of the receiving ledger settles the record instead of leaving it uncertain", async () => {
  for (const [state, settled] of [["rejected", "refused"], ["cancelled", "cancelled"]] as const) {
    writes.length = 0;
    fx.on("GET", "/commands/:id", c => ({ id: c.params.id, kind: "prompt", sessionID: "ses_a", state, createdAt: 1, updatedAt: 1 }));
    expect(await store.reconcileOperation(lost())).toContain("не выполняла");
    expect(writes.map(w => w.state)).toEqual([settled]);
  }
  expect(fx.made("POST", "/commands")).toEqual([]);
});

it("an accepted or completed receipt confirms delivery once", async () => {
  fx.on("GET", "/commands/:id", c => ({ id: c.params.id, kind: "prompt", sessionID: "ses_a", state: "completed", createdAt: 1, updatedAt: 1 }));
  expect(await store.reconcileOperation(lost())).toContain("подтверждена");
  expect(writes.map(w => w.state)).toEqual(["accepted"]);
});

it("a pre-2.0 record is never disproved by the 2.0 ledger: only positive archive evidence settles it", async () => {
  fx.on("GET", "/commands/:id", () => { throw new Error("must not ask the 2.0 ledger about a pre-2.0 send"); });
  fx.on("POST", "/migrations/evidence", () => ({ evidence: "unknown", detail: "В архиве нет подтверждения." }));
  expect(await store.reconcileOperation(lost({ engine: "opencode", sessionId: "ses_old", authority: undefined }))).toContain("неизвестным");
  expect(writes).toEqual([]);
  expect(fx.made("POST", "/migrations/evidence")[0].body).toMatchObject({ engine: "opencode", sessionID: "ses_old", messageID: "msg_lost" });
  fx.on("POST", "/migrations/evidence", () => ({ evidence: "delivered", detail: "Сообщение найдено в архиве." }));
  expect(await store.reconcileOperation(lost({ engine: "opencode", authority: undefined }))).toContain("найдено");
  expect(writes.map(w => w.state)).toEqual(["accepted"]);
  expect(fx.made("GET", "/commands/:id")).toEqual([]);
  expect(fx.made("POST", "/commands")).toEqual([]);
});

it("a record from another runtime ledger is not judged by this one", async () => {
  expect(await store.reconcileOperation(lost({ authority: "runtime:00000000-0000-4000-8000-000000000999" }))).toContain("другой средой выполнения");
  expect(fx.made("GET", "/commands/:id")).toEqual([]);
  expect(writes).toEqual([]);
});

// Retired engine-routing "retains the previous catalog when a rescan fails".
it("a rescan with provider errors keeps the failed provider's previous entry, the saved choice and the draft", async () => {
  const provider = (id: string, models: string[]) => ({ id, name: id, source: "config", models: Object.fromEntries(models.map(m => [m, { id: m, providerID: id, name: m, capabilities: { reasoning: false, input: { text: true, image: false } }, variants: {} }])) });
  let catalog = { all: [provider("local", ["qwen"]), provider("cloud", ["big"])], connected: ["local", "cloud"], default: {} };
  fx.on("GET", "/providers", () => catalog);
  await store.setDirectory("/p");
  store.setModelChoice("local", "qwen", null); store.setDraft("не потеряй");
  const before = store.getModelChoice();
  catalog = { all: [provider("cloud", ["big", "bigger"])], connected: ["cloud"], default: {} };
  fx.on("POST", "/providers/refresh", () => ({ errors: ["provider local: models.json entry unreadable"] }));
  await expect(store.refreshModelCatalog()).rejects.toThrow("unreadable");
  expect(store.state.providers.map((p: { id: string }) => p.id).sort()).toEqual(["cloud", "local"]);
  expect(Object.keys(store.state.providers.find((p: { id: string }) => p.id === "cloud").models)).toEqual(["big", "bigger"]);
  expect(store.state.connectedProviderIds).toContain("local");
  expect(store.getModelChoice()).toEqual(before);
  expect(store.getDraft()).toBe("не потеряй");
  // A clean rescan is authoritative again.
  fx.on("POST", "/providers/refresh", () => ({ errors: [] }));
  await store.refreshModelCatalog();
  expect(store.state.providers.map((p: { id: string }) => p.id)).toEqual(["cloud"]);
  expect(fx.made("POST", "/commands")).toEqual([]);
});

// Retired engine-routing "does not start a transfer while the authoritative engine is busy".
it("choosing a model for a busy chat defers it to the next prompt: no transition, no stop, no prompt", async () => {
  const provider = { id: "p", name: "p", source: "config", models: { a: { id: "a", providerID: "p", name: "a", variants: {} }, b: { id: "b", providerID: "p", name: "b", variants: {} } } };
  fx.on("GET", "/providers", () => ({ all: [provider], connected: ["p"], default: {} }));
  fx.on("GET", "/sessions", () => [{ id: "ses_busy", directory: "/p", title: "busy", projectID: "p", time: { created: 1, updated: 1 } }]);
  await store.setDirectory("/p", { sessionId: "ses_busy" });
  fx.emit({ type: "session.status", properties: { sessionID: "ses_busy", status: { type: "busy" } } } as never, "/p");
  const notes: string[] = [];
  expect(await store.selectModel("p", "b", null, undefined, (m: string) => notes.push(m))).toBe(true);
  expect(store.getModelChoice()).toMatchObject({ providerID: "p", modelID: "b" });
  expect(notes.join(" ")).toContain("не прерываются");
  expect(fx.made("POST", "/commands")).toEqual([]);
  expect(fx.made("POST", "/sessions/:id/stop")).toEqual([]);
});

// Retired engine-routing: explicit continuation of an imported OpenCode chat.
it("continuing an archive selects the runtime's continuation with visible provenance, sends nothing and ignores a stale answer", async () => {
  const archive = { id: "ses_old", directory: "/p", title: "Старый чат", projectID: "p", origin: { kind: "opencode" }, time: { created: 1, updated: 1 } };
  const continued = { id: "rt_new", directory: "/p", title: "Старый чат", projectID: "p", time: { created: 2, updated: 2 } };
  fx.on("POST", "/sessions/:id/continue", () => continued);
  fx.on("GET", "/sessions", () => [archive, continued]);
  await store.setDirectory("/p");
  expect(await store.continueLegacySession(archive)).toBe(true);
  expect(fx.made("POST", "/sessions/:id/continue").map(c => [c.params.id, c.query.directory])).toEqual([["ses_old", "/p"]]);
  expect(store.state.activeSessionId).toBe("rt_new");
  expect(store.handoffOrigin("rt_new")).toMatchObject({ id: "ses_old", engine: "opencode", title: "Старый чат" });
  expect(fx.made("POST", "/commands")).toEqual([]);
  // A continuation answered after the connection changed is not selected.
  let answer!: (v: unknown) => void;
  fx.on("POST", "/sessions/:id/continue", () => new Promise(resolve => { answer = resolve; }));
  const pending = store.continueLegacySession({ ...archive, id: "ses_old2" });
  await vi.waitFor(() => expect(fx.made("POST", "/sessions/:id/continue")).toHaveLength(2));
  store.connectionGeneration++;
  answer({ ...continued, id: "rt_late" });
  expect(await pending).toBe(false);
  expect(store.state.activeSessionId).toBe("rt_new");
  expect(store.state.prefs.handoffOrigins?.rt_late).toBeUndefined();
});

it("runtime.settings from the current runtime reaches settings consumers without any write", async () => {
  await store.setDirectory("/p");
  const seen = vi.fn();
  const stop = store.onRuntimeSettings(seen);
  const settings = { defaultPolicy: "full", extensionPaths: [], useUserPiResources: false, noDiscoveredExtensions: true, gitProgram: null, compaction: { enabled: true }, browserEnabled: false, lspEnabled: false };
  fx.emit({ type: "runtime.settings", properties: { settings: { ...settings, compaction: { enabled: false, reserveTokens: 4096 } } } } as never, "/p");
  expect(store.state.compaction).toEqual({ auto: false, reserved: 4096 });
  fx.emit({ type: "runtime.settings", properties: { settings } } as never, "/p");
  expect(seen).toHaveBeenLastCalledWith(settings);
  expect(store.state.compaction).toEqual({ auto: true });
  expect(seen).toHaveBeenCalledTimes(2);
  stop();
  fx.emit({ type: "runtime.settings", properties: { settings: { ...settings, lspEnabled: true } } } as never, "/p");
  expect(seen).toHaveBeenCalledTimes(2);
  expect(fx.calls.filter(c => c.method !== "GET")).toEqual([]);
});

it('question attachments go to the scoped reply endpoint and never start a prompt',async()=>{
 store.state={...store.state,directory:'/p',activeSessionId:'question-session',chat:{...store.state.chat,questions:{q:{id:'q',sessionID:'question-session',questions:[{question:'Образец?'}]}}}};
 vi.spyOn(store,'getModelChoice').mockReturnValue({providerID:'p',modelID:'m'});vi.spyOn(store,'modelInfo').mockReturnValue({id:'m',name:'Model',capabilities:{input:{text:true}}});
 const parts=[{type:'file',filename:'answer.txt',mime:'text/plain',url:'data:text/plain;base64,aGk='}];
 vi.spyOn(store,'prepareRuntimeAttachments').mockResolvedValue(parts);
 fx.on('GET','/capabilities',()=>({questionAttachments:true}));fx.on('POST','/questions/:id/reply',()=>new Response(null,{status:204}));
 const req=store.state.chat.questions.q, file={id:'f',name:'answer.txt',mime:'text/plain',size:2,blob:new Blob(['hi'])};
 expect(await store.replyQuestion(req,[['Документ']],[file]),store.state.ui.toast??'no detail').toBe(true);
 expect(fx.made('POST','/questions/:id/reply')[0].body).toEqual({answers:[['Документ']],parts});
 expect(fx.made('POST','/commands')).toEqual([]);expect(store.state.chat.questions.q).toBeUndefined();
});
it('navigation while preparing a question file never posts to the new project',async()=>{
 store.state={...store.state,directory:'/p',activeSessionId:'question-session'};
 vi.spyOn(store,'getModelChoice').mockReturnValue({providerID:'p',modelID:'m'});vi.spyOn(store,'modelInfo').mockReturnValue({id:'m',name:'Model',capabilities:{input:{text:true}}});
 let release:(parts:unknown[])=>void=()=>{};vi.spyOn(store,'prepareRuntimeAttachments').mockReturnValue(new Promise(resolve=>{release=resolve;}));
 const reply=store.replyQuestion({id:'q',sessionID:'question-session',questions:[{question:'Образец?'}]},[['Документ']],[{id:'f',name:'answer.txt',mime:'text/plain',size:2,blob:new Blob(['hi'])}]);
 store.state={...store.state,directory:'/other'};release([]);expect(await reply).toBe(false);
 expect(fx.made('POST','/questions/:id/reply')).toEqual([]);expect(fx.made('POST','/commands')).toEqual([]);
});
it('question files use the running model even when the next prompt has a different deferred selection',async()=>{
 store.state={...store.state,directory:'/p',activeSessionId:'question-session'};
 vi.spyOn(store,'activeSession').mockReturnValue({id:'question-session',directory:'/p',model:{providerID:'current',id:'vision'}});
 const desired=vi.spyOn(store,'getModelChoice').mockReturnValue({providerID:'next',modelID:'text-only'});
 const info=vi.spyOn(store,'modelInfo').mockImplementation((provider:unknown,id:unknown)=>provider==='current'&&id==='vision'?{id:'vision',name:'Current Vision',capabilities:{input:{image:true}}}:null);
 const parts=[{type:'file',filename:'sample.png',mime:'image/png',url:'data:image/png;base64,aGk='}];
 vi.spyOn(store,'prepareRuntimeAttachments').mockResolvedValue(parts);
 fx.on('GET','/capabilities',()=>({questionAttachments:true}));fx.on('POST','/questions/:id/reply',()=>new Response(null,{status:204}));
 expect(await store.replyQuestion({id:'q',sessionID:'question-session',questions:[{question:'Образец?'}]},[['Вот образец']],[{id:'f',name:'sample.png',mime:'image/png',size:2,blob:new Blob(['hi'])}])).toBe(true);
 expect(info).toHaveBeenCalledWith('current','vision');expect(desired).not.toHaveBeenCalled();
 expect(fx.made('POST','/questions/:id/reply')[0].body).toEqual({answers:[['Вот образец']],parts});
 expect(fx.made('POST','/commands')).toEqual([]);
});
