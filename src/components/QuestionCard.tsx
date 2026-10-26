import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import type {QuestionRequest} from '../api/types';
import {store, useAppState} from '../state/store';
import {attachmentDrafts, attachmentScope, MAX_ATTACHMENT_BYTES, type DraftAttachment} from '../attachments/drafts';
import {QUESTION_ANSWER_TEXT_LIMIT} from '../../src-tauri/resources/agent/src/protocol';
import {AttachmentChip} from './AttachmentChip';
import {QuestionAnswerInput, questionInputKey} from './QuestionAnswerInput';
import {isTauri} from '@tauri-apps/api/core';
import {getCurrentWebview} from '@tauri-apps/api/webview';
import {readFile, stat} from '@tauri-apps/plugin-fs';
import {filesFromNativeDrop, nativeDropTargetsQuestion} from '../attachments/native-drop';
import {openFileInput} from '../attachments/composerBridge';

export function QuestionCard({req, onReply, onReject}: {
  req: QuestionRequest;
  onReply(answers: string[][], files?: DraftAttachment[]): void | boolean | Promise<boolean>;
  onReject(): void;
}) {
  const state = useAppState(), workspace = state.prefs.workspaceKey ?? state.prefs.endpoint;
  const scope = attachmentScope(workspace, state.directory, `@question:${req.id}`);
  const files = useSyncExternalStore(attachmentDrafts.subscribe, () => attachmentDrafts.snapshot(scope));
  const picksKey = questionInputKey(req.id, -1);
  let restored: Record<number, string[]> = {};
  try { restored = JSON.parse(state.prefs.drafts[picksKey] ?? '{}'); } catch { /* corrupt draft doesn't block answering */ }
  const picks = restored && typeof restored === 'object' && !Array.isArray(restored) ? restored : {};
  const custom = (index: number) => state.prefs.drafts[questionInputKey(req.id, index)] ?? '';
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [voice, setVoice] = useState(-1);
  const fileInput = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    alive.current = true;
    void attachmentDrafts.ensure(scope).catch(e => { if (alive.current) setError(String(e)); });
    return () => { alive.current = false; };
  }, [scope]);
  const writePicks = (next: Record<number, string[]>) => store.setInputDraft(picksKey, JSON.stringify(next), workspace);
  const addFiles = (added: File[]) => {
    if (inFlight.current || !added.length) return;
    setError(''); void attachmentDrafts.add(scope, added).catch(e => { if (alive.current) setError(e instanceof Error ? e.message : String(e)); });
  };
  const addRef = useRef(addFiles); addRef.current = addFiles;
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false, stop: undefined | (() => void);
    void getCurrentWebview().onDragDropEvent(event => {
      if (event.payload.type !== 'drop' || !nativeDropTargetsQuestion(event.payload.position)) return;
      void filesFromNativeDrop(event.payload.paths, stat, readFile).then(result => { if (!disposed) addRef.current(result); })
        .catch(e => { if (!disposed) setError(String(e)); });
    }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; }).catch(e => { if (!disposed) setError(`Перетаскивание недоступно: ${String(e)}`); });
    return () => { disposed = true; stop?.(); };
  }, []);
  const canType = (q: QuestionRequest['questions'][number]) => q.custom !== false || !q.options?.length;
  const allAnswered = req.questions.every((q, index) => (Array.isArray(picks[index]) && picks[index].length > 0) ||
    (canType(q) && (custom(index).trim() || files.length > 0)));
  const submit = async () => {
    if (inFlight.current || voice >= 0 || !allAnswered) return;
    inFlight.current = true;
    setBusy(true); setError('');
    try {
      const selected = await attachmentDrafts.selected(scope, files.map(file => file.id));
      const longAnswers: DraftAttachment[] = [];
      const answers = req.questions.map((q, index) => {
        const chosen = Array.isArray(picks[index]) ? picks[index] : [];
        let text = canType(q) ? custom(index).trim() : '';
        if (text.length > QUESTION_ANSWER_TEXT_LIMIT) {
          const name = `Ответ на вопрос ${index + 1}.txt`, blob = new Blob([text], {type:'text/plain'});
          longAnswers.push({id:crypto.randomUUID(),name,mime:'text/plain',size:blob.size,blob});
          text = `Подробный ответ приложен в файле «${name}».`;
        }
        if (text) return q.multiple ? [...new Set([...chosen, text])] : [text];
        if (chosen.length) return chosen;
        return selected.length && canType(q) ? ['См. приложенные файлы.'] : [];
      });
      const outgoing = [...selected, ...longAnswers];
      if (outgoing.length > 12 || outgoing.reduce((total,file)=>total+file.size,0) > MAX_ATTACHMENT_BYTES) throw Error('Ответ превышает лимит: до 12 вложений и 50 МБ, включая длинный текст. Разделите ответ.');
      if (await onReply(answers, outgoing) === false) { if (alive.current) setError('Ответ не отправлен. Текст и файлы сохранены; повторите после устранения ошибки.'); return; }
      // Only captured input is cleared after the runtime confirms the reply.
      await attachmentDrafts.remove(scope, selected.map(file => file.id));
      req.questions.forEach((_, index) => store.setInputDraft(questionInputKey(req.id, index), '', workspace));
      store.setInputDraft(picksKey, '', workspace);
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  };
  return <div className="action-card question-card" data-question-input role="group" aria-label="Вопрос агента" aria-busy={busy}
    onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }}
    onPaste={e => { if (e.defaultPrevented) return; const pasted=Array.from(e.clipboardData.files); if (pasted.length) {e.preventDefault(); addFiles(pasted);} }}
    onDragOver={e => { if (!busy && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault(); }}
    onDrop={e => { e.preventDefault(); e.stopPropagation(); addFiles(Array.from(e.dataTransfer.files)); }}>
    <div className="caption">Агент спрашивает</div>
    {req.questions.map((q, index) => <div className="question-section" key={index}>
      <div className="question-text">{q.question}</div>
      {(q.options ?? []).map(option => <label className="opt-row" key={option.label}>
        <input type={q.multiple ? 'checkbox' : 'radio'} disabled={busy || voice >= 0} name={`${req.id}-${index}`}
          checked={(!!q.multiple || !custom(index).trim()) && Array.isArray(picks[index]) && picks[index].includes(option.label)} onChange={() => {
            const old = Array.isArray(picks[index]) ? picks[index] : [];
            writePicks({...picks, [index]: q.multiple ? old.includes(option.label) ? old.filter(v => v !== option.label) : [...old, option.label] : [option.label]});
            if (!q.multiple) store.setInputDraft(questionInputKey(req.id, index), '', workspace);
          }}/>
        <span><span className="opt-label">{option.label}</span>{option.description && <span className="opt-desc"> — {option.description}</span>}</span>
      </label>)}
      {canType(q) && <QuestionAnswerInput id={req.id} index={index} value={custom(index)} disabled={busy || (voice >= 0 && voice !== index)}
        onFiles={addFiles} onActiveChange={active => setVoice(old => active ? index : old === index ? -1 : old)}
        onChange={value => { store.setInputDraft(questionInputKey(req.id, index), value, workspace); if (!q.multiple) writePicks({...picks, [index]: []}); }}/>} 
    </div>)}
    {!!files.length && <div className="attachment-list" aria-label="Вложения ответа">{files.map(file => <AttachmentChip key={file.id} file={file} disabled={busy}
      onRemove={() => void attachmentDrafts.remove(scope, [file.id]).catch(e => setError(String(e)))}/>)}</div>}
    {error && <div className="composer-error" role="alert">{error}</div>}
    <div className="btn-row">
      {!req.questions.some(canType) && <><input ref={fileInput} type="file" multiple hidden disabled={busy} onChange={e => {addFiles(Array.from(e.target.files ?? [])); e.target.value='';}}/>
        <button className="btn small" disabled={busy} onClick={()=>openFileInput(fileInput.current)}>Прикрепить файлы</button></>}
      <button className="btn small danger" disabled={busy || voice >= 0} onClick={onReject}>Отклонить вопрос</button>
      <button className="btn small primary" disabled={busy || voice >= 0 || !allAnswered} onClick={() => void submit()}>{busy ? 'Отправка ответа…' : 'Отправить ответ'}</button>
    </div>
  </div>;
}
