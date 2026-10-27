import {afterEach,expect,it,vi} from 'vitest';
import {store} from '../src/state/store';
import {agentControlForTest} from '../src/control/bridge';
import {putManagedRun,removeManagedRun} from '../src/control/managedRuns';
import type {RuntimeBackend} from '../src/agent/runtime/backend';
const id='focus-fixture',directory='/fixture/background';
const serverKey=()=>store.state.prefs.workspaceKey??store.state.prefs.endpoint;
const page=(text:string,messageId='a1')=>({messages:[{info:{id:messageId,sessionID:id,role:'assistant',finish:'stop',time:{created:1,completed:2}},parts:[{id:'p1',sessionID:id,messageID:messageId,type:'text',text}]}]});
const fixture=()=>{
 const backend={getSession:vi.fn(async()=>({id,directory,model:{providerID:'original',id:'model-original',variant:'medium'}})),messages:vi.fn(async()=>page('DONE')),
  listSessions:vi.fn(async()=>[{id,directory,time:{created:1,updated:2}}]),prompt:vi.fn(async()=>{}),client:{snapshot:vi.fn(async()=>({statuses:{[id]:{type:'idle'}},permissions:[],questions:[]}))}};
 vi.spyOn(store,'backend','get').mockReturnValue(backend as unknown as RuntimeBackend);return backend;
};
afterEach(()=>{removeManagedRun(serverKey(),id);vi.restoreAllMocks();});
const watch=()=>({directory:store.state.directory,session:store.state.activeSessionId,view:store.state.ui,prefs:store.state.prefs});
const managed=()=>putManagedRun({version:1,serverKey:serverKey(),sessionId:id,directory,boundaryMessageId:null,turnBoundaryMessageId:null,recoveredMessageIds:[],malformedAttempts:0,continuationAttempts:0,maxContinuations:2,completionMarker:'DONE',checkpointPath:null,createdAt:1,updatedAt:1});
it('listing another project and reading its conversation never select it or touch the browser/composer',async()=>{
 const backend=fixture(),before=watch(),select=vi.spyOn(store,'selectSession'),dir=vi.spyOn(store,'setDirectory');
 await agentControlForTest.execute('sessions',{directory});const result=await agentControlForTest.execute('conversation',{directory,session_id:id}) as {messages:unknown[]};
 expect(result.messages).toHaveLength(1);expect(backend.messages).toHaveBeenCalledWith(id,{directory,limit:200,signal:undefined});expect(watch()).toEqual(before);expect(select).not.toHaveBeenCalled();expect(dir).not.toHaveBeenCalled();
});
it('a background managed wait reads a completed result without moving the visible session',async()=>{
 fixture();managed();const before=watch(),select=vi.spyOn(store,'selectSession');
 expect(await agentControlForTest.execute('wait',{session_id:id,timeout_seconds:1})).toMatchObject({outcome:'completed'});expect(watch()).toEqual(before);expect(select).not.toHaveBeenCalled();
});
it('a managed continuation targets the original chat/model through the durable runtime command, preserving the visible draft and browser',async()=>{
 const backend=fixture();backend.messages.mockResolvedValue(page('still working'));backend.prompt.mockImplementation(async()=>{backend.messages.mockResolvedValue(page('DONE','a2'));});managed();const before=watch(),send=vi.spyOn(store,'sendPrompt'),select=vi.spyOn(store,'selectSession');
 expect(await agentControlForTest.execute('wait',{session_id:id,timeout_seconds:1})).toMatchObject({outcome:'completed'});
 expect(backend.prompt).toHaveBeenCalledOnce();expect(backend.prompt).toHaveBeenCalledWith(id,directory,expect.objectContaining({messageID:expect.stringMatching(/^managed-/),model:{providerID:'original',modelID:'model-original'},variant:'medium'}),expect.any(AbortSignal));expect(send).not.toHaveBeenCalled();expect(select).not.toHaveBeenCalled();expect(watch()).toEqual(before);
});
it('a late background read preserves a newer user selection',async()=>{
 const backend=fixture();let release!:(value:ReturnType<typeof page>)=>void;backend.messages.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
 const initial=store.state;const operation=agentControlForTest.execute('conversation',{directory,session_id:id});
 try {store.state={...initial,activeSessionId:'user-picked-later'};release(page('DONE'));await operation;expect(store.state.activeSessionId).toBe('user-picked-later');expect(store.state.ui).toBe(initial.ui);expect(store.state.prefs).toBe(initial.prefs);}finally{store.state=initial;}
});
it('bounds polling when the cached idle status is behind the authoritative busy status',async()=>{
 vi.useFakeTimers();const backend=fixture();backend.client.snapshot.mockResolvedValue({statuses:{[id]:{type:'busy'}},permissions:[],questions:[]});managed();
 try {const task=agentControlForTest.execute('wait',{session_id:id,timeout_seconds:2});await vi.advanceTimersByTimeAsync(2100);expect(await task).toMatchObject({outcome:'timeout'});expect(backend.messages.mock.calls.length).toBeLessThanOrEqual(3);expect(backend.prompt).not.toHaveBeenCalled();}finally{vi.useRealTimers();}
});
