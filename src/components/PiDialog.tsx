// A blocking dialog requested by an agent extension (runtime `dialog.asked`).
//
// The agent waits until this is answered, so the dialog is deliberately modal
// and offers no "remember this" shortcut: there is no hidden blanket approval in
// this path. Dismissing it answers `cancelled`, which the extension receives as
// "no". An unanswered dialog is cancelled by the runtime at its deadline —
// silence is a denial, never an approval. The dialog leaves the screen only
// when the runtime reports it replied or expired (any attached client may answer).

import { useEffect, useRef, useState } from "react";
import { store, useAppSelector } from "../state/store";
import type { AppState } from "../state/types";
import {VoiceInput} from './VoiceInput';
import {questionInputKey} from './QuestionAnswerInput';

// Always mounted: re-render only when the dialog itself changes.
const dialogSnapshot = (s: AppState) => ({ dialog: s.ui.agentDialog,
  value: s.ui.agentDialog ? s.prefs.drafts[questionInputKey('dialog:'+s.ui.agentDialog.id, 0)] ?? s.ui.agentDialog.prefill ?? '' : '' });

export function PiDialog() {
  const { dialog, value } = useAppSelector(dialogSnapshot);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const first = useRef<HTMLButtonElement | null>(null);
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (dialog) {
      const key = questionInputKey('dialog:'+dialog.id,0);
      if (store.state.prefs.drafts[key] === undefined) store.setInputDraft(key, dialog.prefill ?? '');
    }
    setSending(false);
    setRecording(false);
    (field.current ?? first.current)?.focus();
  }, [dialog?.id]);

  if (!dialog) return null;
  const inputKey = questionInputKey('dialog:'+dialog.id, 0);
  const setValue = (text:string) => store.setInputDraft(inputKey, text);
  const answer = (reply: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
    if (sending || recording) return;
    setSending(true);
    void store.answerAgentDialog(reply, dialog.id).catch(() => {}).finally(() => setSending(false));
  };
  const cancel = () => answer({ cancelled: true });
  const title = dialog.title || "Запрос расширения";
  const deadline = new Date(dialog.deadline).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="dialog-backdrop" role="presentation" onKeyDown={(e) => { if (e.key === "Escape") cancel(); }}>
      <div className="dialog pi-dialog" role="alertdialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <button className="btn" onClick={() => void store.stopSession(dialog.sessionID)}>Остановить задачу</button>
        <p className="dialog-description">
          Запрос расширения в чате. Пока вы не ответите, агент ждёт; без ответа до {deadline} запрос будет отклонён.
        </p>
        {dialog.message && <p>{dialog.message}</p>}

        {dialog.method === "select" && (
          <div className="btn-row pi-dialog-options">
            {(dialog.options ?? []).map((option, index) => (
              <button key={option} ref={index === 0 ? first : undefined} className="btn" disabled={sending} onClick={() => answer({ value: option })}>
                {option}
              </button>
            ))}
          </div>
        )}

        {(dialog.method === "input" || dialog.method === "editor") && (
          <div className="dialog-text-input">
            {dialog.method === "editor" ? (
              <textarea ref={(node) => { field.current = node; }} aria-label={title} rows={8} value={value} onChange={(e) => setValue(e.target.value)} />
            ) : (
              <input ref={(node) => { field.current = node; }} aria-label={title} placeholder={dialog.placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
            )}
            <VoiceInput key={dialog.id} draftTarget={inputKey} disabled={sending} onActiveChange={setRecording}/>
          </div>
        )}

        <div className="btn-row">
          <button className="btn" disabled={sending || recording} onClick={cancel}>Отклонить</button>
          {dialog.method === "confirm" && (
            <button ref={first} className="btn primary" disabled={sending} onClick={() => answer({ confirmed: true })}>Разрешить</button>
          )}
          {(dialog.method === "input" || dialog.method === "editor") && (
            <button className="btn primary" disabled={sending || recording} onClick={() => answer({ value })}>Отправить</button>
          )}
        </div>
      </div>
    </div>
  );
}
