import { SettingField } from "./SettingHelp";
import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {store,useAppState} from '../state/store';
import {capabilityNative,invalidateCapabilities} from '../capabilities/integration';
import type {Catalog,Skill} from '../capabilities/registry';
import {captureTrial,trialPrompt,type Experiment,type Trial} from '../capabilities/quality';
import {isLocalComputer} from '../state/computer';
import {RUNTIME_AGENT_ID} from '../agent/runtime/ids';

export function SkillQualitySettings({onDirtyChange}:{onDirtyChange:(dirty:boolean)=>void}) {
  const app=useAppState(),[skills,setSkills]=useState<Skill[]>([]),[path,setPath]=useState(''),[body,setBody]=useState(''),[original,setOriginal]=useState('');
  const [items,setItems]=useState<Experiment[]>([]),[selected,setSelected]=useState(''),[scenario,setScenario]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const [scope,setScope]=useState('global'),directory=scope==='project'?app.directory:null;
  const running=Object.values({...app.statuses,...app.activityStatuses}).some(s=>s.type!=='idle')||app.ui.sending;
  const local=isLocalComputer(app.prefs.endpoint,!!store.currentHost());
  const current=items.find(e=>e.id===selected);
  const call=<T,>(action:string,extra:Record<string,unknown>={})=>invoke<T>('skill_quality',{request:{action,scope,directory,path:null,body:null,experimentId:null,trial:null,...extra}});
  useEffect(()=>{onDirtyChange(body!==original);return()=>onDirtyChange(false);},[body,original,onDirtyChange]);
  useEffect(()=>{
    let active=true;if(!local){setSkills([]);setNotice('Испытания навыков доступны на этом компьютере.');return;}setPath('');setBody('');setOriginal('');setSelected('');setNotice('');
    void Promise.all([capabilityNative<Catalog>('shared_catalog',{scope,directory}),call<Experiment[]>('list')]).then(([catalog,list])=>{if(active){/* skills the bundled runtime can load (native reports engines:["pi"]) */setSkills(catalog.skills.filter(s=>s.engines.includes(RUNTIME_AGENT_ID)));setItems(list);}},e=>{if(active)setNotice(String(e));});
    return()=>{active=false;};
  },[scope,directory,local]);
  const run=async(fn:()=>Promise<void>)=>{setBusy(true);setNotice('');try{await fn();}catch(e){setNotice(String(e));}finally{setBusy(false);}};
  const replace=(e:Experiment)=>{setItems(old=>[e,...old.filter(x=>x.id!==e.id)]);setSelected(e.id);};
  // A confirmed skill change on this computer: the runtime reopens idle chats of the
  // scope and marks busy ones (no abort, no replay); null when not applicable.
  const committed=async(done:string)=>{invalidateCapabilities();const refreshed=await store.capabilitiesCommitted(directory).catch(()=>null);
    setNotice(refreshed?`${done} Свободные открытые чаты получили его сразу${refreshed.pending?`; занятые (${refreshed.pending}) — после завершения текущей работы`:''}.`:`${done} Новые чаты получат его сразу, открытые — после переоткрытия.`);};
  const record=(passed:boolean)=>run(async()=>{
    const id=app.activeSessionId,chat=id?app.chat.sessions[id]:undefined;
    if(!current||!chat)throw Error('Откройте завершённый чат испытания.');
    replace(await call<Experiment>('record',{experimentId:current.id,trial:captureTrial(current,chat,store.engineIdFor(),passed)}));
    setNotice('Результат записан из истории чата.');
  });
  const prepare=(phase:Trial['phase'])=>run(async()=>{
    if(!current||!scenario.trim()||scenario.trim().length>160)throw Error('Введите короткий проверяемый сценарий (до 160 символов).');
    if(!app.directory)throw Error('Сначала выберите проект для испытания.');
    const created=await store.createSessionNow(`Испытание: ${current.name}`);
    if(!created||store.getSnapshot().activeSessionId!==created.id)throw Error('Не удалось открыть новый чат.');
    store.setDraft(trialPrompt(current,phase,scenario));store.setUi({settingsOpen:false});
  });
  return <section className="setting-group quality-settings">
    <div className="btn-row"><select aria-label="Область испытаний" value={scope} disabled={busy||body!==original} onChange={e=>setScope(e.target.value)}><option value="global">Общие навыки</option><option value="project" disabled={!app.directory}>Навыки проекта</option></select></div>
    <SettingField label="Навык"><select aria-label="Навык" value={path} disabled={busy||!local} onChange={e=>{const p=e.target.value;setPath(p);void run(async()=>{const r=await call<{body:string}>('read',{path:p});setBody(r.body);setOriginal(r.body);});}}><option value="">Выберите навык</option>{skills.map(s=><option key={s.path} value={s.path}>{s.name}</option>)}</select></SettingField>
    {body&&<><SettingField label="Новая версия SKILL.md"><textarea rows={12} value={body} spellCheck={false} onChange={e=>setBody(e.target.value)}/></SettingField><button className="btn" disabled={busy||body===original} onClick={()=>void run(async()=>{replace(await call<Experiment>('create',{path,body}));setOriginal(body);setNotice('Кандидат сохранён отдельно. Действующий навык не изменён.');})}>Создать кандидата</button></>}
    <h2>Испытания</h2><select aria-label="Эксперимент" value={selected} disabled={busy} onChange={e=>setSelected(e.target.value)}><option value="">Выберите эксперимент</option>{items.map(e=><option key={e.id} value={e.id}>{e.name} · {e.state==='candidate'?'Кандидат':e.state==='promoted'?'Применён':e.state==='rolledBack'?'Откачен':'Нужно завершить операцию'}</option>)}</select>
    {current&&<><p className="muted">Три парных сценария (исходный и кандидат) в агенте Enki. Одинаковые модель и задача; результат подтверждаете вы, время и токены берутся из чата.</p><SettingField label="Сценарий"><input maxLength={160} value={scenario} onChange={e=>setScenario(e.target.value)}/></SettingField><div className="btn-row"><button className="btn" disabled={busy||!scenario.trim()} onClick={()=>void prepare('baseline')}>Проверить исходный</button><button className="btn" disabled={busy||!scenario.trim()} onClick={()=>void prepare('candidate')}>Проверить кандидата</button></div>
      <div className="btn-row"><button className="btn" disabled={busy||running} onClick={()=>void record(true)}>Текущий чат: успешно</button><button className="btn" disabled={busy||running} onClick={()=>void record(false)}>Текущий чат: неуспешно</button></div>
      <div className="quality-table"><table><thead><tr><th>Сценарий / агент</th><th>Версия</th><th>Результат</th><th>Время</th><th>Токены</th><th>Ошибки</th></tr></thead><tbody>{current.trials.map(t=><tr key={t.sessionId+t.messageId}><td title={t.model}>{t.caseId}<small>{t.engine} · {t.model}</small></td><td>{t.phase==='baseline'?'Исходная':'Кандидат'}</td><td>{t.passed?'Успешно':'Неуспешно'}</td><td>{(t.wallMs/1000).toFixed(1)} с</td><td>{t.tokens}</td><td>{t.errors}</td></tr>)}</tbody></table></div>
      <div className="btn-row"><button className="btn primary" disabled={busy||!local||running||current.trials.filter(t=>t.phase==='candidate').length<3||!['candidate','promoting'].includes(current.state)} onClick={()=>void run(async()=>{replace(await call<Experiment>('promote',{experimentId:current.id}));await committed('Проверенная версия навыка применена.');})}>Применить проверенную версию</button><button className="btn" disabled={busy||!local||running||!['promoted','promoting','rollingBack'].includes(current.state)} onClick={()=>void run(async()=>{replace(await call<Experiment>('rollback',{experimentId:current.id}));await committed('Исходный навык восстановлен.');})}>Откатить навык</button></div></>}
    {notice&&<p role="status">{notice}</p>}
  </section>;
}
