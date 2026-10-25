// Editing a sent message forks the runtime session before it (POST
// /sessions/:id/fork {messageID}), copies the source access explicitly, keeps
// model/agent/draft per chat and never sends anything by itself.
import {beforeEach,expect,it,vi} from 'vitest';
import type {RuntimeFixture} from './helpers/runtime-fixture';
let store:any, source:any, fx:RuntimeFixture, statuses:Record<string,unknown>, questions:unknown[];
let Reply:typeof import('./helpers/runtime-fixture').RuntimeReply;
beforeEach(async()=>{
 vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllGlobals();
 const fixture=await import('./helpers/runtime-fixture');Reply=fixture.RuntimeReply;
 store=(await import('../src/state/store')).store;
 source={id:'source',directory:'/test',projectID:'test',title:'Original',time:{created:1,updated:1},permission:[{permission:'*',pattern:'*',action:'deny'}]};
 statuses={}; questions=[];
 fx=fixture.runtimeFixture();
 fixture.withProvider(fx,'local',['chosen'],['medium']);
 fx.on('GET','/sessions',()=>[source]);
 fx.on('GET','/sessions/:id',()=>source);
 fx.on('GET','/sessions/status',()=>statuses);
 fx.on('GET','/questions',()=>questions);
 fx.on('POST','/sessions/:id/fork',()=>({...source,id:'branch',permission:undefined}));
 fx.on('PATCH','/sessions/:id',c=>({...source,id:c.params.id,...(c.body as object)}));
 fixture.bindStore(store,fx);
 await store.setDirectory('/test',{sessionId:'source'});
 store.state.chat.sessions.source={...store.state.chat.sessions.source,messages:{msg:{id:'msg',sessionID:'source',role:'user',time:{created:2}}},partsByMessage:{msg:[]},parts:{},messageOrder:['msg'],status:{type:'idle'}};
 store.setModelChoice('local','chosen','medium');store.setAgentOverride('/test','custom');store.setDraft('existing source draft');
});
const forks=()=>fx.made('POST','/sessions/:id/fork');
it('forks before the edited message, preserves access/profile and the original draft, without auto execution',async()=>{
 await store.prepareEditedBranch('msg','corrected');
 expect(forks()).toEqual([expect.objectContaining({path:'/sessions/source/fork',query:{directory:'/test'},body:{messageID:'msg'}})]);
 expect(fx.made('PATCH','/sessions/:id')).toEqual([expect.objectContaining({path:'/sessions/branch',query:{directory:'/test'},body:{title:'Original · правка',permission:source.permission}})]);
 expect(store.state.activeSessionId).toBe('branch');expect(store.getDraft()).toBe('corrected');
 expect(store.getModelChoice()).toMatchObject({providerID:'local',modelID:'chosen',variant:'medium'});expect(store.getAgentChoice()).toBe('custom');
 expect(store.state.prefs.drafts.source).toBe('existing source draft');
 expect(fx.made('POST','/commands')).toEqual([]);
});
it('blocks busy and pending-question sources before forking',async()=>{
 statuses={source:{type:'busy'}};
 await expect(store.prepareEditedBranch('msg','change')).rejects.toThrow('Дождитесь');
 statuses={};questions=[{id:'que_1',sessionID:'source',questions:[]}];
 await expect(store.prepareEditedBranch('msg','change')).rejects.toThrow('Дождитесь');
 expect(forks()).toEqual([]);
});
it('retains the editor on a failed permission restoration and never sends',async()=>{
 fx.on('PATCH','/sessions/:id',()=>{throw new Reply(500,{message:'save failed'});});
 await expect(store.prepareEditedBranch('msg','change')).rejects.toThrow('save failed');
 expect(store.state.activeSessionId).toBe('source');expect(store.getDraft()).toBe('existing source draft');
 expect(fx.made('POST','/commands')).toEqual([]);
});
it('does not change the visible chat if the user navigated during fork creation',async()=>{
 let resolve!:(v:unknown)=>void;fx.on('POST','/sessions/:id/fork',()=>new Promise(r=>{resolve=r;}));
 const pending=store.prepareEditedBranch('msg','change');await vi.waitFor(()=>expect(forks()).toHaveLength(1));
 store.state.activeSessionId='other';store.state.directory='/other';store.state.sessions=[];resolve({...source,id:'branch'});await pending;
 expect(store.state.activeSessionId).toBe('other');expect(store.state.sessions).toEqual([]);expect(store.state.prefs.drafts.branch).toBe('change');
 expect(fx.made('POST','/commands')).toEqual([]);
});
