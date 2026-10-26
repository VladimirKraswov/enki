import {useRef, useState} from 'react';
import {VoiceInput} from './VoiceInput';
import {Icon} from './Icon';
import {openFileInput} from '../attachments/composerBridge';
import {LARGE_PASTE_THRESHOLD, pastedTextFile} from '../attachments/prepare';

export const questionInputKey = (id: string, index: number) => JSON.stringify(['question-answer', id, index]);

/** The same microphone and file preparation as the prompt, with a separate
 * durable dictation target so recognition can never land in another input. */
export function QuestionAnswerInput({id, index, value, disabled, onChange, onFiles, onActiveChange}: {
  id: string; index: number; value: string; disabled: boolean;
  onChange(value: string): void; onFiles(files: File[]): void; onActiveChange(active: boolean): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);
  return <div className={`question-answer-input${active ? ' question-answer-voice-active' : ''}`} data-question-input
    onDragOver={event => { if (!disabled && Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault(); }}
    onDrop={event => { if (disabled) return; event.preventDefault(); event.stopPropagation(); onFiles(Array.from(event.dataTransfer.files)); }}>
    <textarea className="question-answer-text" placeholder="Свой ответ…" aria-label={`Свой ответ ${index + 1}`}
      value={value} disabled={disabled && !active} rows={2} onChange={event => onChange(event.target.value)}
      onPaste={event => {
        const pasted = Array.from(event.clipboardData.files);
        if (pasted.length) { event.preventDefault(); onFiles(pasted); return; }
        const text = event.clipboardData.getData('text/plain');
        if (text.length > LARGE_PASTE_THRESHOLD) { event.preventDefault(); onFiles([pastedTextFile(text)]); }
      }}/>
    <div className="question-answer-actions">
      <input ref={input} type="file" multiple hidden disabled={disabled} onChange={event => { onFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }}/>
      <button className="icon-btn" type="button" aria-label="Прикрепить файлы к ответу" title="Прикрепить файл или изображение" disabled={disabled} onClick={() => openFileInput(input.current)}><Icon name="plus" size={18}/></button>
      <span className="question-answer-hint">Можно вставить скриншот</span>
      <VoiceInput draftTarget={questionInputKey(id, index)} holdForRecovery disabled={disabled && !active} onActiveChange={value => { setActive(value); onActiveChange(value); }}/>
    </div>
  </div>;
}
