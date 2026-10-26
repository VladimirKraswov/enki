// @vitest-environment jsdom
// The real Composer over the runtime-owned queue (shared route fixture). Files
// are prepared when queued (ZIP staging is native-only, so a text file stands
// in for the archive); corrections go to POST /queue/:item/steer.
import 'fake-indexeddb/auto';
import {File as NodeFile,Blob as NodeBlob} from 'node:buffer';
import {act,createElement} from 'react';import {createRoot,type Root} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import type {QueueItemDTO,QueueStateDTO} from '../src-tauri/resources/agent/src/protocol';
vi.mock('../src/components/ContextMeter',()=>({ContextMeter:()=>null}));
vi.mock('../src/components/WorkspacePicker',()=>({HostPicker:()=>null}));
vi.mock('../src/components/VoiceInput',()=>({VoiceInput:()=>null}));
let root:Root|undefined;
async function composer(files:Array<[string,string,string]>=[]){
 vi.resetModules();
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{}}));vi.stubGlobal('File',NodeFile);vi.stubGlobal('Blob',NodeBlob);
 const fixture=await import('./helpers/runtime-fixture');
 const {store}=await import('../src/state/store');const {Composer}=await import('../src/components/Composer');
 const {attachmentDrafts,attachmentScope}=await import('../src/attachments/drafts');
 const sid='ses_ui_'+crypto.randomUUID(),directory='/queue-ui-'+crypto.randomUUID();
 const fx=fixture.runtimeFixture();fixture.withProvider(fx);
 let queue:QueueStateDTO={sessionID:sid,armed:true,pausedReason:null,items:[]};
 fx.on('GET','/sessions',()=>[{id:sid,directory,title:'ui',projectID:'p',time:{created:1,updated:1}}]);
 fx.on('GET','/sessions/status',()=>({[sid]:{type:'busy'}}));
 fx.on('GET','/sessions/:id/queue',()=>queue);
 fx.on('POST','/sessions/:id/queue',c=>{const b=c.body as {id:string;text:string;parts:Array<{filename?:string;mime?:string}>;model:QueueItemDTO['model']};
  const attachments=b.parts.filter(p=>p.filename).map((p,i)=>({id:`${b.id}-f${i}`,name:p.filename!,mime:p.mime!,size:4}));
  queue={...queue,items:[...queue.items,{id:b.id,sessionID:sid,directory,text:b.text,model:b.model,state:'ready',queuedAt:1,commandId:null,...(attachments.length?{attachments}:{})}]};return queue;});
 fx.on('PATCH','/sessions/:id/queue/:item',c=>{const p=c.body as {text?:string;removeAttachments?:string[]};
  queue={...queue,items:queue.items.map(i=>i.id!==c.params.item?i:{...i,...(p.text?{text:p.text}:{}),attachments:(i.attachments??[]).filter(f=>!(p.removeAttachments??[]).includes(f.id))})};return queue;});
 fx.on('POST','/sessions/:id/queue/reorder',c=>{const b=c.body as {id:string;before:string|null};const moving=queue.items.find(i=>i.id===b.id)!,rest=queue.items.filter(i=>i.id!==b.id);
  rest.splice(b.before===null?rest.length:rest.findIndex(i=>i.id===b.before),0,moving);queue={...queue,items:rest};return queue;});
 fx.on('POST','/sessions/:id/queue/:item/steer',c=>{const item=queue.items.find(i=>i.id===c.params.item)!;const id=`queue-${c.params.item}-1`;
  queue={...queue,items:queue.items.filter(i=>i.id!==c.params.item),corrections:[...(queue.corrections??[]),{id,text:item.text,state:'running',createdAt:1}]};return {id,kind:'steer',sessionID:sid,state:'accepted',createdAt:1,updatedAt:1};});
 fixture.bindStore(store,fx);
 await store.setDirectory(directory,{sessionId:sid});
 store.setModelChoice('p','m','medium');store.setDraft('');
 const scope=attachmentScope(store.state.prefs.workspaceKey,directory,sid);
 if(files.length)await attachmentDrafts.add(scope,files.map(([body,name,type])=>new NodeFile([body],name,{type}) as unknown as File));
 const node=document.createElement('div');document.body.append(node);root=createRoot(node);
 const mount=()=>act(async()=>root!.render(createElement(Composer)));
 return {store,fx,attachmentDrafts,scope,mount,sid,directory};
}
const steers=(fx:any)=>fx.made('POST','/sessions/:id/queue/:item/steer');
const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent===text)!;
afterEach(()=>{if(root)act(()=>root!.unmount());root=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML='';});

it('keeps a corrected prompt visibly separate from queued work until the runtime confirms its SDK entry',async()=>{
 const {store,fx,mount,sid,directory}=await composer();
 await store.enqueuePrompt('Бэкап только системы в /NAS/1tb');await mount();
 await vi.waitFor(()=>expect(button('Скорректировать')).toBeDefined());
 await act(async()=>{button('Скорректировать').click();await vi.waitFor(()=>expect(store.getQueue()).toHaveLength(0));});
 await vi.waitFor(()=>expect(document.querySelector('.pending-correction')?.textContent).toContain('Бэкап только системы в /NAS/1tb'));
 expect(document.querySelector('.pending-correction')?.textContent).toContain('Ждёт следующего шага агента');
 expect(document.querySelector('.queued-prompt')).toBeNull();
 await act(async()=>fx.emit({type:'queue.updated',properties:{queue:{sessionID:sid,items:[],corrections:[],armed:true,pausedReason:null}}} as never,directory));
 expect(document.querySelector('.pending-correction')).toBeNull();
 expect(steers(fx)).toHaveLength(1);expect(fx.made('POST','/sessions/:id/stop')).toEqual([]);expect(fx.made('POST','/commands')).toEqual([]);
});

it('queued file controls remove the file before Now and re-enable the send control',async()=>{
 const {store,fx,attachmentDrafts,scope,mount}=await composer([['notes','notes.txt','text/plain']]);
 await store.enqueueWithAttachments('read project',attachmentDrafts.snapshot(scope));
 await mount();
 await vi.waitFor(async()=>{await act(async()=>{});expect(document.querySelector('.queued-prompt')).not.toBeNull();});
 await act(async()=>{(document.querySelector('[aria-label="Вложения в очереди"]') as HTMLButtonElement).click();});
 const remove=document.querySelector('[aria-label="Убрать из запроса notes.txt"]') as HTMLButtonElement;
 expect(remove).not.toBeNull();
 await act(async()=>{remove.click();await vi.waitFor(()=>expect(store.isQueueLocked()).toBe(false));});
 expect(store.getQueue()[0].attachments).toBeUndefined();
 const now=button('Скорректировать');
 expect(now.disabled).toBe(false);
 await act(async()=>{now.click();await vi.waitFor(()=>expect(steers(fx)).toHaveLength(1));});
 expect(fx.made('PATCH','/sessions/:id/queue/:item')[0].body).toEqual({removeAttachments:[expect.stringMatching(/-f0$/)]});
 expect(fx.made('POST','/sessions/:id/stop')).toEqual([]);
});

it('Now from the queue editor applies the removal and the latest text before steering',async()=>{
 const {store,fx,attachmentDrafts,scope,mount}=await composer([['notes','notes.txt','text/plain']]);
 await store.enqueueWithAttachments('read project',attachmentDrafts.snapshot(scope));
 await mount();
 await vi.waitFor(async()=>{await act(async()=>{});expect(document.querySelector('.queued-prompt')).not.toBeNull();});
 await act(async()=>{button('Изменить').click();await vi.waitFor(()=>expect(store.getQueueEdit()).toBeDefined());});
 await act(async()=>store.setDraft('updated correction'));
 await act(async()=>{
   (document.querySelector('[aria-label="Убрать notes.txt"]') as HTMLButtonElement).click();
   const now=button('Скорректировать');
   expect(now.disabled).toBe(false);now.click();
   await vi.waitFor(()=>expect(steers(fx)).toHaveLength(1));
 });
 expect(fx.made('PATCH','/sessions/:id/queue/:item').map((c:any)=>c.body)).toEqual([{text:'updated correction',removeAttachments:[expect.stringMatching(/-f0$/)]}]);
 expect(store.getQueueEdit()).toBeUndefined();
});

it('the running composer accepts files into the queue instead of blocking them',async()=>{
 const {store,fx,attachmentDrafts,scope,mount}=await composer([['contents','note.txt','text/plain']]);
 store.setDraft('follow up with files');
 await mount();
 expect(document.querySelector('[aria-label="Приложить файлы"]')?.hasAttribute('disabled')).toBe(false);
 await act(async()=>{document.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await vi.waitFor(()=>expect(store.getQueue()).toHaveLength(1),{timeout:3000});});
 expect(store.getQueue()[0].attachments?.files[0].name).toBe('note.txt');
 expect(fx.made('POST','/sessions/:id/queue')[0].body).toMatchObject({text:'follow up with files',parts:[expect.objectContaining({type:'file',filename:'note.txt'})]});
 expect(document.querySelector('[aria-label="Вложения в очереди"]')?.getAttribute('title')).toBe('note.txt');expect(document.body.textContent).not.toContain('Вложения можно отправить после');
 expect(attachmentDrafts.snapshot(scope)).toHaveLength(0);
 expect(fx.made('POST','/commands')).toEqual([]);
});

it('five queued prompts stay as single-line summaries and edit/apply uses the composer',async()=>{
 const {store,fx,mount}=await composer();
 for(let i=0;i<5;i++)await store.enqueuePrompt('Задача '+i+'\nПодробное описание '.repeat(20));
 const original=store.getQueue().map((q:any)=>q.id);
 await mount();
 expect(document.querySelectorAll('.queued-summary')).toHaveLength(5);
 expect(document.querySelector('.queued-summary')!.textContent).not.toContain('\n');
 await act(async()=>{button('Изменить').click();await vi.waitFor(()=>expect(store.getQueueEdit()?.id).toBe(original[0]));});
 expect(document.querySelector('textarea')!.value).toContain('Задача 0\n');expect(document.activeElement).toBe(document.querySelector('textarea'));
 expect(store.getQueue().map((q:any)=>q.id)).toEqual(original);
 await act(async()=>store.setDraft('Уточнённая задача'));
 await act(async()=>{(document.querySelector('[aria-label="Применить изменения"]') as HTMLButtonElement).click();await vi.waitFor(()=>expect(store.getQueueEdit()).toBeUndefined());});
 expect(store.getQueue().map((q:any)=>q.id)).toEqual(original);expect(store.getQueue()[0].text).toBe('Уточнённая задача');expect(document.querySelector('textarea')!.value).toBe('');
 expect(fx.made('PATCH','/sessions/:id/queue/:item').map((c:any)=>c.params.item)).toEqual([original[0]]);
});

it('queue handles move saved entries with the keyboard and keep row actions usable',async()=>{
 const {store,mount}=await composer();
 for(const text of ['read project','second','third'])await store.enqueuePrompt(text);
 await mount();
 const handle=document.querySelector('[aria-label="Переместить задание 3"]') as HTMLButtonElement;
 handle.focus();
 await act(async()=>{handle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));});
 expect(store.getQueue().map((item:any)=>item.text)).toEqual(['read project','third','second']);
 expect(document.activeElement).toBe(handle);
 expect(document.querySelector('[role="status"][aria-live]')?.textContent).toContain('позицию 2');
 await act(async()=>{await store.editQueued(store.getQueue()[0].id);});
 expect((document.querySelector('.queue-drag-handle') as HTMLButtonElement).disabled).toBe(true);
 expect(store.reorderQueued(store.getQueue()[2].id,null)).toBe(false);
});
