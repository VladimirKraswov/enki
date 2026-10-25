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
