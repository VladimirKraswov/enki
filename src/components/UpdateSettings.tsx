import { SettingField } from "./SettingHelp";
import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {store,useAppState} from '../state/store';
import {makeBackup,restoreBackup,type BackupData} from '../operations/backups';
import {maintenance} from '../operations/maintenance';
import {agentsRunning,updates,useUpdates} from '../updates/runtime';
import {BUILD_STAGE_TEXT as stages} from '../updates/controller';
import {version} from '../../package.json';
export function UpdateSettings(){
  useAppState();const u=useUpdates(),running=agentsRunning(),compiling=updates.compiling();
  const [busy,setBusy]=useState(''),[notice,setNotice]=useState('');
  const [backups,setBackups]=useState<{id:string;version:string}[]>([]),[selected,setSelected]=useState('');
  const call=<T,>(action:string,extra:Record<string,unknown>={})=>invoke<T>('app_update',{action,channel:null,data:null,backupId:null,...extra});
  const refresh=()=>call<typeof backups>('backups').then(setBackups);
  useEffect(()=>{void refresh().catch(e=>setNotice(String(e)));void updates.refresh().catch(()=>{});},[]);
  const maintain=async(action:'backup'|'restore')=>{
    setBusy(action);setNotice('');try{await maintenance.run(async()=>{
      if(agentsRunning())throw Error('Дождитесь завершения агентов.');
      const data=await makeBackup(store.getSnapshot().prefs);
      if(action==='restore'){const r=await call<{data:BackupData}>('restore',{data,backupId:selected});await restoreBackup(r.data);window.location.reload();}
      else{await call('backup',{data});await refresh();setNotice('Резервная копия создана.');}
    });}catch(e){setNotice(String(e));}finally{setBusy('');}
  };
  const disabled=!!u.busy||!!busy;
  const hot=u.release?.kind==='hot',built=updates.prepared(),stage=u.status?.build.stage;
  return <section className="setting-group quality-settings"><h2>Enki {u.status?.hot.uiVersion??version}</h2>
    {u.status&&u.status.nativeVersion!==u.status.hot.uiVersion&&<p className="muted">Нативная версия {u.status.nativeVersion}</p>}
    <SettingField label="Канал"><select value={u.channel} disabled={disabled||u.waiting||compiling} onChange={e=>{const channel=e.target.value==='preview'?'preview':'stable';updates.setChannel(channel);localStorage.setItem('arvela.update.channel',channel);}}><option value="stable">Стабильный</option><option value="preview">Предварительный</option></select></SettingField>
    <div className="btn-row"><button className="btn" disabled={disabled||compiling||u.waiting} onClick={()=>void updates.check()}>{u.busy==='check'?'Проверяю…':'Проверить обновления'}</button>
      {u.release?.available&&!u.downloaded&&<button className="btn" disabled={disabled} onClick={()=>void updates.download()}>{u.busy==='download'?'Загрузка…':`Скачать ${u.release.version}`}</button>}
      {u.downloaded&&!hot&&!compiling&&!built&&<button className="btn" disabled={disabled} onClick={()=>void updates.build()}>{u.busy==='build'?'Запускаю сборку…':stage==='error'?'Повторить сборку':'Собрать на этом компьютере'}</button>}
      {u.downloaded&&(hot||built)&&<button className="btn primary" disabled={disabled||u.waiting} onClick={()=>void updates.install(running)}>{u.waiting?'Ожидаем завершения агентов':hot?'Обновить интерфейс':running?'Установить после завершения задач':'Установить и перезапустить'}</button>}
      {compiling&&<button className="btn" disabled={disabled} onClick={()=>void updates.cancel()}>Отменить сборку</button>}
      {u.waiting&&<button className="btn" onClick={()=>updates.stopWaiting()}>Отменить ожидание</button>}
      {(stage==='error'||stage==='ready')&&<button className="btn" disabled={disabled} onClick={()=>void updates.clear()}>Очистить сборку</button>}
    </div>
    {u.release?.available&&<p className={`update-kind ${hot?'hot':''}`}>{hot?'Обновление интерфейса без остановки агентов':'Обновление нативной части — требуется локальная сборка'}</p>}
    {u.release?.available&&!hot&&<p className="muted">На этом компьютере нужны Node.js/npm, Rust/Cargo и зависимости Tauri для вашей ОС. Сборка выполняется в отдельной папке; установка ждёт завершения агентов.</p>}
    {!hot&&stage&&(stage!=='ready'||built)&&stages[stage]&&<p role="status">{stages[stage]}</p>}
    {!hot&&compiling&&<progress aria-label="Сборка обновления" />}
    {!hot&&u.status?.build.elapsedSeconds!==undefined&&<p className="muted">Время сборки: {Math.floor(u.status.build.elapsedSeconds/60)} мин {u.status.build.elapsedSeconds%60} с. {compiling?'Можно продолжать работу в чатах.':''}</p>}
    {!hot&&u.status?.build.logPath&&<details><summary>Журнал сборки{u.status.build.logBytes?` · ${Math.ceil(u.status.build.logBytes/1024)} КБ`:''}</summary><p style={{overflowWrap:'anywhere'}}>{u.status.build.logPath}</p></details>}
    {!hot&&stage==='error'&&<p className="muted">Обновление не установлено; чаты и настройки сохранены. После устранения причины нажмите «Повторить сборку».</p>}
    {!hot&&u.status?.build.error&&<p role="alert">{u.status.build.error}</p>}
    {u.status?.hot.lastError&&<p role="alert">{u.status.hot.lastError}</p>}
    {u.status?.installation?.error&&<p role="alert">{u.status.installation.error}</p>}
    {u.release?.notes&&<p>{u.release.notes}</p>}
    {u.error&&<p role="alert">{u.error}</p>}{u.notice&&<p role="status">{u.notice}</p>}
    <h2>Резервные копии</h2>
    <button className="btn" disabled={disabled||running} onClick={()=>void maintain('backup')}>Создать резервную копию</button>
    <SettingField label="Копия"><select value={selected} onChange={e=>setSelected(e.target.value)} disabled={disabled}><option value="">Выберите копию</option>{backups.map(b=><option key={b.id} value={b.id}>{new Date(Number(b.id.slice(7))).toLocaleString()} · {b.version}</option>)}</select></SettingField>
    <button className="btn" disabled={disabled||running||!selected} onClick={()=>void maintain('restore')}>Восстановить и перезапустить</button>
    {notice&&<p role="status">{notice}</p>}
  </section>;
}
