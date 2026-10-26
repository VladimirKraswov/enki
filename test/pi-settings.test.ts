// @vitest-environment jsdom
// Agent settings page of the single runtime. The former Pi CLI program/Node
// paths are gone; the retained invariants are: the page owns its tab
// navigation, drafts survive tab switches, unsaved state is reported exactly,
// clearing a draft is clean, and nothing probes a model or writes settings
// without an explicit action. Runtime settings come from GET/PUT /settings.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_PREFS } from '../src/state/prefs';
import { runtimeFixture, type RuntimeFixture } from './helpers/runtime-fixture';
const fake=vi.hoisted(()=>({state:{} as any,backend:null as any,host:null as object|null,settingsListeners:new Set<(s:any)=>void>(),checkPiModelAccess:vi.fn(),getModelChoice:vi.fn(()=>null),setPiSettings:vi.fn(),setPiCustomModel:vi.fn(),setupPiLsp:vi.fn(),refreshModelCatalog:vi.fn()}));
// onRuntimeSettings mirrors Store.onRuntimeSettings: `runtime.settings` events of the connected runtime.
vi.mock('../src/state/store',()=>({useAppState:()=>fake.state,errText:(e:unknown)=>String(e),store:{...fake,maybeBackend:()=>fake.backend,piModelOptions:()=>[],hostLabel:()=>'Этот компьютер',
  currentHost:()=>fake.host,onRuntimeSettings:(l:(s:any)=>void)=>{fake.settingsListeners.add(l);return()=>{fake.settingsListeners.delete(l);};},
  get checkPiModelAccess(){return fake.checkPiModelAccess;},get getModelChoice(){return fake.getModelChoice;},get setPiSettings(){return fake.setPiSettings;},
  get setPiCustomModel(){return fake.setPiCustomModel;},get setupPiLsp(){return fake.setupPiLsp;}}}));
import { PiSettings } from '../src/components/PiSettings';
let root:Root,fx:RuntimeFixture;const dirty=vi.fn();
beforeEach(async()=>{
 vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 fx=runtimeFixture();fx.on('GET','/capabilities',()=>({pty:true,permissions:true,questions:true,attachments:true,fork:true,compaction:true,vcsDiff:true,projectlessChat:true,queue:true,schedules:true,legacyImport:true,extensionUi:{tui:true}}));
 fake.backend=fx.backend;fake.host=null;
 // A configured LSP extension (pre-2.0 pref) so the switch is meaningful.
 fake.state={prefs:{...structuredClone(DEFAULT_PREFS),pi:{lspEnabled:true}},connection:{phase:'connected',version:'test'}};
 const node=document.createElement('div');document.body.append(node);root=createRoot(node);
 await act(async()=>root.render(createElement(PiSettings,{onDirtyChange:dirty})));
 await vi.waitFor(()=>expect(document.querySelector<HTMLInputElement>('[aria-label="Путь к Git"]')!.disabled).toBe(false));
});
afterEach(()=>{act(()=>root.unmount());document.body.innerHTML='';vi.unstubAllGlobals();vi.restoreAllMocks();});
function click(text:string){act(()=>[...document.querySelectorAll('button')].find(x=>x.textContent===text)!.click());}
function input(label:string,value:string){const el=document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));});}
const visible=()=>[...document.querySelectorAll('.setting-group:not([hidden])')].map(x=>x.getAttribute('aria-label'));
const writes=()=>fx.calls.filter(c=>c.method!=='GET');
it('owns agent navigation, retains drafts across tabs and reports unsaved changes without probing models',()=>{
 expect(visible()).toEqual(['Среда выполнения']);
 expect(dirty).toHaveBeenLastCalledWith(false);
 click('Модели');expect(visible()).toEqual(['Модели']);
 input('Свой идентификатор модели','local/own');expect(dirty).toHaveBeenLastCalledWith(true);
 click('Среда выполнения');click('Модели');
 expect(document.querySelector<HTMLInputElement>('[aria-label="Свой идентификатор модели"]')!.value).toBe('local/own');
 input('Свой идентификатор модели','');expect(dirty).toHaveBeenLastCalledWith(false);
 click('Среда выполнения');input('Путь к Git','/usr/local/bin/git');expect(dirty).toHaveBeenLastCalledWith(true);
 input('Путь к Git','');expect(dirty).toHaveBeenLastCalledWith(false);
 expect(fake.checkPiModelAccess).not.toHaveBeenCalled();expect(fake.setPiCustomModel).not.toHaveBeenCalled();expect(fake.setPiSettings).not.toHaveBeenCalled();
 expect(writes()).toEqual([]);
 expect(fx.made('GET','/settings')).toHaveLength(1);
});
it('keeps extension drafts across tabs and marks clearing as clean',()=>{
 click('Расширения и LSP');input('Путь к расширению','/own/extension.ts');expect(dirty).toHaveBeenLastCalledWith(true);
 click('Возможности');expect(visible()).toEqual(['Возможности']);click('Расширения и LSP');
 expect(document.querySelector<HTMLInputElement>('[aria-label="Путь к расширению"]')!.value).toBe('/own/extension.ts');
 input('Путь к расширению','');expect(dirty).toHaveBeenLastCalledWith(false);
 expect(writes()).toEqual([]);
});
it('adds an extension only through the runtime settings and only on an explicit action', async()=>{
 fx.on('PUT','/settings',c=>({defaultPolicy:'ask',extensionPaths:(c.body as any).extensionPaths,useUserPiResources:false,noDiscoveredExtensions:false,gitProgram:null,compaction:{enabled:true},browserEnabled:false}));
 click('Расширения и LSP');input('Путь к расширению','relative/ext.ts');
 const add=[...document.querySelectorAll('button')].find(x=>x.textContent==='Добавить')!;
 expect(add.disabled).toBe(true);
 input('Путь к расширению','/own/extension.ts');
 await act(async()=>add.click());
 await vi.waitFor(()=>expect(fx.made('PUT','/settings')).toHaveLength(1));
 expect(fx.made('PUT','/settings')[0].body).toEqual({extensionPaths:['/own/extension.ts']});
 await vi.waitFor(()=>expect(document.body.textContent).toContain('1 шт.'));
});
const base={defaultPolicy:'ask',extensionPaths:[],useUserPiResources:false,noDiscoveredExtensions:false,gitProgram:null,compaction:{enabled:true},browserEnabled:false};
const lsp=()=>document.querySelector<HTMLInputElement>('[aria-label="Языковые серверы (LSP)"]')!;
it('the LSP switch is the runtime setting of the connected host, never the legacy UI preference',async()=>{
 fx.on('PUT','/settings',c=>({...base,...(c.body as object)}));
 click('Расширения и LSP');
 expect(lsp().checked).toBe(true);
 await act(async()=>lsp().click());
 await vi.waitFor(()=>expect(fx.made('PUT','/settings')).toHaveLength(1));
 expect(fx.made('PUT','/settings')[0].body).toEqual({lspEnabled:false});
 await vi.waitFor(()=>expect(lsp().checked).toBe(false));
 expect(fake.setPiSettings).not.toHaveBeenCalled();
});
it('a runtime.settings announcement from another client updates the page without writing back',async()=>{
 click('Расширения и LSP');expect(lsp().checked).toBe(true);
 await act(async()=>{for(const l of fake.settingsListeners)l({...base,lspEnabled:false,compaction:{enabled:false}});});
 expect(lsp().checked).toBe(false);
 const compaction=document.querySelector<HTMLInputElement>('.setting-group[aria-label="Среда выполнения"] input[type="checkbox"]')!;
 expect(compaction.checked).toBe(false);
 expect(writes()).toEqual([]);
});
it('local Pi packages: counts and runtime diagnostics are shown verbatim; adding one is an explicit runtime write',async()=>{
 const packages=[{path:'/pkgs/tools',present:true,extensions:1,skills:2,prompts:0,themes:0,diagnostics:['Ссылка выходит за пределы пакета (prompts/link); не загружено.']},
  {path:'/pkgs/gone',present:false,extensions:0,skills:0,prompts:0,themes:0,diagnostics:['Пакет Pi не найден или не является папкой: /pkgs/gone']}];
 fx.on('GET','/settings',()=>({...base,skillPaths:[],promptPaths:[],packagePaths:['/pkgs/tools','/pkgs/gone']}));
 fx.on('GET','/settings/resources',()=>({extensions:[],skills:[],prompts:[],packages,deferred:['/settings/packages']}));
 fx.on('PUT','/settings',c=>({...base,skillPaths:[],promptPaths:[],...(c.body as object)}));
 click('Обновить');
 await vi.waitFor(()=>expect(fx.made('GET','/settings/resources').length).toBeGreaterThanOrEqual(2));
 click('Расширения и LSP');
 await vi.waitFor(()=>expect(document.body.textContent).toContain('расширений: 1, навыков: 2'));
 const text=document.body.textContent!;
 expect(text).toContain('/pkgs/tools');
 expect(text).toContain('Ссылка выходит за пределы пакета (prompts/link); не загружено.');
 expect(text).toContain('/pkgs/gone');expect(text).toContain('не найден, не загружается');
 // Imported old-Pi package pointers stay deferred: only an explanation, nothing is activated.
 expect(text).toContain('пакеты');expect(text).toContain('укажите локальную папку');
 expect(writes()).toEqual([]);
 const field=document.querySelector<HTMLInputElement>('[aria-label="Пакеты Pi"]')!;
 const add=field.closest('.setting-control')!.querySelector<HTMLButtonElement>('button')!;
 expect(add.textContent).toBe('Добавить');
 input('Пакеты Pi','relative/pkg');expect(add.disabled).toBe(true);
 input('Пакеты Pi','/pkgs/new');
 await act(async()=>add.click());
 await vi.waitFor(()=>expect(fx.made('PUT','/settings')).toHaveLength(1));
 expect(fx.made('PUT','/settings')[0].body).toEqual({packagePaths:['/pkgs/tools','/pkgs/gone','/pkgs/new']});
 // The status is re-read after a package list change.
 await vi.waitFor(()=>expect(fx.made('GET','/settings/resources').length).toBeGreaterThanOrEqual(3));
});
it('an older runtime without package support keeps the package editor disabled',async()=>{
 click('Расширения и LSP');
 const field=document.querySelector<HTMLInputElement>('[aria-label="Пакеты Pi"]')!;
 input('Пакеты Pi','/pkgs/new');
 const add=field.closest('.setting-control')!.querySelector<HTMLButtonElement>('button')!;
 expect(add.textContent).toBe('Добавить');expect(add.disabled).toBe(true);
});
it('a delayed save from host A cannot replace host B settings or end its still-pending load',async()=>{
 fx.on('GET','/settings',()=>({...base,packagePaths:[]}));
 fx.on('GET','/settings/resources',()=>({extensions:[],skills:[],prompts:[],packages:[],deferred:[]}));
 click('Обновить');click('Расширения и LSP');
 const packageAdd=()=>document.querySelector<HTMLInputElement>('[aria-label="Пакеты Pi"]')!.closest('.setting-control')!.querySelector<HTMLButtonElement>('button')!;
 input('Пакеты Pi','/host-a/new');
 await vi.waitFor(()=>expect(packageAdd().disabled).toBe(false));
 let finishWrite!:(value:unknown)=>void;
 fx.on('PUT','/settings',()=>new Promise(resolve=>{finishWrite=resolve;}));
 const save=vi.spyOn(fx.backend.client,'saveSettings');
 await act(async()=>packageAdd().click());
 await vi.waitFor(()=>expect(fx.made('PUT','/settings')).toHaveLength(1));
 const pendingSave=save.mock.results[0].value as Promise<unknown>;
 const oldResourceReads=fx.made('GET','/settings/resources').length;
 const next=runtimeFixture({connection:{endpoint:'http://127.0.0.1:43124'},workspace:'host-b'});
 let finishLoad!:(value:unknown)=>void;
 next.on('GET','/settings',()=>new Promise(resolve=>{finishLoad=resolve;}));
 next.on('GET','/capabilities',()=>({pty:true,questions:true,extensionUi:{tui:true}}));
 next.on('GET','/settings/resources',()=>({extensions:[],skills:[],prompts:[],packages:[],deferred:[]}));
 fake.backend=next.backend;fake.host={};
 fake.state={...fake.state,prefs:{...fake.state.prefs,workspaceKey:'host-b'}};
 await act(async()=>root.render(createElement(PiSettings,{onDirtyChange:dirty})));
 await vi.waitFor(()=>expect(finishLoad).toBeTypeOf('function'));
 await act(async()=>{finishWrite({...base,packagePaths:['/host-a/new']});await pendingSave;});
 // A's finally must not clear B's busy state and enable a write during B's load.
 input('Пакеты Pi','/host-b/not-submitted');
 expect(packageAdd().disabled).toBe(true);
 expect(document.body.textContent).not.toContain('/host-a/new');
 expect(document.body.textContent).not.toContain('Сохранено. Новые сессии');
 expect(fx.made('GET','/settings/resources')).toHaveLength(oldResourceReads);
 await act(async()=>finishLoad({...base,packagePaths:['/host-b/package'],gitProgram:'/host-b/git'}));
 await vi.waitFor(()=>expect(document.body.textContent).toContain('/host-b/package'));
 expect(document.querySelector<HTMLInputElement>('[aria-label="Путь к Git"]')!.value).toBe('/host-b/git');
 expect(packageAdd().disabled).toBe(false);
 expect(next.calls.filter(c=>c.method!=='GET')).toEqual([]);
 expect(fx.made('PUT','/settings')).toHaveLength(1);
});
it('late resource diagnostics from host A cannot replace the visible host B package status',async()=>{
 fx.on('GET','/settings',()=>({...base,packagePaths:[]}));
 fx.on('GET','/settings/resources',()=>({extensions:[],skills:[],prompts:[],packages:[],deferred:[]}));
 click('Обновить');click('Расширения и LSP');
 const packageAdd=()=>document.querySelector<HTMLInputElement>('[aria-label="Пакеты Pi"]')!.closest('.setting-control')!.querySelector<HTMLButtonElement>('button')!;
 input('Пакеты Pi','/host-a/new');
 await vi.waitFor(()=>expect(packageAdd().disabled).toBe(false));
 let finishResources!:(value:unknown)=>void;
 fx.on('PUT','/settings',()=>({...base,packagePaths:['/host-a/new']}));
 fx.on('GET','/settings/resources',()=>new Promise(resolve=>{finishResources=resolve;}));
 const resourceRead=vi.spyOn(fx.backend.client,'resourceStatus');
 await act(async()=>packageAdd().click());
 await vi.waitFor(()=>expect(finishResources).toBeTypeOf('function'));
 const pendingRead=resourceRead.mock.results[0].value as Promise<unknown>;
 const next=runtimeFixture({connection:{endpoint:'http://127.0.0.1:43124'},workspace:'host-b'});
 next.on('GET','/settings',()=>({...base,packagePaths:['/host-b/package']}));
 next.on('GET','/capabilities',()=>({pty:true,questions:true,extensionUi:{tui:true}}));
 next.on('GET','/settings/resources',()=>({extensions:[],skills:[],prompts:[],packages:[{path:'/host-b/package',present:true,extensions:0,skills:0,prompts:1,themes:0,diagnostics:['HOST-B-RESOURCE']}],deferred:[]}));
 fake.backend=next.backend;fake.host={};
 fake.state={...fake.state,prefs:{...fake.state.prefs,workspaceKey:'host-b'}};
 await act(async()=>root.render(createElement(PiSettings,{onDirtyChange:dirty})));
 await vi.waitFor(()=>expect(document.body.textContent).toContain('HOST-B-RESOURCE'));
 await act(async()=>{finishResources({extensions:[],skills:[],prompts:[],packages:[{path:'/host-a/new',present:true,extensions:0,skills:0,prompts:1,themes:0,diagnostics:['STALE-HOST-A']}],deferred:[]});await pendingRead;});
 expect(document.body.textContent).toContain('/host-b/package');
 expect(document.body.textContent).toContain('HOST-B-RESOURCE');
 expect(document.body.textContent).not.toContain('STALE-HOST-A');
 expect(next.calls.filter(c=>c.method!=='GET')).toEqual([]);
 expect(fx.made('PUT','/settings')).toHaveLength(1);
});
it('a remote host cannot toggle this computer\'s language servers',async()=>{
 fake.host={};await act(async()=>root.render(createElement(PiSettings,{onDirtyChange:dirty})));
 click('Расширения и LSP');
 expect(lsp().disabled).toBe(true);expect(document.body.textContent).toContain('Только на этом компьютере');
});

it('transfers only missing credentials explicitly and shows feedback above the model list', async()=>{
 fx.on('POST','/credentials/import-pi',()=>({imported:['deepseek'],kept:['local'],failed:[]}));
 click('Модели');
 expect(fx.made('POST','/credentials/import-pi')).toHaveLength(0);
 await act(async()=>click('Перенести ключи'));
 await vi.waitFor(()=>expect(document.body.textContent).toContain('Перенесено ключей: 1. Существующих сохранено: 1.'));
 expect(fx.made('POST','/legacy/pi-agent')).toHaveLength(0);
 const status=document.querySelector('.settings-notice')!, group=document.querySelector('[aria-label="Модели"]')!;
 expect(status.compareDocumentPosition(group)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
