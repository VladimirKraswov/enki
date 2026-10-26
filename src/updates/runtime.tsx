import {flushDictationCapture} from '../voice/capture';
import {watchUpdateChecks} from './checks';
import {keepRuntimeAwake} from './background';
import {useEffect,useSyncExternalStore} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {UpdateController,requestUpdateSettings} from './controller';
import {isNative} from '../native/platform';
import {maintenance} from '../operations/maintenance';
import {operationJournal} from '../operations/journal';
import {attachmentDrafts} from '../attachments/drafts';
import {makeBackup} from '../operations/backups';
import {store} from '../state/store';
import {savePrefs,flushPrefs} from '../state/prefs';
const call=<T,>(action:string,extra:Record<string,unknown>={})=>invoke<T>('hub_update',{action,channel:null,data:null,digest:null,...extra});
export function agentsRunning(){const s=store.getSnapshot();return s.ui.sending||s.ui.workspacePreparing||Object.values({...s.statuses,...s.activityStatuses}).some(s=>s.type!=='idle')||Object.keys(s.chat.permissions).length>0||Object.keys(s.chat.questions).length>0||!!s.ui.agentDialog;}
/** Authoritative runtime activity (all folders): owned shells, questions and work this window does not show. */
export async function runtimeBlocker():Promise<string|null>{
  const backend=store.maybeBackend();if(!backend)return null;
  const a=await backend.client.idle();if(a.idle)return null;
  if(a.terminals){
    const unconfirmed=a.pty?.unconfirmed??0, open=a.terminals-unconfirmed;
    if(open>0)return `Открыт терминал (${open}). Завершите оболочку кнопкой «Завершить»: работающая команда может ничего не выводить.`;
    return `Закрытый терминал (${unconfirmed}) не подтвердил очистку фоновых процессов. Проверьте их и нажмите «Отсоединить» в панели терминала.`;
  }
  if(a.questions)return 'Агент ждёт ответа на вопрос в одном из чатов.';
  return 'Среда выполнения Enki ещё выполняет работу. Установите после завершения задач.';
}
export const updates=new UpdateController(call,kind=>maintenance.run(async()=>{
  await flushDictationCapture();
  await operationJournal.drain();await attachmentDrafts.flush();
  savePrefs(store.getSnapshot().prefs);if(!flushPrefs())throw Error('Не удалось сохранить состояние. Обновление отменено.');
  if(kind==='hot') {await call('activate',{channel:updates.snapshot().channel});maintenance.handoff();window.location.reload();}
  else {if(agentsRunning())throw Error('Агенты ещё работают. Установите после завершения задач.');const blocker=await runtimeBlocker();if(blocker)throw Error(blocker);await call('install',{channel:updates.snapshot().channel,data:await makeBackup(store.getSnapshot().prefs)});}
}));
export const useUpdates=()=>useSyncExternalStore(updates.subscribe,updates.snapshot);
export function UpdateRuntime(){
  useEffect(()=>{
    if(!isNative())return;
    const stopAwake=keepRuntimeAwake();
    const saved=localStorage.getItem('arvela.update.channel');updates.setChannel(saved==='preview'?'preview':'stable');
    // Health is acknowledged after React has mounted, never while downloading.
    const checks=watchUpdateChecks(()=>updates.check(),()=>!updates.snapshot().busy&&!updates.snapshot().downloaded&&!updates.compiling()&&!updates.snapshot().waiting);
    void updates.ready().catch(()=>{}).finally(()=>checks.check());
    let alive=true;let unlisten:(()=>void)|undefined;let quitListen:(()=>void)|undefined;
    void listen('arvela-open-updates',()=>{requestUpdateSettings();store.setUi({settingsOpen:true});}).then(fn=>{if(alive)unlisten=fn;else fn();}).catch(()=>{});
    void listen('arvela-before-quit',()=>{void (async()=>{try{await flushDictationCapture();savePrefs(store.getSnapshot().prefs);if(!flushPrefs())throw Error('Не удалось сохранить состояние перед выходом.');await attachmentDrafts.flush();await invoke('runtime_quit_ready',{ready:true});}catch(e){store.setUi({toast:String(e)});await invoke('runtime_quit_ready',{ready:false});}})().catch(()=>{});}).then(fn=>{if(alive)quitListen=fn;else fn();}).catch(()=>{});
    let refreshing=false;
    const timer=setInterval(()=>{if(refreshing)return;refreshing=true;void updates.refresh().then(()=>updates.tick(agentsRunning())).catch(()=>{}).finally(()=>{refreshing=false;});},2000);

    return()=>{alive=false;stopAwake();clearInterval(timer);checks.stop();unlisten?.();quitListen?.();};
  },[]);return null;
}
export function UpdateBadge(){const s=useUpdates();if(!s.release?.available)return null;
  const hot=s.release.kind==='hot';return <button className={`update-badge ${hot?'hot':'native'}`} aria-label={`Обновление ${s.release.version}`} title={`${hot?'Обновить интерфейс без остановки агентов':s.release.binary?.state==='ready'?'Готово к загрузке':s.release.binary?'Новая версия опубликована; готовим пакет':'Доступна новая версия'} · ${s.release.version}`} onClick={()=>{requestUpdateSettings();store.setUi({settingsOpen:true});}}><span aria-hidden="true">↑</span></button>;
}
