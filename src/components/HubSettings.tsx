import { SettingField } from "./SettingHelp";
import { hubOrigin } from "../hub/identity";
import { useEffect, useRef, useState } from "react";
import { config, drain, emptyConfig, install, request, spool, type HubConfig, type HubItem, type Spool } from "../hub/client";
import { assessmentIndex, attachAssessment } from "../outcomes/sharing";
import { record } from "../hub/records";
import { usageSources } from "../usage/sources";
import { store } from "../state/store";
import { openUrl } from "@tauri-apps/plugin-opener";
export function HubSettings({onDirtyChange}:{onDirtyChange?:(v:boolean)=>void}){
 const [value,setValue]=useState<HubConfig>(emptyConfig),[saved,setSaved]=useState<HubConfig>(emptyConfig);
 const [items,setItems]=useState<HubItem[]>([]),[status,setStatus]=useState<Spool|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState(""),[error,setError]=useState(""),[ready,setReady]=useState(false);
 const cancel=useRef<AbortController|null>(null),mounted=useRef(true);
 const dirty=ready&&(JSON.stringify(value)!==JSON.stringify(saved));
 useEffect(()=>{mounted.current=true;void config().then(c=>{if(mounted.current){setValue(c);setSaved(c);setReady(true);}}).catch(e=>setError(String(e)));return()=>{mounted.current=false;cancel.current?.abort();};},[]);
 useEffect(()=>{onDirtyChange?.(dirty);return()=>onDirtyChange?.(false);},[dirty,onDirtyChange]);
 const run=async(fn:()=>Promise<void>)=>{setBusy(true);setError("");setNotice("");try{await fn();}catch(e){if(mounted.current)setError(String(e));}finally{if(mounted.current)setBusy(false);}};
 async function refresh(){const d=await request<{items:HubItem[]}>("catalog");if(mounted.current){setItems(d.items);setStatus(await spool("read"));}}
 async function backfill(){const controller=new AbortController();cancel.current=controller;let count=0,failures=0;
  try{const origin=await hubOrigin(saved),assessments=await assessmentIndex(),server=store.state.prefs.workspaceKey??store.state.prefs.endpoint;for(const source of usageSources()){
   const sessions=(await source.sessions(controller.signal)).filter(s=>s.time.updated>Date.now()-30*86400000).slice(0,500);
   for(const session of sessions){controller.signal.throwIfAborted();let before:string|undefined;const seen=new Set<string>();
    try{for(let page=0;page<20;page++){controller.signal.throwIfAborted();const d=await source.messages(session,before,controller.signal),batch=d.messages.map(m=>attachAssessment(record(source.engine==="Pi"?"pi":"opencode",session,m.info,m.parts,saved.shareText),assessments,server,session.directory??"",saved.shareText)).filter(x=>x!==null);
     for(let i=0;i<batch.length;i+=50)await spool("enqueue",batch.slice(i,i+50),undefined,origin);
     for(let i=0;i<Math.ceil(batch.length/20);i++)await drain();count+=batch.length;if(mounted.current)setNotice(`Обработано сообщений: ${count}; ошибок чтения: ${failures}`);
     if(!d.before||seen.has(d.before))break;before=d.before;seen.add(before);
    }}catch(e){if(controller.signal.aborted)throw e;failures++;}
   }
  }if(mounted.current){const queued=await spool("read");setStatus(queued);setNotice(`Обработано ${count} сообщений; ${failures} сессий с ошибкой; в очереди: ${queued.pending}. Предел: 500 сессий / 20 страниц на агент.`);}
  }finally{cancel.current=null;}
 }
 return <div className="hub-settings">
 <section className="settings-group"><h2>Подключение</h2><div className="settings-card hub-card">
 <SettingField label="Адрес сервиса HTTPS"><input aria-label="Адрес библиотеки" placeholder="https://enki-hub.local:8443" value={value.endpoint} onChange={e=>setValue({...value,endpoint:e.target.value})}/></SettingField>
 <SettingField label="Публичный сертификат PEM"><textarea aria-label="Сертификат библиотеки" spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" value={value.certificate} onChange={e=>setValue({...value,certificate:e.target.value})}/></SettingField>
 <p className="settings-muted">Импортируйте публичный сертификат сервиса.</p>
 <p className="settings-muted">Локальная сеть: ключи, регистрация и вход не требуются. Доступ ограничен адресами LAN на Hub.</p>
 <SettingField label="Подключить библиотеку и передавать метрики" className="hub-toggle"><input type="checkbox" checked={value.enabled} onChange={e=>setValue({...value,enabled:e.target.checked})}/></SettingField>
 <SettingField label="Передавать тексты запросов и итоговых ответов" className="hub-toggle"><input type="checkbox" checked={value.shareText} onChange={e=>setValue({...value,shareText:e.target.checked})}/></SettingField>
 <p className="settings-muted">Тексты запросов и ответов передаются в Hub. Файлы и скриншоты — нет. Не отправляйте секреты.</p>
 <div className="settings-actions"><button className="btn" disabled={!dirty||busy} onClick={()=>{setValue(saved);}}>Отменить</button><button className="btn primary" disabled={!ready||busy||!dirty} onClick={()=>void run(async()=>{const c=await config(value,undefined,saved);setValue(c);setSaved(c);if(c.enabled){const me=await request<{name:string}>("me");await refresh();setNotice(`Подключено: ${me.name}`);}else setNotice("Передача отключена.");})}>Сохранить и проверить</button></div>
 </div></section>
 <section className="settings-group"><h2>Библиотека</h2><div className="settings-actions"><button className="btn" disabled={!saved.enabled||dirty||busy} onClick={()=>void run(refresh)}>Обновить каталог</button><button className="btn" disabled={!saved.endpoint||dirty} onClick={()=>void run(()=>openUrl(saved.endpoint+"/remote"))}>Открыть Web UI</button></div>
 {!items.length&&<p className="settings-muted">Каталог пуст.</p>}
 {items.filter(x=>x.enabled).map(item=><article className="capability-skill" key={item.id}><div className="capability-item"><div><strong>{item.title}</strong><p>{item.description}</p><small>{item.kind} · {item.revision.slice(0,12)} {saved.installed[item.id]===item.revision?"· установлено":""}</small></div><button className="btn" disabled={busy||dirty} onClick={()=>void run(async()=>{const pkg=await install(item,false,await hubOrigin(saved));const c=await config();setSaved(c);setValue(c);setNotice(`Пакет сохранён: ${pkg.path}. Навыки доступны обоим агентам при следующей отправке.`);})}>Скачать / применить</button></div>
 {(item.kind==="prompt"||item.kind==="runbook")&&<button className="btn" disabled={busy||dirty} onClick={()=>void run(async()=>{const pkg=await install(item,false,await hubOrigin(saved)),text=Object.values(pkg.manifest.files).join("\n\n");store.setDraft([store.getDraft(),text].filter(Boolean).join("\n\n"));setNotice("Добавлено в черновик текущего чата. Сообщение не отправлено.");})}>Добавить в черновик</button>}</article>)}
 </section><section className="settings-group"><h2>Передача истории</h2>
 <div className="settings-actions"><button className="btn" disabled={!saved.enabled||dirty||busy} onClick={()=>void run(async()=>setStatus(await drain()))}>Передать очередь</button><button className="btn" disabled={!saved.enabled||dirty||busy} onClick={()=>void run(backfill)}>Импортировать историю за 30 дней</button>{busy&&cancel.current&&<button className="btn" onClick={()=>cancel.current?.abort()}>Остановить импорт</button>}<button className="btn" disabled={busy} onClick={()=>void run(async()=>setStatus(await spool("clear")))}>Очистить очередь</button></div>
 {status&&<p className="settings-muted">В очереди: {status.pending} · Удалено при переполнении: {status.dropped}</p>}
 </section>
 {notice&&<p role="status" className="settings-notice">{notice}</p>}{error&&<p role="alert" className="settings-error">{error}</p>}
 </div>;
}
