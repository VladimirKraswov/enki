import {store} from '../state/store';
import {taskScheduler,MAX_MINUTES} from './tasks';
import {RUNTIME_AGENT_ID} from '../agent/runtime/ids';
/**
 * Agent-control `schedule` command. Explicit scope; it never selects a chat,
 * stops work, sends a prompt or changes the user's draft/model. Every edit is a
 * runtime request that is awaited, so a refusal reaches the caller as an error
 * and an accepted answer carries the runtime's own record.
 */
export async function scheduleCommand(p:Record<string,unknown>) {
 const required=(key:string)=>{const v=p[key];if(typeof v!=='string'||!v.trim())throw Error(`Укажите ${key}`);return v.trim();};
 const directory=required('directory'),sid=required('session_id'),action=required('action');
 const server=store.state.prefs.workspaceKey??store.state.prefs.endpoint,scheduler=taskScheduler();
 await scheduler.refresh();
 const scoped=()=>scheduler.snapshot().filter(t=>t.server===server&&t.directory===directory&&t.sessionID===sid);
 if(action==='list')return {tasks:scoped(),storage:scheduler.status().storage};
 if(['remove','pause','resume'].includes(action)) {
  const id=required('id'),task=scoped().find(t=>t.id===id);if(!task)throw Error('Таймер не найден в этом чате');
  if(action==='remove')await scheduler.remove(id);else if(task.enabled!==(action==='resume'))await scheduler.toggle(id);
  return {tasks:scoped(),pending:scheduler.status().pending[id]??null};
 }
 if(action!=='create')throw Error('Неизвестное действие расписания');
 const backend=store.backend;
 const session=await backend.getSession(sid,directory);
 if(session.directory!==directory||session.time.archived)throw Error('Чат удалён, архивирован или перенесён');
 const current=()=>server===(store.state.prefs.workspaceKey??store.state.prefs.endpoint)&&backend===store.maybeBackend();
 if(!current())throw Error('Подключение изменилось, таймер не сохранён');
 const mode=p.mode??'repeat',minutes=p.minutes??15;
 if(!['once','repeat'].includes(String(mode))||!Number.isInteger(minutes)||(minutes as number)<1||(minutes as number)>MAX_MINUTES)throw Error('Интервал: от 1 минуты до 7 дней');
 const existing=scoped().find(t=>t.requestKey===p.request_key);
 if(p.run_at!==undefined&&(typeof p.run_at!=='number'||!Number.isFinite(p.run_at)||(p.run_at<Date.now()&&existing?.runAt!==p.run_at)||p.run_at>Date.now()+MAX_MINUTES*60000))throw Error('Время запуска должно быть в пределах следующих 7 дней');
 // An explicit model wins; otherwise the background chat's OWN saved model,
 // never the visible chat's selection.
 const variant=typeof p.variant==='string'&&p.variant.trim()?p.variant.trim():null;
 const model=p.provider_id!==undefined||p.model_id!==undefined?{providerID:required('provider_id'),modelID:required('model_id'),...(variant?{variant}:{})}:
  store.modelChoiceForSession(session);
 if(!model)throw Error('Не удалось определить модель этого чата. Укажите provider_id и model_id');
 const task=await scheduler.add({server,directory,sessionID:sid,engine:RUNTIME_AGENT_ID,title:required('title'),prompt:required('prompt'),minutes:minutes as number,mode:mode as 'once'|'repeat',...(p.run_at!==undefined?{runAt:p.run_at as number}:{}),requestKey:required('request_key'),model});
 return {task,notice:'Таймер сохранён в среде выполнения Enki. Работает, пока Enki запущена, в том числе в трее. Полный выход останавливает пробуждения.'};
}
