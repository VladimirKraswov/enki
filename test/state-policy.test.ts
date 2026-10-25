import { expect, it } from 'vitest';
import { initialState } from '../src/state/initial';
import { DEFAULT_PREFS } from '../src/state/prefs';
import { chooseModel } from '../src/state/modelChoice';
import { modelScope } from '../src/state/engines';

const fresh = () => initialState(structuredClone(DEFAULT_PREFS));
const context = { projectless:false, defaultVariant:()=> 'medium' };
it('restores the selected folder/session without sharing transient state between stores', () => {
 const prefs={...structuredClone(DEFAULT_PREFS),selectedDirectory:'/one',lastSessionByDir:{'/one':'s1'}};
 const a=initialState(prefs),b=initialState(prefs);
 expect(a.directory).toBe('/one');expect(a.activeSessionId).toBe('s1');
 expect(a.connection.endpoint).toBe(prefs.endpoint);
 a.chat.sessions['s1']={} as any;a.statuses['s1']={type:'busy'};a.projects.push({id:'one'} as any);a.ui.sending=true;
 expect(b.chat.sessions).toEqual({});expect(b.statuses).toEqual({});expect(b.projects).toEqual([]);expect(b.ui.sending).toBe(false);
 expect(b.prefs).toBe(prefs); // Loading/migration belongs to prefs.ts, not this constructor.
});
// One engine: chooseModel replaced chooseOpenCodeModel/choosePiModel. The
// runtime has a single primary agent (no agent-catalogue model step), and model
// access evidence is a badge, not a filter (the Pi CLI verified-model gate is
// retired with that bridge).
it('keeps session override, server session model, folder and defaults in order', () => {
 const s=fresh();s.directory='/one';s.activeSessionId='s1';s.connectedProviderIds=['local'];
 const choice=(modelID:string)=>({providerID:'local',modelID,variant:'low'});
 s.prefs.modelChoice={'session:s1':choice('session'),'/one':choice('folder')};
 const activeModel={providerID:'local',id:'runtime',variant:'high'};
 expect(chooseModel(s,{...context,activeModel})).toEqual(choice('session'));
 delete s.prefs.modelChoice['session:s1'];
 expect(chooseModel(s,{...context,activeModel})).toEqual({...choice('runtime'),variant:'high'});
 expect(chooseModel(s,context)).toEqual(choice('folder'));
 s.prefs.modelChoice={};
 s.configModel='local/family/model';expect(chooseModel(s,context)).toEqual({providerID:'local',modelID:'family/model',variant:'medium'});
 s.configModel=null;s.providerDefaults={local:'default'};expect(chooseModel(s,context)?.modelID).toBe('default');
});
it('projectless policy and disconnected providers cannot select a stale saved model', () => {
 const s=fresh();s.directory='/one';s.connectedProviderIds=['local'];s.prefs.modelChoice={'/one':{providerID:'gone',modelID:'old'},'@chats':{providerID:'local',modelID:'chat'},'*':{providerID:'local',modelID:'global'}};
 expect(chooseModel(s,{...context,projectless:true})?.modelID).toBe('chat');
 expect(chooseModel(s,context)).toBeNull(); // Per-folder unusable entry preserves existing priority; provider defaults may follow.
 s.providerDefaults={local:'usable'};expect(chooseModel(s,context)?.modelID).toBe('usable');
 // A server session model of a disconnected provider is not used either.
 s.activeSessionId='s1';s.providerDefaults=null;
 expect(chooseModel(s,{...context,activeModel:{providerID:'gone',id:'x'}})).toBeNull();
});
it('former Pi chats keep their saved choice; a plain key wins and an unconfigured provider is never chosen', () => {
 const s=fresh();s.activeSessionId='s1';s.directory='/one';s.connectedProviderIds=['local'];
 s.prefs.modelChoice={'pi::session:s1':{providerID:'local',modelID:'pi-era',variant:'high'}};
 expect(chooseModel(s,context)).toEqual({providerID:'local',modelID:'pi-era',variant:'high'});
 s.prefs.modelChoice[modelScope('pi','session:s1')]={providerID:'local',modelID:'current'};
 expect(chooseModel(s,context)?.modelID).toBe('current');
 s.prefs.modelChoice={'session:s1':{providerID:'offline',modelID:'m'},'pi::/one':{providerID:'local',modelID:'folder-era'}};
 expect(chooseModel(s,context)?.modelID).toBe('folder-era');
 // Config-file providers and model-service bindings count as configured without a connection.
 s.connectedProviderIds=[];s.prefs.modelChoice={'session:s1':{providerID:'cfg',modelID:'m'}};
 s.providers=[{id:'cfg',source:'config',models:{m:{id:'m'}}} as any];
 expect(chooseModel(s,context)?.providerID).toBe('cfg');
 s.providers=[];s.prefs.modelServices=[{id:'gpu',providerID:'cfg',endpoint:'http://127.0.0.1:1',bindings:{m:'served'}}] as any;
 expect(chooseModel(s,context)?.providerID).toBe('cfg');
});
