// @vitest-environment jsdom
// Project/session information from the single runtime catalogue: Enki chats and
// read-only OpenCode archives; sizes are never guessed; reconnects reject stale data.
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,createElement} from 'react';import {createRoot,type Root} from 'react-dom/client';
const fake=vi.hoisted(()=>({state:{prefs:{endpoint:'local',activeHost:'local'}} as {prefs:Record<string,string>},backend:null as unknown,page:vi.fn()}));
vi.mock('../src/state/store',()=>({useAppState:()=>fake.state,store:{maybeBackend:()=>fake.backend}}));
import {InformationDialog} from '../src/components/InformationDialog';
let root:Root;
const dto=(id:string,extra:Record<string,unknown>={})=>({id,directory:'/p',title:`Chat ${id}`,projectID:'p',time:{created:1,updated:2},...extra});
beforeEach(()=>{
 vi.resetAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);fake.state={prefs:{endpoint:'local',activeHost:'local'}};
 HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};
 fake.page.mockImplementation(async(query:{archived?:boolean})=>({sessions:query.archived?[dto('old',{time:{created:1,updated:1,archived:5}})]:[dto('a'),dto('legacy',{origin:{kind:'opencode',archive:'x',legacyId:'l'}})],cursor:null}));
 fake.backend={client:{recentSessions:fake.page}};
 const node=document.createElement('div');document.body.append(node);root=createRoot(node);
});
afterEach(()=>{act(()=>root.unmount());document.body.innerHTML='';vi.unstubAllGlobals();});
const mount=async(props:Record<string,unknown>)=>{await act(async()=>root.render(createElement(InformationDialog,props as never)));await act(async()=>{await new Promise(r=>setTimeout(r,0));});};

it('lists active and archived chats from the runtime, labelling read-only OpenCode archives',async()=>{
 await mount({directory:'/p',onClose:vi.fn()});
 expect(fake.page).toHaveBeenCalledWith(expect.objectContaining({archived:false,directory:'/p'}),expect.anything());
 expect(fake.page).toHaveBeenCalledWith(expect.objectContaining({archived:true,directory:'/p'}),expect.anything());
 expect(document.body.textContent).toContain('Chat a');
 expect(document.body.textContent).toContain('Архив OpenCode (только чтение)');
 expect(document.body.textContent).toContain('Размер недоступен');
});
it('a single session is shown without listing the project',async()=>{
 await mount({directory:'/p',session:dto('a'),onClose:vi.fn()});
 expect(fake.page).not.toHaveBeenCalled();expect(document.body.textContent).toContain('Chat a');
});
it('host changes immediately hide previous data and close the modal',async()=>{
 const close=vi.fn();await mount({directory:'/p',session:dto('a'),onClose:close});
 fake.state={prefs:{endpoint:'other',activeHost:'remote'}};await mount({directory:'/p',session:dto('a'),onClose:close});
 expect(close).toHaveBeenCalled();expect(document.querySelector('dialog')).toBeNull();
});
it('a backend reconnect rejects stale lists and offers refresh instead of an endless loader',async()=>{
 let resolve!:(value:unknown)=>void;fake.page.mockReturnValue(new Promise(r=>{resolve=r;}));
 await mount({directory:'/p',onClose:vi.fn()});
 fake.backend={client:{recentSessions:fake.page}};
 await act(async()=>resolve({sessions:[dto('stale')],cursor:null}));
 expect(document.body.textContent).not.toContain('Chat stale');expect(document.body.textContent).toContain('Подключение изменилось');
 expect(Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Обновить')).toBe(true);
});
it('without a runtime connection it reports the failure instead of inventing rows',async()=>{
 fake.backend=null;await mount({directory:'/p',onClose:vi.fn()});
 expect(document.body.textContent).toContain('Не удалось получить список чатов');
});
