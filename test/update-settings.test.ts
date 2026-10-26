// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {act,createElement} from 'react';import {createRoot,type Root} from 'react-dom/client';
const f=vi.hoisted(()=>({state:{} as any,prerequisites:{available:true} as any,download:vi.fn(),build:vi.fn(),cancel:vi.fn()}));
vi.mock('../src/state/store',()=>({store:{},useAppState:()=>({})}));
vi.mock('../src/operations/backups',()=>({makeBackup:vi.fn(),restoreBackup:vi.fn()}));
vi.mock('../src/operations/maintenance',()=>({maintenance:{}}));
vi.mock('../src/components/SettingHelp',()=>({SettingField:({children}:any)=>children}));
vi.mock('@tauri-apps/api/core',()=>({invoke:async(_cmd:string,args:any)=>args.action==='prerequisites'?f.prerequisites:[]}));
vi.mock('../src/updates/runtime',()=>({useUpdates:()=>f.state,agentsRunning:()=>false,updates:{refresh:async()=>{},compiling:()=>['downloading','unpacking'].includes(f.state.status.build.stage),prepared:()=>f.state.status.build.stage==='ready',download:f.download,build:f.build,cancel:f.cancel}}));
import {UpdateSettings} from '../src/components/UpdateSettings';
let root:Root;
beforeEach(()=>{
 vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);f.prerequisites={available:true};
 f.state={release:{available:true,kind:'source',version:'2.0.6',binary:{state:'ready'}},status:{hot:{uiVersion:'2.0.5'},nativeVersion:'2.0.5',build:{stage:'idle'}},channel:'stable',busy:'',waiting:false,downloaded:false};
 const container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(()=>{act(()=>root.unmount());document.body.innerHTML='';vi.unstubAllGlobals();});
const render=async()=>{await act(async()=>{root.render(createElement(UpdateSettings));});};
const buttons=()=>[...document.querySelectorAll('button')];
it('offers a ready GitHub download as primary, with explicit build inside the optional section',async()=>{
 await render();const primary=document.querySelector<HTMLButtonElement>('button.primary')!;
 expect(primary.textContent).toBe('Скачать 2.0.6');await act(async()=>primary.click());expect(f.download).toHaveBeenCalledTimes(1);expect(f.build).not.toHaveBeenCalled();
 const build=buttons().find(b=>b.textContent==='Собрать на этом компьютере')!;expect(build.closest('details')).not.toBeNull();expect(build.closest('details')!.open).toBe(false);
});
it('explains pending CI and hides local build when prerequisites are absent',async()=>{
 f.state.release.binary={state:'pending',message:'Пакет ещё собирается.'};f.prerequisites={available:false,reason:'Не установлен Cargo.'};await render();
 expect(document.body.textContent).toContain('Пакет ещё собирается.');expect(document.body.textContent).toContain('Не установлен Cargo.');
 expect(buttons().some(b=>b.textContent?.includes('Скачать')||b.textContent==='Собрать на этом компьютере')).toBe(false);
});
it('a native package transfer shows byte progress and cancellation without offering another build',async()=>{
 f.state.status.build={stage:'downloading',mode:'binary',totalBytes:2048,receivedBytes:1024};await render();
 expect(document.querySelector('progress')?.value).toBe(1024);expect(document.querySelector('select')?.disabled).toBe(true);
 const cancel=buttons().find(b=>b.textContent==='Отменить подготовку')!;await act(async()=>cancel.click());expect(f.cancel).toHaveBeenCalledTimes(1);
 expect(buttons().some(b=>b.textContent==='Собрать на этом компьютере')).toBe(false);
});
