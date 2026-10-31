import {describe,it,expect,vi} from 'vitest';
import {ACTIVE_BUILD_STAGES,BUILD_STAGE_TEXT,UpdateController,type NativeStatus,type Release,type Transport} from '../src/updates/controller';
const native:NativeStatus={nativeVersion:'1.0.0',nativeFingerprint:'a'.repeat(64),hot:{uiVersion:'1.0.0',activeDigest:null,pending:false,lastError:null},build:{stage:'ready'}};
function fixture(kind:'hot'|'source'='hot'){
 const call=vi.fn(async(action:string)=>action==='check'?{available:true,version:'1.0.1',kind}:action==='status'?native:{});
 const apply=vi.fn(async()=>{}),controller=new UpdateController(call as Transport,apply);
 return{controller,call,apply};
}
describe('Hub updater control',()=>{
 it('hot update is available during active work; native update waits until idle',async()=>{
  const hot=fixture();await hot.controller.check();await hot.controller.download();await hot.controller.install(true);expect(hot.apply).toHaveBeenCalledWith('hot');
  const source=fixture('source');await source.controller.check();await source.controller.download();await source.controller.install(true);expect(source.apply).not.toHaveBeenCalled();expect(source.controller.snapshot().waiting).toBe(true);
  await source.controller.tick(true);expect(source.apply).not.toHaveBeenCalled();await source.controller.tick(false);expect(source.apply).toHaveBeenCalledExactlyOnceWith('source');await source.controller.tick(false);expect(source.apply).toHaveBeenCalledTimes(1);
 });
 it('never retries failed installs automatically and cancellation preserves the release',async()=>{
  const f=fixture('source');await f.controller.check();await f.controller.download();await f.controller.install(true);f.apply.mockRejectedValueOnce(Error('new work started'));await f.controller.tick(false);expect(f.controller.snapshot().waiting).toBe(false);expect(f.controller.snapshot().error).toContain('new work started');await f.controller.tick(false);expect(f.apply).toHaveBeenCalledTimes(1);expect(f.controller.snapshot().downloaded).toBe(true);
 });
 it('channel changes invalidate downloaded state; concurrent checks do not race',async()=>{
  const f=fixture();let finish!:(value:unknown)=>void;f.call.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const p=f.controller.check();await f.controller.check();f.controller.setChannel('preview');expect(f.controller.snapshot().channel).toBe('stable');finish({available:true,version:'1.0.1',kind:'hot'});await p;await f.controller.download();f.controller.setChannel('preview');expect(f.controller.snapshot().release).toBeNull();expect(f.controller.snapshot().downloaded).toBe(false);
 });
 it('health acknowledgement names the exact active UI, not the available download',async()=>{
  const f=fixture();await f.controller.ready();expect(f.call).toHaveBeenLastCalledWith('ready',{digest:null});
 });
});
it('a previous channel cannot be restored into the newly selected channel',async()=>{
 const call=vi.fn(async()=>({...native,release:{available:true,version:'1.0.1',kind:'source',channel:'stable'},downloaded:true}));const c=new UpdateController(call as Transport,async()=>{});
 c.setChannel('preview');await c.refresh();expect(c.snapshot().release).toBeNull();expect(c.snapshot().downloaded).toBe(false);
 c.setChannel('stable');await c.refresh();expect(c.snapshot().release?.version).toBe('1.0.1');expect(c.snapshot().downloaded).toBe(true);
});
it('every active native build phase, including runtime preparation, is cancellable once and blocks channel changes; the release is kept',async()=>{
 let stage='runtime';
 const call=vi.fn(async(action:string)=>action==='check'?{available:true,version:'1.0.1',kind:'source',channel:'stable',digest:'c'.repeat(64)}:action==='status'?{...native,build:{stage,version:'1.0.1'}}:{});
 const c=new UpdateController(call as Transport,async()=>{});await c.check();await c.download();
 for(const active of ACTIVE_BUILD_STAGES){stage=active;await c.refresh();expect(c.compiling()).toBe(true);expect(BUILD_STAGE_TEXT[active]).toBeTruthy();c.setChannel('preview');expect(c.snapshot().channel).toBe('stable');}
 expect(BUILD_STAGE_TEXT.runtime).toMatch(/Подготовка компонентов Enki/);
 stage='runtime';await c.refresh();await c.cancel();
 expect(call.mock.calls.filter(([action])=>action==='cancel')).toHaveLength(1);
 stage='error';await c.refresh();expect(c.compiling()).toBe(false);
 expect(c.snapshot().release?.version).toBe('1.0.1');expect(c.snapshot().downloaded).toBe(true);
});
it('native download and unpacking keep controls fenced and never start a source build after download failure',async()=>{
 const f=fixture('source');await f.controller.check();
 f.call.mockRejectedValueOnce(Error('GitHub unavailable'));
 await f.controller.download();expect(f.controller.snapshot().error).toContain('GitHub unavailable');
 expect(f.call.mock.calls.some(([action])=>action==='build')).toBe(false);
 for(const stage of ['downloading','unpacking']){
   f.call.mockResolvedValueOnce({...native,build:{stage,mode:'binary'}});
   await f.controller.refresh();expect(f.controller.compiling()).toBe(true);
   f.controller.setChannel('preview');expect(f.controller.snapshot().channel).toBe('stable');
 }
});
it('a built artifact belongs only to the exact checked release',async()=>{
 const call=vi.fn(async(action:string)=>action==='check'?{available:true,version:'1.0.1',kind:'source',digest:'b'.repeat(64)}:{...native,build:{stage:'ready',digest:'a'.repeat(64)}});
 const c=new UpdateController(call as Transport,async()=>{});await c.check();await c.refresh();expect(c.prepared()).toBe(false);
 call.mockImplementation(async()=>({...native,build:{stage:'ready',digest:'b'.repeat(64)}}));await c.refresh();expect(c.prepared()).toBe(true);
});

it('explicit retry clears only a failed old builder and never a running or modern builder', async()=>{
 for(const [version,stage,clear,build] of [['2.0.2','error',true,true],['2.0.6','error',false,true],['2.0.2','runtime',false,false]] as const){
  const call=vi.fn(async(action:string)=>action==='status'?{...native,nativeVersion:version,build:{stage}}:{});
  const c=new UpdateController(call as Transport,async()=>{});await c.build();
  expect(call.mock.calls.some(([a])=>a==='clear')).toBe(clear);
  expect(call.mock.calls.some(([a])=>a==='build')).toBe(build);
  if(clear)expect(call.mock.calls.map(([a])=>a)).toEqual(['status','clear','build','status']);
 }
});
it('a failed retry is visible and keeps the verified download for another attempt',async()=>{
 const c=new UpdateController((async(action:string)=>{if(action==='status')return {...native,build:{stage:'error'}};if(action==='build')throw Error('Disk full');return {};}) as Transport,async()=>{});
 await c.download();await c.build();expect(c.snapshot().error).toContain('Disk full');expect(c.snapshot().downloaded).toBe(true);expect(c.snapshot().busy).toBe('');
});

// Badge freshness contract with hub_updates::hub_update status (31 Oct 2026):
// the native cache is the authority; the UI must follow every meaningful change
// and must not keep a release the native cache no longer confirms.
it('follows a newly published release: digest swap between two real digests, then installer readiness',async()=>{
 let head:Record<string,unknown>={available:true,version:'1.0.1',kind:'source',channel:'stable',digest:'a'.repeat(64),binary:{state:'pending'}};
 const c=new UpdateController((async()=>({...native,release:head,downloaded:false})) as Transport,async()=>{});
 await c.refresh();expect(c.snapshot().release?.digest).toBe('a'.repeat(64));
 // A newer publication changes the digest; comparing emptiness would miss it.
 head={available:true,version:'1.0.2',kind:'source',channel:'stable',digest:'b'.repeat(64),binary:{state:'pending'}};
 await c.refresh();expect(c.snapshot().release?.digest).toBe('b'.repeat(64));expect(c.snapshot().release?.version).toBe('1.0.2');
 head={...head,binary:{state:'ready'}};await c.refresh();expect(c.snapshot().release?.binary?.state).toBe('ready');
 // Identical status must not churn the state object.
 const before=c.snapshot();await c.refresh();expect(c.snapshot().release).toBe(before.release);
});
it('a cleared native release removes the indicator instead of sticking (installed or invalidated)',async()=>{
 let head:Release|null={available:true,version:'1.0.1',kind:'hot',channel:'stable',digest:'a'.repeat(64),binary:{state:'ready'}};
 const c=new UpdateController((async()=>({...native,release:head,downloaded:true})) as Transport,async()=>{});
 await c.refresh();expect(c.snapshot().release?.available).toBe(true);
 // The check action clears its cache when the head has nothing newer; an
 // explicit null is confirmation, not an absent result.
 head=null;await c.refresh();expect(c.snapshot().release).toBeNull();expect(c.snapshot().downloaded).toBe(false);
 // An available:false answer from check() survives (it is the current truth).
 const call=vi.fn(async(action:string)=>action==='check'?{available:false}:{...native,release:null});
 const d=new UpdateController(call as Transport,async()=>{});await d.check();await d.refresh();expect(d.snapshot().release?.available).toBe(false);
});
it('an older native without a release field never overwrites a checked release',async()=>{
 const c=new UpdateController((async(action:string)=>action==='check'?{available:true,version:'1.0.1',kind:'hot',digest:'a'.repeat(64)}:native) as Transport,async()=>{});
 await c.check();await c.refresh();expect(c.snapshot().release?.digest).toBe('a'.repeat(64));
});
