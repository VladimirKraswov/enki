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
  const [prerequisites,setPrerequisites]=useState<{available:boolean;reason?:string}|null>(null);
  const [busy,setBusy]=useState(''),[notice,setNotice]=useState('');
  const [backups,setBackups]=useState<{id:string;version:string}[]>([]),[selected,setSelected]=useState('');
  const call=<T,>(action:string,extra:Record<string,unknown>={})=>invoke<T>('app_update',{action,channel:null,data:null,backupId:null,...extra});
  const refresh=()=>call<typeof backups>('backups').then(setBackups);
  useEffect(()=>{void invoke<{available:boolean;reason?:string}>('hub_update',{action:'prerequisites',channel:null,data:null,digest:null}).then(setPrerequisites).catch(()=>setPrerequisites({available:false,reason:'Не удалось проверить инструменты сборки.'}));void refresh().catch(e=>setNotice(String(e)));void updates.refresh().catch(()=>{});},[]);
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
  const releaseDescription=hot?'Обновление интерфейса без остановки агентов'
    :u.release?.binary?.state==='ready'?'Готовое приложение с GitHub. Скачайте пакет, затем обновите и перезапустите Enki.'
    :[u.release?.version?`Enki ${u.release.version}.`:'',u.release?.binary?.message??'Проверяем готовность установщика.',
      u.release?.binary?.state==='pending'?'Уведомление появится, когда установщик будет готов.':''].filter(Boolean).join(' ');
  return <section className="setting-group quality-settings"><h2>Enki {u.status?.hot.uiVersion??version}</h2>
    {u.status&&u.status.nativeVersion!==u.status.hot.uiVersion&&<p className="muted">Нативная версия {u.status.nativeVersion}</p>}
    <SettingField label="Канал"><select value={u.channel} disabled={disabled||u.waiting||compiling} onChange={e=>{const channel=e.target.value==='preview'?'preview':'stable';updates.setChannel(channel);localStorage.setItem('arvela.update.channel',channel);}}><option value="stable">Стабильный</option><option value="preview">Предварительный</option></select></SettingField>
    <div className="btn-row"><button className="btn" disabled={disabled||compiling||u.waiting} onClick={()=>void updates.check()}>{u.busy==='check'?'Проверяю…':'Проверить обновления'}</button>
      {u.release?.available&&!compiling&&!built&&(hot?!u.downloaded:u.release.binary?.state==='ready')&&<button className="btn primary" disabled={disabled} onClick={()=>void updates.download()}>{u.busy==='download'?'Загрузка…':`Скачать ${u.release.version}`}</button>}
      {(hot&&u.downloaded||built)&&<button className="btn primary" disabled={disabled||u.waiting} onClick={()=>void updates.install(running)}>{u.waiting?'Ожидаем завершения агентов':hot?'Обновить интерфейс':running?'Установить после завершения задач':'Установить и перезапустить'}</button>}
      {compiling&&<button className="btn" disabled={disabled} onClick={()=>void updates.cancel()}>Отменить подготовку</button>}
      {u.waiting&&<button className="btn" onClick={()=>updates.stopWaiting()}>Отменить ожидание</button>}
      {(stage==='error'||stage==='ready')&&<button className="btn" disabled={disabled} onClick={()=>void updates.clear()}>Очистить подготовленные файлы</button>}
    </div>
    {u.release?.available&&<p className={`update-kind ${hot?'hot':''}`}>{releaseDescription}</p>}
    {u.release?.available&&!hot&&!built&&!compiling&&<details><summary>Собрать из исходников</summary>
      <p className="muted">Дополнительный вариант, если хотите установить выпуск до готовности пакета. Сборка занимает время и выполняется в отдельной папке. Чаты остаются доступны.</p>
      {prerequisites?.available?<button className="btn" disabled={disabled} onClick={()=>void updates.build()}>{u.busy==='build'?'Подготавливаю исходники…':'Собрать на этом компьютере'}</button>:<p className="muted">{prerequisites?.reason??'Проверяем Node.js/npm, Rust и системные инструменты…'}</p>}
    </details>}
    {!hot&&stage&&(stage!=='ready'||built)&&stages[stage]&&<p role="status">{stages[stage]}</p>}
    {!hot&&compiling&&<progress aria-label="Подготовка обновления" max={u.status?.build.totalBytes} value={u.status?.build.totalBytes?u.status.build.receivedBytes:undefined} />}
    {!hot&&u.status?.build.elapsedSeconds!==undefined&&<p className="muted">Время подготовки: {Math.floor(u.status.build.elapsedSeconds/60)} мин {u.status.build.elapsedSeconds%60} с. {compiling?'Можно продолжать работу в чатах.':''}</p>}
    {!hot&&u.status?.build.mode==='source'&&u.status.build.cache&&<p className="muted">{u.status.build.cache.state==='active'?`Кэш Hub: использовано ${u.status.build.cache.hits??0} библиотек, сохранено ${u.status.build.cache.writes??0}.`:u.status.build.cache.state==='preparing'?'Подключаем кэш компилятора на Hub…':'Кэш Hub недоступен — выполняется обычная сборка.'}</p>}
    {!hot&&u.status?.build.logPath&&<details><summary>Журнал подготовки{u.status.build.logBytes?` · ${Math.ceil(u.status.build.logBytes/1024)} КБ`:''}</summary><p style={{overflowWrap:'anywhere'}}>{u.status.build.logPath}</p></details>}
    {!hot&&stage==='error'&&<p className="muted">Обновление не установлено; чаты и настройки сохранены. Можно повторить загрузку или сборку.</p>}
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
