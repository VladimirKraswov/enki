import {invoke} from '@tauri-apps/api/core';
import {isNative} from '../native/platform';
import { useEffect, useRef, useState } from 'react';
import { operationJournal, type Operation } from '../operations/journal';
import { store, useAppState } from '../state/store';
import { Icon } from './Icon';

const labels = {prepared:'Не отправлено',dispatching:'Доставка не подтверждена',uncertain:'Доставка не подтверждена',accepted:'Доставлено',refused:'Отклонено агентом',cancelled:'Отменено'};
export function RecoveryButton() {
  const s = useAppState();
  const [open, setOpen] = useState(false);
  const workspace = s.prefs.workspaceKey ?? s.prefs.endpoint;
  return <><button className="icon-btn" aria-label="Требует внимания и журнал отправок" title="Требует внимания" onClick={() => setOpen(true)}><Icon name="context" size={17}/></button>
    {open && <RecoveryCenter key={workspace} workspace={workspace} close={() => setOpen(false)}/>}</>;
}
function RecoveryCenter({workspace, close}:{workspace:string; close:()=>void}) {
  useAppState();
  const [records,setRecords] = useState<Operation[]>([]), [notice,setNotice] = useState(''), [busy,setBusy] = useState(''), [all,setAll] = useState(false);
  const first = useRef<HTMLButtonElement>(null), dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const prior=document.activeElement as HTMLElement|null;dialog.current?.showModal();return()=>{dialog.current?.close();prior?.isConnected&&prior.focus();};},[]);
  const [quit,setQuit]=useState<{sessionId:string;directory:string;endpoint:string}[]>([]);
  useEffect(()=>{let active=true;if(isNative())void invoke<typeof quit>('quit_report').then(r=>{if(active)setQuit(r);},e=>{if(active)setNotice(String(e));});return()=>{active=false;};},[]);
  useEffect(() => {
    let active = true, revision=0;
    const refresh = () => {const current=++revision;void operationJournal.list(workspace).then(rows=>{if(active&&current===revision)setRecords(rows);},error=>{if(active)setNotice(String(error));});};
    refresh(); const stop=operationJournal.subscribe(refresh); first.current?.focus();
    return()=>{active=false;stop();};
  },[workspace]);
  const issues = store.attentionItems();
  const run = async (id:string, fn:()=>Promise<string|void>) => {setBusy(id);try{setNotice(await fn() ?? 'Готово');}catch(error){setNotice(String(error));}finally{setBusy('');}};
  const shown = records.filter(r=>all||['prepared','dispatching','uncertain','refused'].includes(r.state));
  return <dialog ref={dialog} className="dialog recovery-center recovery-modal" onCancel={e=>{e.preventDefault();close();}} aria-label="Требует внимания">
      <div className="context-panel-header"><h2>Требует внимания</h2><button ref={first} className="icon-btn" aria-label="Закрыть журнал" onClick={close}><Icon name="close"/></button></div>
      <div className="recovery-scroll">
        {quit.filter(q=>q.endpoint===store.state.prefs.endpoint).map(q=><article key={q.sessionId}><b>Остановка не подтверждена</b><p>При закрытии приложения агент не ответил. Проверьте состояние чата.</p><button className="btn small" disabled={!!busy} onClick={()=>void run(q.sessionId,async()=>{await store.openAttentionChat(q.sessionId,q.directory);close();})}>Открыть чат</button></article>)}
        {!issues.length&&<p className="muted">Нет ожидающих ответов и ошибок в загруженных чатах.</p>}
        {issues.map(item=><article key={item.id}><b>{item.title}</b><p>{item.reason}</p><button className="btn small" disabled={!!busy} onClick={()=>void run(item.id,async()=>{await store.openAttentionChat(item.id,item.directory);close();})}>Открыть чат</button></article>)}
        {store.cutoverIssues().length>0&&<div className="context-panel-header"><h3>Перенос из прежней версии</h3></div>}
        {store.cutoverIssues().map(item=><article key={item.id}>
          <b>{item.kind==='queue'?'Запрос очереди не перенесён':'Таймер не перенесён'}</b>
          <p>{item.state==='received'?'Перенос ещё не завершён; содержимое сохранено.':item.reason ?? 'Нужна ваша проверка.'} Ничего не отправлялось.</p>
          <div className="btn-row">
            {item.retryable&&<button className="btn small" disabled={!!busy} onClick={()=>void run(item.id,()=>store.retryCutover(item.id))}>Повторить перенос</button>}
            {item.state==='quarantined'&&<button className="btn small" disabled={!!busy} title="Сохранённая копия останется в журнале среды выполнения" onClick={()=>void run(item.id,()=>store.resolveCutover(item.id))}>Больше не переносить</button>}
          </div>
        </article>)}
        <div className="context-panel-header"><h3>Журнал отправок</h3><label><input type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/> Все</label></div>
        {!shown.length&&<p className="muted">Нет отправок для проверки.</p>}
        {shown.map(record=><article key={record.id}>
          <div className="recovery-title"><b>{labels[record.state]}</b><time>{new Date(record.updatedAt).toLocaleString()}</time></div>
          <p className="recovery-preview" title={record.text}>{record.text||'Вложения'}</p>
          <small>{record.engine} · {record.model}{record.attachments ? ` · Файлов: ${record.attachments.files.length}` : ''}</small>
          <div className="btn-row">
            <button className="btn small" disabled={!!busy} onClick={()=>void run(record.id,async()=>{await store.openAttentionChat(record.sessionId,record.directory);close();})}>Открыть чат</button>
            {['dispatching','uncertain'].includes(record.state)&&<button className="btn small" disabled={!!busy} onClick={()=>void run(record.id,()=>store.reconcileOperation(record))}>Проверить доставку</button>}
            {['prepared','refused','cancelled'].includes(record.state)&&<button className="btn small" disabled={!!busy} onClick={()=>void run(record.id,()=>store.restoreOperationDraft(record))}>Вернуть в черновик</button>}
          </div>
        </article>)}
      </div>
      {notice&&<p role="status">{notice}</p>}
  </dialog>;
}
