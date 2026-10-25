// @vitest-environment jsdom
// Timer list over the runtime mirror: edits are runtime requests, nothing is
// dispatched from the window. Save, pause and remove await the runtime; a
// refusal is shown in the section (fixed in the final UI review).
import {it,expect,vi,afterEach} from 'vitest';
import {createElement,act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import type {ScheduleDTO} from '../src-tauri/resources/agent/src/protocol';
import {ScheduleSection} from '../src/components/ScheduleSection';
import {TaskScheduler} from '../src/schedules/tasks';
import {RuntimeReply,runtimeFixture} from './helpers/runtime-fixture';
vi.mock('../src/state/store',()=>({store:{engineIdFor:()=> 'pi',getModelChoice:()=>({providerID:'p',modelID:'m'}),getAgentChoice:()=>null}}));
let root:Root|undefined;
afterEach(()=>{act(()=>root?.unmount());document.body.innerHTML='';vi.unstubAllGlobals();vi.restoreAllMocks();});
const dto=(id:string,extra:Partial<ScheduleDTO>={}):ScheduleDTO=>({id,directory:'/p',sessionID:'s',title:'Проверить CI',prompt:'Проверь CI',minutes:5,mode:'repeat',
 model:{providerID:'p',modelID:'m'},enabled:true,nextAt:Date.now()+300000,state:'ready',...extra});
async function mounted(){
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const fx=runtimeFixture(),tasks=new Map([['a',dto('a')],['b',dto('b',{sessionID:'other',title:'Напомнить через час',mode:'once',minutes:60})]]);
 fx.on('GET','/schedules',()=>({tasks:[...tasks.values()]}));
 fx.on('PATCH','/schedules/:id',c=>{const t={...tasks.get(c.params.id)!,...(c.body as object)};tasks.set(t.id,t);return t;});
 fx.on('DELETE','/schedules/:id',c=>{tasks.delete(c.params.id);return undefined;});
 const scheduler=new TaskScheduler();scheduler.attach(fx.backend,'local');
 await vi.waitFor(()=>expect(scheduler.snapshot()).toHaveLength(2));
 const node=document.createElement('div');document.body.append(node);root=createRoot(node);
 await act(async()=>root!.render(createElement(ScheduleSection,{scheduler,server:'local',directory:'/p',sessionID:'s',showAll:true})));
 return {fx,scheduler,node};
}
it('lists timers across chats and pauses/deletes the exact row without dispatching work',async()=>{
 const {fx,scheduler,node}=await mounted();
 expect(node.querySelectorAll('.context-task')).toHaveLength(2);expect(node.textContent).toContain('Один раз');expect(node.textContent).toContain('Каждые 5 мин');
 const row=node.querySelector('.context-task')!;
 await act(async()=>{(row.querySelector('.context-task-actions button') as HTMLButtonElement).click()});
 await vi.waitFor(()=>expect(scheduler.snapshot().find(t=>t.id==='a')?.enabled).toBe(false));
 await act(async()=>{});
 expect(fx.made('PATCH','/schedules/:id').map(c=>[c.params.id,c.body])).toEqual([['a',{enabled:false}]]);
 expect(node.querySelector('.context-task')!.textContent).toContain('Приостановлено вручную');
 await act(async()=>{(node.querySelector('.context-task')!.querySelectorAll('.context-task-actions button')[1] as HTMLButtonElement).click()});
 await vi.waitFor(()=>expect(scheduler.snapshot()).toHaveLength(1));
 await act(async()=>{});
 expect(node.textContent).not.toContain('Проверить CI');
 expect(fx.made('DELETE','/schedules/:id').map(c=>c.params.id)).toEqual(['a']);
 expect(fx.made('POST','/commands')).toHaveLength(0);
});
it('saving a new timer sends the chat model to the runtime and starts no work',async()=>{
 const {fx,node}=await mounted();
 fx.on('POST','/schedules',c=>dto('c',c.body as Partial<ScheduleDTO>));
 await act(async()=>{(node.querySelector('[aria-label="Добавить таймер"]') as HTMLButtonElement).click()});
 const set=(el:HTMLInputElement|HTMLTextAreaElement,value:string)=>{const proto=Object.getPrototypeOf(el);Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));};
 await act(async()=>{set(node.querySelector('form input:not([type=number])')!,'Ночная сборка');set(node.querySelector('form textarea')!,'Проверь сборку');});
 await act(async()=>{(node.querySelector('form button[type=submit]') as HTMLButtonElement).click()});
 await vi.waitFor(()=>expect(fx.made('POST','/schedules')).toHaveLength(1));
 expect(fx.made('POST','/schedules')[0].body).toMatchObject({directory:'/p',sessionID:'s',title:'Ночная сборка',prompt:'Проверь сборку',minutes:15,mode:'repeat',model:{providerID:'p',modelID:'m'}});
 expect(node.querySelector('[role=alert]')).toBeNull();
 expect(fx.made('POST','/commands')).toHaveLength(0);
});
it('shows the runtime\'s retry attempt, cancellation and pause details of each timer (final seam port)',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const fx=runtimeFixture();
 const paused='Таймер приостановлен: пробуждение не отправлено после 4 попыток; возобновите его вручную. Модель недоступна.';
 fx.on('GET','/schedules',()=>({tasks:[
  dto('retry',{state:'waiting',attempt:2,detail:'Hub не ответил вовремя. Запрос агенту не отправлен.'}),
  dto('cancel',{title:'Отменённый',detail:'Пробуждение отменено до отправки; следующее — через полный интервал.'}),
  dto('paused',{title:'Пауза',enabled:false,state:'error',detail:paused}),
  dto('blocked',{title:'Ждёт',state:'waiting',detail:'Ожидает завершения текущей работы агента'}),
 ]}));
 const scheduler=new TaskScheduler();scheduler.attach(fx.backend,'local');
 await vi.waitFor(()=>expect(scheduler.snapshot()).toHaveLength(4));
 expect(scheduler.snapshot().find(t=>t.id==='retry')?.attempt).toBe(2);
 const node=document.createElement('div');document.body.append(node);root=createRoot(node);
 await act(async()=>root!.render(createElement(ScheduleSection,{scheduler,server:'local',directory:'/p',sessionID:'s',showAll:true})));
 const rows=[...node.querySelectorAll('.context-task')].map(r=>r.textContent??'');
 expect(rows[0]).toContain('Не отправлено: Hub не ответил вовремя.');expect(rows[0]).toContain('повторная попытка 3 из 4');
 expect(rows[1]).toContain('Пробуждение отменено до отправки; следующее — через полный интервал.');expect(rows[1]).toContain('Следующий запуск');
 expect(rows[2]).toContain('Приостановлено');expect(rows[2]).toContain(paused);
 // A plain blocker keeps its wording and claims no retry attempt.
 expect(rows[3]).toContain('Ожидает завершения текущей работы агента · проверка повторяется');expect(rows[3]).not.toContain('попытка');
 expect(fx.made('POST','/commands')).toHaveLength(0);
});
it('a runtime refusal of a pause is explained in the section instead of disappearing',async()=>{
 const {fx,scheduler,node}=await mounted();
 fx.on('PATCH','/schedules/:id',()=>{throw new RuntimeReply(409,{message:'Таймер сейчас отправляет запрос; повторите через несколько секунд.'});});
 const unhandled=vi.fn();process.on('unhandledRejection',unhandled);
 try{
  await act(async()=>{(node.querySelector('.context-task .context-task-actions button') as HTMLButtonElement).click()});
  await vi.waitFor(()=>expect(node.querySelector('[role=alert]')).not.toBeNull());
  expect(scheduler.snapshot().find(t=>t.id==='a')?.enabled).toBe(true);
  expect(scheduler.status().pending).toEqual({});
  expect(unhandled).not.toHaveBeenCalled();
 }finally{process.off('unhandledRejection',unhandled);}
});
