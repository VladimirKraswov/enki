// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
const platform = vi.hoisted(() => ({native:false}));
vi.mock('../src/native/platform', () => ({isNative:()=>platform.native}));
vi.mock('../src/hub/client', () => ({config: vi.fn(), request: vi.fn()}));
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectMemory } from '../src/components/MemorySection';
import { projects } from '../src/memory/projects';
import { outcomes, blankOutcome, reviewOutcome, changeOutcome, type Outcome } from '../src/outcomes/store';
import { memoryPage, memoryWrite, synchronizeMemorySources, type MemoryPage, type MemoryEntry } from '../src/memory/client';
vi.mock('../src/memory/client', async importOriginal => ({ ...await importOriginal<typeof import('../src/memory/client')>(), memoryPage: vi.fn(), memoryWrite: vi.fn(), synchronizeMemorySources: vi.fn(async () => {}) }));
import { readRetrieval, connectRetrieval } from '../src/memory/retrieval';
vi.mock('../src/memory/retrieval', async importOriginal => ({...await importOriginal<typeof import('../src/memory/retrieval')>(),readRetrieval:vi.fn(),connectRetrieval:vi.fn()}));
let root: Root, node: HTMLDivElement, scope: {hub:string;server:string;directory:string}, page: MemoryPage, card: Outcome;
beforeEach(async () => { platform.native=false;
 vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
 scope = { hub: crypto.randomUUID(), server: 'test', directory: '/test/' + crypto.randomUUID() }; const id = crypto.randomUUID();
 await projects.bind(scope, id, 'Explicit project', null); page = { projects: [{id,title:'Explicit project',created:1}], entries: [] };
 const raw = { ...blankOutcome({...scope,sessionID:'s',engine:'pi'},'u','Build'), criteria:'Build succeeds', notes:'Check the documented compiler' }; card = await outcomes.save(raw, null); card = await outcomes.save(reviewOutcome(card,'accepted'),card.revision);
 vi.mocked(memoryPage).mockImplementation(async () => structuredClone(page));
 vi.mocked(memoryWrite).mockImplementation(async (_scope, input) => { const b = input as {action:string;entry:MemoryEntry;id:string;expected:number}; if(b.action==='save'){page.entries.push({...b.entry,revision:1,updated:1,sourceDevice:'Mac',state:'candidate'});return page.entries[0];} const e=page.entries.find(e=>e.id===b.id)!; if(e.revision!==b.expected)throw Error('Conflict'); e.state=b.action==='approve'?'approved':'stale';e.revision++; return e; });
 node=document.createElement('div'); document.body.append(node); root=createRoot(node);
});
afterEach(() => { act(()=>root.unmount());node.remove();vi.clearAllMocks();vi.unstubAllGlobals(); });
async function until(check:()=>void){await vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,10));});check();});}
const button=(label:string)=>Array.from(node.querySelectorAll('button')).find(b=>b.textContent===label)!;
const click=(label:string)=>act(async()=>{button(label).click();});
const mount=(proposed:Outcome|null=card,shareText=true)=>act(async()=>{root.render(createElement(ProjectMemory,{scope,shareText,proposed}));});
it('separates proposal, save and approval; scopes every call to the current Hub',async()=>{
 await mount(); await until(()=>expect(button('Сохранить кандидата')?.disabled).toBe(false));expect(memoryWrite).not.toHaveBeenCalled();
 await click('Сохранить кандидата');await until(()=>expect(button('Одобрить запись')?.disabled).toBe(false));expect(node.textContent).toContain('Ждёт вашей проверки');
 const [,body]=vi.mocked(memoryWrite).mock.calls[0];expect(JSON.stringify(body)).not.toContain(scope.directory);expect(vi.mocked(memoryWrite).mock.calls[0][0]).toEqual(scope);
 await click('Одобрить запись');await until(()=>expect(node.textContent).toContain('Одобрено вами'));expect(synchronizeMemorySources).toHaveBeenCalled();
});
it('retains an unsaved candidate on write failure and refuses a changed source',async()=>{
 await mount();await until(()=>expect(button('Сохранить кандидата')?.disabled).toBe(false));vi.mocked(memoryWrite).mockRejectedValueOnce(Error('Network offline'));
 await click('Сохранить кандидата');await until(()=>expect(node.querySelector('[role=alert]')?.textContent).toContain('offline'));
 expect(node.querySelector<HTMLTextAreaElement>('[aria-label="Текст памяти"]')?.value).toBe(card.notes);expect(page.entries).toHaveLength(0);
 card=await outcomes.save(changeOutcome(card,{notes:'changed'}),card.revision);card=await outcomes.save(reviewOutcome(card,'accepted'),card.revision);
 await click('Сохранить кандидата');await until(()=>expect(node.querySelector('[role=alert]')?.textContent).toContain('изменён'));expect(memoryWrite).toHaveBeenCalledTimes(1);
});
it('requires text consent for new candidates while allowing existing memory reads',async()=>{
 await mount(card,false);await until(()=>expect(node.querySelector('[aria-label="Переносимый код проекта"]')).not.toBeNull());expect(button('Сохранить кандидата').disabled).toBe(true);expect(memoryWrite).not.toHaveBeenCalled();
});
it('does not display ready memory when source synchronization fails',async()=>{
 vi.mocked(synchronizeMemorySources).mockRejectedValueOnce(Error('Cannot check source revision'));await mount();await until(()=>expect(node.querySelector('[role=alert]')?.textContent).toContain('source revision'));expect(button('Сохранить кандидата')).toBeUndefined();expect(memoryWrite).not.toHaveBeenCalled();
});
const fillInput=(label:string,value:string)=>act(async()=>{const el=node.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));});
it('never binds a same-name project implicitly and requires preview confirmation on another device',async()=>{
 scope={...scope,directory:'D:\\another\\project-'+crypto.randomUUID()};await mount(null,false);
 await until(()=>expect(node.querySelector('[aria-label="Код проекта памяти"]')).not.toBeNull());expect(await projects.get(scope)).toBeNull();expect(memoryWrite).not.toHaveBeenCalled();
 await fillInput('Код проекта памяти',page.projects[0].id);await until(()=>expect(button('Проверить код проекта').disabled).toBe(false));await click('Проверить код проекта');
 await until(()=>expect(button('Подтвердить привязку папки')).toBeDefined());expect(await projects.get(scope)).toBeNull();await click('Подтвердить привязку папки');
 await until(()=>expect(node.querySelector('[aria-label="Переносимый код проекта"]')).not.toBeNull());expect((await projects.get(scope))?.projectID).toBe(page.projects[0].id);expect(memoryWrite).not.toHaveBeenCalled();
});
it('creating a Hub project still requires separate local binding confirmation',async()=>{
 scope={...scope,directory:'/new/'+crypto.randomUUID()};await mount(null);
 vi.mocked(memoryWrite).mockImplementationOnce(async (_scope,body)=>{const b=body as {id:string;title:string};const p={id:b.id,title:b.title,created:1};page.projects.push(p);return p;});
 await until(()=>expect(node.querySelector('[aria-label="Название проекта памяти"]')).not.toBeNull());await fillInput('Название проекта памяти','New project');await until(()=>expect(button('Создать проект памяти').disabled).toBe(false));await click('Создать проект памяти');
 await until(()=>expect(button('Подтвердить привязку папки')).toBeDefined());expect(await projects.get(scope)).toBeNull();await click('Подтвердить привязку папки');await until(()=>expect(node.querySelector('[aria-label="Переносимый код проекта"]')).not.toBeNull());expect((await projects.get(scope))?.title).toBe('New project');
});

it('allows revoking the native memory grant when Hub is unavailable',async()=>{
 const original=await projects.get(scope);scope={...scope,server:'http://127.0.0.1:4096'};await projects.bind(scope,original!.projectID,original!.title,null);platform.native=true;
 const grant={scope:{...scope,project:original!.projectID},enabled:true,revision:1};vi.mocked(readRetrieval).mockResolvedValue({grant,key:'project-0123456789abcdef',registered:true});
 vi.mocked(connectRetrieval).mockResolvedValue({grant:{...grant,enabled:false,revision:2},key:'project-0123456789abcdef',registered:false});vi.mocked(memoryPage).mockRejectedValue(Error('Hub offline'));
 await mount(null);await until(()=>expect(node.querySelector('[role=alert]')?.textContent).toContain('Hub offline'));expect(button('Отключить память').disabled).toBe(false);
 const observations=vi.mocked(synchronizeMemorySources).mock.calls.length;await click('Отключить память');await until(()=>expect(button('Подключить память').disabled).toBe(true));
 expect(connectRetrieval).toHaveBeenCalledWith(grant.scope,false);expect(synchronizeMemorySources).toHaveBeenCalledTimes(observations);expect(node.textContent).toContain('Поиск отключён');
});
