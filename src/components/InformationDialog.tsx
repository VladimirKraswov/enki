import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {Session} from '../api/types';
import {store,useAppState} from '../state/store';
import {sessionOf} from '../agent/runtime/backend';
import {formatBytes,informationTotals,projectSessionIndex,type InformationRow} from '../storage/information';
import {CopyButton} from './CopyButton';
import {pathBasename} from '../util/paths';

export function InformationDialog({directory,session,onClose}:{directory:string;session?:Session;onClose:()=>void}){
 const state=useAppState(),scope=JSON.stringify([state.prefs.endpoint,state.prefs.activeHost,state.prefs.workspaceKey]);
 const original=useRef(scope),dialog=useRef<HTMLDialogElement>(null),focus=useRef(document.activeElement as HTMLElement|null);
 const [rows,setRows]=useState<InformationRow[]>([]),[errors,setErrors]=useState<string[]>([]),[loading,setLoading]=useState(true),[query,setQuery]=useState(''),[revision,setRevision]=useState(0);
 useEffect(()=>{dialog.current?.showModal();return()=>{dialog.current?.close();if(focus.current?.isConnected)focus.current.focus();};},[]);
 useEffect(()=>{if(scope!==original.current)onClose();},[scope,onClose]);
 useEffect(()=>{
  const controller=new AbortController(),backend=store.maybeBackend();let active=true;
  setRows([]);setErrors([]);setLoading(true);
  void (async()=>{
   const warnings:string[]=[];const result:InformationRow[]=[];
   try{
    if(!backend)throw new Error('offline');
    // One runtime catalogue: Enki chats and read-only OpenCode archives (active + archived).
    const sessions=session?[session]:await projectSessionIndex(directory,controller.signal,(archived,cursor,signal,dir)=>
     backend.client.recentSessions({archived,cursor,limit:100,directory:dir},signal).then(page=>({sessions:page.sessions.map(sessionOf),cursor:page.cursor})));
    result.push(...sessions.map(item=>({session:item,engine:item.origin?.kind==='opencode'?'OpenCode' as const:'Pi' as const})));
    // The runtime does not report per-chat storage sizes; they are shown as unavailable, never guessed.
   }catch{warnings.push('Не удалось получить список чатов от среды выполнения Enki.');}
   if(active&&!controller.signal.aborted){
    if(backend!==store.maybeBackend()){setErrors(['Подключение изменилось. Обновите сведения.']);setLoading(false);return;}
    setRows(result.sort((a,b)=>b.session.time.updated-a.session.time.updated));setErrors(warnings);setLoading(false);
   }
  })();return()=>{active=false;controller.abort();};
 },[directory,session,scope,revision]);
 if(scope!==original.current)return null;
 const totals=informationTotals(rows),filtered=rows.filter(row=>row.session.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
 const date=(value:number)=>new Date(value).toLocaleString('ru');
 return createPortal(<dialog ref={dialog} className="information-dialog" aria-label={session?'Сведения о сессии':'Сведения о проекте'} onCancel={event=>{event.preventDefault();onClose();}}>
  <header><h3>{session?'Сведения о сессии':'Сведения о проекте'}</h3><button className="btn small" onClick={onClose}>Закрыть</button></header>
  <div className="information-body"><h4>{session?.title??pathBasename(directory)}</h4>
   <div className="information-path"><span>{directory}</span><CopyButton text={directory} label="Копировать путь проекта" compact/></div>
   {!session&&<div className="information-summary"><span>Сессии: <b>{rows.length}</b></span><span>Данные чатов: <b>{loading?'…':totals.known?formatBytes(totals.bytes):'Недоступно'}</b>{totals.known<totals.total&&totals.known>0&&` (${totals.known} из ${totals.total})`}</span><span>В архиве: {rows.filter(r=>r.session.time.archived).length}</span></div>}
   {loading&&<p role="status">Загрузка сведений…</p>}
   {errors.map(error=><p key={error} role="alert" className="error-text">{error}</p>)}
   {!loading&&<button className="btn small" onClick={()=>setRevision(v=>v+1)}>Обновить</button>}
   {rows.some(row=>row.storage?.kind==='payload')&&<p className="information-note">OpenCode: размер записей сообщений и частей в общей базе, без индексов и свободного места. Pi: размер файла истории. Внешние вложения и файлы проекта не учитываются.</p>}
   {!session&&<input type="search" aria-label="Найти сессию" placeholder="Найти сессию" value={query} onChange={event=>setQuery(event.target.value)}/>}
   {!loading&&!filtered.length&&<p>Сессий не найдено.</p>}
   <div className="information-list">{filtered.map(row=><section key={`${row.engine}:${row.session.id}`}><h4>{row.session.title}</h4>
    <div className="information-summary"><span>{row.engine==='OpenCode'?'Архив OpenCode (только чтение)':'Enki'}{row.session.agent?` · ${row.session.agent}`:''}</span><b>{row.storage?formatBytes(row.storage.bytes):'Размер недоступен'}</b><span>{row.session.time.archived?'Архив':'Не в архиве'}</span></div>
    <dl><dt>Создана</dt><dd>{date(row.session.time.created)}</dd><dt>Изменена</dt><dd>{date(row.session.time.updated)}</dd>
    {row.storage?.messages!==undefined&&<><dt>Сообщений</dt><dd>{row.storage.messages}</dd></>}
    {row.session.model&&<><dt>Модель</dt><dd>{row.session.model.id}</dd></>}
    {row.session.tokens&&<><dt>Токены</dt><dd>Вход: {(row.session.tokens.input??0).toLocaleString('ru')} · Выход: {(row.session.tokens.output??0).toLocaleString('ru')} · Рассуждения: {(row.session.tokens.reasoning??0).toLocaleString('ru')}</dd></>}
    {row.session.parentID&&<><dt>Родительская сессия</dt><dd>{row.session.parentID}</dd></>}
    <dt>ID</dt><dd className="information-path"><span>{row.session.id}</span><CopyButton text={row.session.id} label="Копировать ID сессии" compact/></dd>
    {row.storage&&<><dt>{row.storage.kind==='file'?'Файл истории':'Общая база'}</dt><dd className="information-path"><span>{row.storage.path}</span><CopyButton text={row.storage.path} label="Копировать путь истории" compact/></dd></>}
    </dl>
   </section>)}</div>
  </div>
 </dialog>,document.body);
}
