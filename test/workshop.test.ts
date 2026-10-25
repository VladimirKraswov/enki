// Protected «Мастерская» session. The runtime marks it (`workshop: true` on
// create/update, which drives the release policy in that session's system
// prompt); identity reconciliation and protection stay in the window.
import {beforeEach,expect,it,vi} from 'vitest';
import {resolveWorkshop,isWorkshopSession,WORKSHOP_TITLE} from '../src/workshop/workspace';
import {ApiError} from '../src/api/http';
import type {AgentBackend} from '../src/agent/backend';
const workspace={directory:'/workshop',sourceDirectory:'/repo'};
const session={id:'protected',directory:'/workshop',title:WORKSHOP_TITLE,projectID:'global',workshop:true,time:{created:1,updated:1}};
/** Updates echo the stored session like the runtime does; nothing else changes its directory. */
const backend=(stored:any=session)=>{let current=stored;return {
 getSession:vi.fn(async()=>current),listSessions:vi.fn().mockResolvedValue([]),createSession:vi.fn().mockResolvedValue(session),
 updateSession:vi.fn(async(_id:string,patch:any)=>(current={...current,...patch,time:{...current.time,...(patch.time??{})}})),
} as unknown as AgentBackend;};
it('reuses persisted identity, scopes protection and reconciles a lost create response',async()=>{
 const api=backend();const record=await resolveWorkshop(api,workspace,{...workspace,session});expect(api.createSession).not.toHaveBeenCalled();
 expect(api.updateSession).not.toHaveBeenCalled();
 expect(isWorkshopSession(record,session)).toBe(true);expect(isWorkshopSession(record,{...session,directory:'/other'})).toBe(false);
 vi.mocked(api.getSession).mockRejectedValue(new ApiError(404,'missing'));
 vi.mocked(api.listSessions).mockResolvedValue([session]);
 expect((await resolveWorkshop(api,workspace,record)).session.id).toBe('protected');expect(api.createSession).not.toHaveBeenCalled();
});
it('never recreates on outage and restores an externally archived original',async()=>{
 const api=backend({...session,time:{...session.time,archived:3}});vi.mocked(api.getSession).mockRejectedValueOnce(new ApiError(500,'offline'));
 await expect(resolveWorkshop(api,workspace,{...workspace,session})).rejects.toThrow();expect(api.createSession).not.toHaveBeenCalled();
 const record=await resolveWorkshop(api,workspace,{...workspace,session});
 expect(api.updateSession).toHaveBeenCalledWith('protected',{time:{archived:0}},'/workshop');
 expect(record.session.time.archived).toBe(0);
});
it('creates no agent prompt, marks the runtime workshop session and never binds a session returned for another directory',async()=>{
 const api=backend();await resolveWorkshop(api,workspace);
 expect(api.createSession).toHaveBeenCalledWith({directory:'/workshop',title:WORKSHOP_TITLE,workshop:true});
 vi.mocked(api.createSession).mockResolvedValue({...session,directory:'/other'});await expect(resolveWorkshop(api,workspace)).rejects.toThrow('другой каталог');
});
it('an imported OpenCode archive titled «Мастерская» is never adopted as the protected session',async()=>{
 const api=backend();vi.mocked(api.listSessions).mockResolvedValue([{...session,id:'imported',origin:{kind:'opencode'}}]);
 await resolveWorkshop(api,workspace);
 expect(api.createSession).toHaveBeenCalledOnce();
});
it('a session that predates the runtime marker is marked once, keeping its identity',async()=>{
 const api=backend({...session,workshop:false});
 const record=await resolveWorkshop(api,workspace,{...workspace,session});
 expect(api.updateSession).toHaveBeenCalledWith('protected',{workshop:true},'/workshop');
 expect(record.session).toMatchObject({id:'protected',workshop:true});
});
it('a timed-out create is reconciled on the next open without a second POST',async()=>{
 const api=backend();vi.mocked(api.createSession).mockRejectedValue(new Error('acknowledgement lost'));
 await expect(resolveWorkshop(api,workspace)).rejects.toThrow('acknowledgement lost');
 vi.mocked(api.listSessions).mockResolvedValue([session]);
 expect((await resolveWorkshop(api,workspace)).session.id).toBe('protected');expect(api.createSession).toHaveBeenCalledOnce();
});
it('renames the legacy workshop without duplicating or changing its identity',async()=>{
 const old={...session,title:'Мастерская Arvela'};const api=backend(old);
 vi.mocked(api.listSessions).mockResolvedValue([old]);
 const record=await resolveWorkshop(api,workspace);
 expect(api.createSession).not.toHaveBeenCalled();expect(api.updateSession).toHaveBeenCalledWith('protected',{title:'Мастерская'},'/workshop');
 expect(record.session.id).toBe('protected');expect(record.session.title).toBe('Мастерская');
});
it('reopens the original protected id through a verified migrated directory alias',async()=>{
 const migrated={...workspace,directory:'/enki/workshop',legacyDirectory:'/legacy/workshop'};
 const original={...session,directory:'/legacy/workshop'};const api=backend(original);
 const record=await resolveWorkshop(api,migrated,{...workspace,directory:original.directory,session:original});
 expect(api.getSession).toHaveBeenCalledWith(original.id,original.directory);expect(api.createSession).not.toHaveBeenCalled();
 expect(record.directory).toBe(original.directory);expect(record.session.id).toBe(original.id);
});
it('recovers missing preferences from the legacy directory without creating another workshop',async()=>{
 const original={...session,directory:'/legacy/workshop'};const api=backend(original);
 vi.mocked(api.listSessions).mockImplementation(async directory=>directory===original.directory?[original]:[]);
 const record=await resolveWorkshop(api,{...workspace,directory:'/enki/workshop',legacyDirectory:original.directory});
 expect(api.createSession).not.toHaveBeenCalled();expect(record.session.id).toBe(original.id);expect(record.directory).toBe(original.directory);
});

let store:any,fx:import('./helpers/runtime-fixture').RuntimeFixture;
beforeEach(async()=>{
 vi.resetModules();vi.restoreAllMocks();vi.unstubAllGlobals();
 vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{},removeItem:()=>{}});
 const fixture=await import('./helpers/runtime-fixture');
 store=(await import('../src/state/store')).store;
 fx=fixture.runtimeFixture();fixture.bindStore(store,fx);
 store.state.prefs.workshop={...workspace,session};
});
it('store guards deletion, archive, rename and project removal even outside the sidebar',async()=>{
 await store.deleteSession(session);await store.archiveSession(session);await store.renameSession(session,'changed');store.removeProject('/workshop');
 expect(fx.calls.filter((c:{method:string})=>c.method!=='GET')).toEqual([]);
 expect(store.state.prefs.workshop?.session.id).toBe('protected');expect(store.state.prefs.hiddenProjects??[]).not.toContain('/workshop');
 store.state.projects=[{id:'workshop',worktree:'/workshop',time:{created:0,updated:0}},{id:'normal',worktree:'/normal',time:{created:0,updated:0}}];
 expect(store.projectDirectories()).toEqual(['/normal']);
});
it('workspace switching isolates protected identities instead of protecting a remote chat with the same id',async()=>{
 const {switchEndpointPrefs}=await import('../src/state/prefs');
 const remote=switchEndpointPrefs(store.state.prefs,'http://127.0.0.1:6000','ssh:other:22');expect(remote.workshop).toBeUndefined();
 const restored=switchEndpointPrefs(remote,store.state.prefs.endpoint,store.state.prefs.workspaceKey);expect(restored.workshop?.session.id).toBe('protected');
});
it('coalesces startup and click, then stores a late result under its original workspace',async()=>{
 const native=await import('../src/native/platform');vi.spyOn(native,'isNative').mockReturnValue(true);
 const module=await import('../src/workshop/workspace');let finish!:(v:typeof workspace)=>void;
 const prepare=vi.spyOn(module,'prepareWorkshop').mockImplementation(()=>new Promise(r=>{finish=r;}));
 fx.on('GET','/sessions/:id',()=>session);
 const key=store.state.prefs.workspaceKey;
 const first=store.ensureWorkshop(),second=store.ensureWorkshop();
 await vi.waitFor(()=>expect(prepare).toHaveBeenCalledOnce());
 const {switchEndpointPrefs}=await import('../src/state/prefs');store.state.prefs=switchEndpointPrefs(store.state.prefs,'http://127.0.0.1:6001','ssh:other:22');
 finish(workspace);await Promise.all([first,second]);
 expect(prepare).toHaveBeenCalledOnce();
 expect(store.state.prefs.workshop).toBeUndefined();expect(store.state.prefs.endpointState?.[key].workshop?.session.id).toBe('protected');
});
it('does not jump back to an old workshop click after the user changes chat',async()=>{
 let finish!:(v:any)=>void;vi.spyOn(store,'ensureWorkshop').mockImplementation(()=>new Promise(r=>{finish=r;}));
 const open=vi.spyOn(store,'openChat').mockResolvedValue(undefined);const pending=store.openWorkshop();
 store.state.activeSessionId='newer-selection';finish({...workspace,session});await pending;expect(open).not.toHaveBeenCalled();
});

// A saved pointer that resolves to a read-only imported archive (TODO item 6):
// the runtime's verified continuation is used inside the trusted directory,
// nothing is created empty, nothing historical is replayed, and the pointer
// changes only after every runtime acknowledgement.
const archived={...session,id:'imported',workshop:false,origin:{kind:'opencode'}};
const continuation={...session,id:'continued',workshop:false};
const continuing=()=>{const api=backend(archived) as any;let current:any=archived;
 api.getSession=vi.fn(async(id:string)=>id==='continued'?current:archived);
 api.continueLegacy=vi.fn(async()=>(current={...continuation}));
 api.updateSession=vi.fn(async(_id:string,patch:any)=>(current={...current,...patch}));
 return api;};
it('continues a saved archive pointer through the existing continuation instead of creating or renaming the archive',async()=>{
 const api=continuing(),seen=vi.fn();
 const record=await resolveWorkshop(api,workspace,{...workspace,session:archived as any},undefined,seen);
 expect(api.continueLegacy).toHaveBeenCalledExactlyOnceWith('imported','/workshop');
 expect(api.createSession).not.toHaveBeenCalled();
 expect(api.updateSession).toHaveBeenCalledExactlyOnceWith('continued',{workshop:true},'/workshop');
 expect(api.updateSession.mock.calls.some(([id]:[string])=>id==='imported')).toBe(false);
 expect(record.session).toMatchObject({id:'continued',directory:'/workshop',workshop:true});
 expect(seen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({id:'imported'}),expect.objectContaining({id:'continued'}));
 // Reopening with the replaced pointer neither continues again nor creates.
 const again=await resolveWorkshop(api,workspace,record);
 expect(again.session.id).toBe('continued');expect(api.continueLegacy).toHaveBeenCalledOnce();expect(api.createSession).not.toHaveBeenCalled();
});
it('a failed continuation keeps the archive pointer usable and never creates an empty replacement',async()=>{
 const api=continuing();api.continueLegacy.mockRejectedValue(new ApiError(409,'archive unverified'));
 await expect(resolveWorkshop(api,workspace,{...workspace,session:archived as any})).rejects.toThrow('archive unverified');
 expect(api.createSession).not.toHaveBeenCalled();expect(api.updateSession).not.toHaveBeenCalled();
 api.continueLegacy.mockResolvedValue({...archived});
 await expect(resolveWorkshop(api,workspace,{...workspace,session:archived as any})).rejects.toThrow('доступное для записи');
 expect(api.createSession).not.toHaveBeenCalled();
});
it('a continuation returned for another directory is refused before any pointer change',async()=>{
 const api=continuing();api.continueLegacy.mockResolvedValue({...continuation,directory:'/elsewhere'});
 await expect(resolveWorkshop(api,workspace,{...workspace,session:archived as any})).rejects.toThrow('другой каталог');
 expect(api.updateSession).not.toHaveBeenCalled();
});
it('store replaces the archive pointer and records its provenance only after the runtime continued it',async()=>{
 const native=await import('../src/native/platform');vi.spyOn(native,'isNative').mockReturnValue(true);
 const module=await import('../src/workshop/workspace');vi.spyOn(module,'prepareWorkshop').mockResolvedValue(workspace);
 store.state.prefs.workshop={...workspace,session:archived};
 let marked={...continuation};
 fx.on('GET','/sessions/:id',c=>c.params.id==='continued'?marked:archived);
 let fail=true;
 fx.on('POST','/sessions/:id/continue',()=>{if(fail)throw new Error('acknowledgement lost');return continuation;});
 fx.on('PATCH','/sessions/:id',c=>(marked={...marked,...(c.body as object)}));
 await expect(store.ensureWorkshop()).rejects.toThrow();
 expect(store.state.prefs.workshop.session.id).toBe('imported');
 expect(store.state.prefs.handoffOrigins?.continued).toBeUndefined();
 fail=false;
 const record=await store.ensureWorkshop();
 expect(record.session.id).toBe('continued');
 expect(store.state.prefs.workshop.session).toMatchObject({id:'continued',workshop:true});
 expect(store.state.prefs.handoffOrigins.continued).toMatchObject({from:'imported',fromEngine:'opencode',directory:'/workshop'});
 expect(fx.made('POST','/sessions')).toEqual([]);expect(fx.made('POST','/commands')).toEqual([]);
});


// Real upgrade boundary: preferences still name `ses_…`, while the runtime
// imported archive has a new source-bound ID. Never recover this by title/page.
const oldWorkshop={...session,id:'ses_workshop'};
const importedWorkshop={...archived,id:'legacy-source-bound-workshop',origin:{kind:'opencode',legacyId:'ses_workshop',archive:'a'.repeat(64),readOnly:true}};
function legacyWorkshopBackend() {
 const api=backend() as any;
 let writable={...continuation};
 api.getSession=vi.fn(async(id:string)=>{if(id==='ses_workshop')throw new ApiError(404,'missing');return writable;});
 api.resolveLegacySession=vi.fn(async()=>importedWorkshop);
 api.listSessions=vi.fn(async()=>{throw Error('A paged title catalog cannot resolve a saved source identity');});
 api.continueLegacy=vi.fn(async()=>writable);
 api.updateSession=vi.fn(async(_id:string,patch:any)=>(writable={...writable,...patch,time:{...writable.time,...(patch.time??{})}}));
 return api;
}
it('maps a real old ID through exact source lookup even when a large paged catalog omits the archive',async()=>{
 const api=legacyWorkshopBackend(),seen=vi.fn();
 const record=await resolveWorkshop(api,workspace,{...workspace,session:oldWorkshop},undefined,seen);
 expect(api.resolveLegacySession).toHaveBeenCalledExactlyOnceWith('ses_workshop','/workshop');
 expect(api.listSessions).not.toHaveBeenCalled();expect(api.createSession).not.toHaveBeenCalled();
 expect(api.continueLegacy).toHaveBeenCalledExactlyOnceWith(importedWorkshop.id,'/workshop');
 expect(record.session).toMatchObject({id:'continued',workshop:true});
 expect(seen).toHaveBeenCalledExactlyOnceWith(importedWorkshop,expect.objectContaining({id:'continued',workshop:true}));
});
it.each(['история ещё не импортирована','несколько архивов','источник временно недоступен'])('keeps an old workshop pointer and never creates on lookup refusal: %s',async(message)=>{
 const api=legacyWorkshopBackend(),seen=vi.fn(),previous={...workspace,session:oldWorkshop};
 api.resolveLegacySession.mockRejectedValue(new ApiError(409,message));
 await expect(resolveWorkshop(api,workspace,previous,undefined,seen)).rejects.toThrow(message);
 expect(previous.session.id).toBe('ses_workshop');expect(api.createSession).not.toHaveBeenCalled();
 expect(api.listSessions).not.toHaveBeenCalled();expect(api.continueLegacy).not.toHaveBeenCalled();expect(seen).not.toHaveBeenCalled();
});
it('uses only the native-approved legacy directory alias for an old saved identity',async()=>{
 const api=legacyWorkshopBackend(),directory='/legacy/workshop';
 api.resolveLegacySession.mockResolvedValue({...importedWorkshop,directory});
 api.continueLegacy.mockResolvedValue({...continuation,directory,workshop:true});
 const record=await resolveWorkshop(api,{...workspace,directory:'/enki/workshop',legacyDirectory:directory},{...workspace,directory,session:{...oldWorkshop,directory}});
 expect(api.resolveLegacySession).toHaveBeenCalledExactlyOnceWith('ses_workshop',directory);
 expect(record.directory).toBe(directory);expect(api.createSession).not.toHaveBeenCalled();
});
it('refuses a saved pointer outside the native-approved directories before any lookup or creation',async()=>{
 const api=legacyWorkshopBackend(),previous={...workspace,directory:'/other',session:{...oldWorkshop,directory:'/other'}};
 await expect(resolveWorkshop(api,workspace,previous)).rejects.toThrow('вне подтверждённого каталога');
 expect(api.getSession).not.toHaveBeenCalled();expect(api.resolveLegacySession).not.toHaveBeenCalled();expect(api.createSession).not.toHaveBeenCalled();
});
it.each([
 {...importedWorkshop,directory:'/other'},
 {...importedWorkshop,origin:{...importedWorkshop.origin,legacyId:'ses_someone_else'}},
 {...importedWorkshop,id:'ses_workshop'},
 {...importedWorkshop,origin:{kind:'pi'}},
])('rejects an exact-lookup response not bound to the saved workshop identity',async(archive)=>{
 const api=legacyWorkshopBackend();api.resolveLegacySession.mockResolvedValue(archive);
 await expect(resolveWorkshop(api,workspace,{...workspace,session:oldWorkshop})).rejects.toThrow('не совпал');
 expect(api.continueLegacy).not.toHaveBeenCalled();expect(api.createSession).not.toHaveBeenCalled();
});
it('reuses the existing continuation after a protection PATCH failure and publishes provenance only after its ACK',async()=>{
 const api=legacyWorkshopBackend(),seen=vi.fn(),previous={...workspace,session:oldWorkshop};
 api.resolveLegacySession.mockResolvedValue({...importedWorkshop,origin:{...importedWorkshop.origin,continuedBy:'continued'}});
 api.updateSession.mockRejectedValueOnce(new ApiError(503,'protection not acknowledged'));
 await expect(resolveWorkshop(api,workspace,previous,undefined,seen)).rejects.toThrow('protection not acknowledged');
 expect(previous.session.id).toBe('ses_workshop');expect(seen).not.toHaveBeenCalled();
 const record=await resolveWorkshop(api,workspace,previous,undefined,seen);
 expect(record.session).toMatchObject({id:'continued',workshop:true});expect(api.createSession).not.toHaveBeenCalled();
 expect(api.continueLegacy.mock.calls).toEqual([[importedWorkshop.id,'/workshop'],[importedWorkshop.id,'/workshop']]);
 expect(seen).toHaveBeenCalledOnce();
});
it('does not publish a continuation when the protection response did not actually protect it',async()=>{
 const api=legacyWorkshopBackend(),seen=vi.fn();api.updateSession.mockResolvedValue(continuation);
 await expect(resolveWorkshop(api,workspace,{...workspace,session:oldWorkshop},undefined,seen)).rejects.toThrow('не подтвердила защиту');
 expect(seen).not.toHaveBeenCalled();expect(api.createSession).not.toHaveBeenCalled();
});
it('store keeps the genuine old pointer and provenance until the continuation protection PATCH succeeds',async()=>{
 const native=await import('../src/native/platform');vi.spyOn(native,'isNative').mockReturnValue(true);
 const module=await import('../src/workshop/workspace');vi.spyOn(module,'prepareWorkshop').mockResolvedValue(workspace);
 const {RuntimeReply}=await import('./helpers/runtime-fixture');
 store.state.prefs.workshop={...workspace,session:oldWorkshop};
 fx.on('GET','/sessions/:id',c=>{if(c.params.id==='ses_workshop')throw new RuntimeReply(404,{message:'missing'});return continuation;});
 fx.on('POST','/migrations/opencode/session',()=>importedWorkshop);
 fx.on('POST','/sessions/:id/continue',()=>continuation);
 let fail=true;fx.on('PATCH','/sessions/:id',c=>{if(fail)throw new RuntimeReply(503,{message:'protection not acknowledged'});return {...continuation,...(c.body as object)};});
 await expect(store.ensureWorkshop()).rejects.toThrow('protection not acknowledged');
 expect(store.state.prefs.workshop.session.id).toBe('ses_workshop');expect(store.state.prefs.handoffOrigins?.continued).toBeUndefined();
 fail=false;await store.ensureWorkshop();
 expect(store.state.prefs.workshop.session).toMatchObject({id:'continued',workshop:true});
 expect(store.state.prefs.handoffOrigins.continued).toMatchObject({from:importedWorkshop.id,fromEngine:'opencode',directory:'/workshop'});
 expect(fx.made('POST','/migrations/opencode/session').map(c=>c.body)).toEqual([{legacyID:'ses_workshop',directory:'/workshop'},{legacyID:'ses_workshop',directory:'/workshop'}]);
 expect(fx.made('POST','/sessions')).toEqual([]);expect(fx.made('POST','/commands')).toEqual([]);
});
