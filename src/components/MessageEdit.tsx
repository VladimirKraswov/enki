import {useMemo,useState} from 'react';
import type {UserMessage} from '../api/types';
import type {AppState} from '../state/types';
import {store, useAppSelector} from '../state/store';
import {Icon} from './Icon';

/** Edit a sent message = continue in a runtime fork before it (POST /sessions/:id/fork).
 * Hidden only for read-only imported archives, which continue through their own path. */
export function MessageEdit({message,text}:{message:UserMessage;text:string}) {
 // Per visible user message: subscribe to its own facts, not to every streamed delta.
 const select=useMemo(()=>(s:AppState)=>{const slot=s.chat.sessions[message.sessionID];
  return {running:store.isRunning(message.sessionID),attachments:(slot?.partsByMessage[message.id]??[]).some(id=>slot?.parts[id]?.type==='file')};},[message.sessionID,message.id]);
 const {running,attachments}=useAppSelector(select);
 const [open,setOpen]=useState(false),[draft,setDraft]=useState(text),[busy,setBusy]=useState(false),[error,setError]=useState('');
 if(store.isLegacySession(message.sessionID)) return null;
 if(!open)return <button className="message-action" aria-label="Редактировать сообщение" title={attachments?'Сообщение с вложениями: отправьте уточнение новым сообщением':'Редактировать сообщение'} disabled={running||attachments} onClick={()=>{setDraft(text);setOpen(true);}}><Icon name="edit" size={15}/></button>;
 return <div className="message-editor" role="group" aria-label="Редактирование сообщения">
  <textarea autoFocus aria-label="Исправленное сообщение" value={draft} disabled={busy} onChange={e=>setDraft(e.target.value)} rows={5}/>
  <p>Продолжение начнётся в новой ветке с историей до этого сообщения. Исходный диалог сохранится. Изменения в файлах не откатываются.</p>
  {error&&<div role="alert" className="msg-error">{error}</div>}
  <div className="btn-row"><button className="btn small ghost" disabled={busy} onClick={()=>setOpen(false)}>Отмена</button>
   <button className="btn small primary" disabled={busy||!draft.trim()} onClick={async()=>{setBusy(true);setError('');try{await store.prepareEditedBranch(message.id,draft);setOpen(false);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}}>{busy?'Создание ветки…':'Продолжить в новой ветке'}</button></div>
 </div>;
}
