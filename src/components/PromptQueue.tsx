import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { store, useAppState } from "../state/store";
import type { DraftAttachment } from "../attachments/drafts";
import { Icon } from "./Icon";

export function PromptQueue({attachments, removeFile, focusEditor, switching}: {
  attachments: DraftAttachment[]; removeFile(id: string): void; focusEditor(): void; switching: boolean;
}) {
  const s = useAppState(), queueEdit = store.getQueueEdit(), draft = store.getDraft(), connected = store.engineReady();
  const [queueFiles, setQueueFiles] = useState<string | null>(null);
  const [drag, setDrag] = useState<{id: string; before: string | null; box: {left: number; top: number; width: number; height: number}} | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const context = JSON.stringify([s.prefs.workspaceKey ?? s.prefs.endpoint, s.directory, s.activeSessionId]);
  const current = useRef(context); current.current = context;
  const gesture = useRef<{id: string; context: string; ids: string; pointer: number; startX: number; x: number; startY: number; y: number; active: boolean; before: string | null; box: {left: number; top: number; width: number; height: number}} | null>(null);
  const queue = store.getQueue();
  const disabled = !!queueEdit || s.ui.sending || store.isQueueLocked() || queue.some(item => item.state !== "ready");
  useEffect(() => { gesture.current = null; setDrag(null); setQueueFiles(null); setAnnouncement(""); }, [context]);
  const finish = (cancel = false) => {
    const g = gesture.current; gesture.current = null; setDrag(null);
    if (!cancel && g?.active && current.current === g.context && store.getQueue().map(item => item.id).join() === g.ids && store.reorderQueued(g.id, g.before))
      setAnnouncement(`Задание перемещено на позицию ${store.getQueue().findIndex(item => item.id === g.id) + 1}`);
  };
  const update = () => {
    const g = gesture.current, el = list.current;
    if (!g || !el || !g.active) return;
    const rows = [...el.querySelectorAll<HTMLElement>("[data-queue-id]")].filter(row => row.dataset.queueId !== g.id);
    const before = rows.find(row => { return g.y < el.getBoundingClientRect().top + row.offsetTop - el.scrollTop + row.offsetHeight / 2; })?.dataset.queueId ?? null;
    if (preview.current) preview.current.style.transform = `translate3d(${g.x - g.startX}px, ${g.y - g.startY}px, 0) scale(1.015)`;
    if (before !== g.before) { g.before = before; setDrag({id: g.id, before, box: g.box}); }
  };
  useEffect(() => {
    if (!drag) return;
    let frame = 0;
    const tick = () => {
      const g = gesture.current, el = list.current;
      if (g && el) { const box = el.getBoundingClientRect(); el.scrollTop += g.y < box.top + 24 ? -6 : g.y > box.bottom - 24 ? 6 : 0; update(); }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const cancel = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); finish(true); } };
    const blur = () => finish(true);
    window.addEventListener("keydown", cancel); window.addEventListener("blur", blur);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("keydown", cancel); window.removeEventListener("blur", blur); };
  }, [!!drag]);
  const pointerDown = (e: PointerEvent<HTMLButtonElement>, id: string) => {
    if (!e.isPrimary || e.button !== 0 || disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const box = e.currentTarget.closest<HTMLElement>("[data-queue-id]")!.getBoundingClientRect();
    gesture.current = {id, context, ids: queue.map(item => item.id).join(), pointer: e.pointerId, startX: e.clientX, x: e.clientX, startY: e.clientY, y: e.clientY, active: false, before: id, box: {left: box.left, top: box.top, width: box.width, height: box.height}};
  };
  const pointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const g = gesture.current; if (!g || g.pointer !== e.pointerId) return;
    g.y = e.clientY; g.x = e.clientX;
    if (!g.active && Math.abs(g.y - g.startY) >= 5) { g.active = true; setDrag({id: g.id, before: g.before, box: g.box}); }
    if (g.active) { e.preventDefault(); update(); }
  };
  const source = drag ? queue.findIndex(item => item.id === drag.id) : -1;
  const remaining = queue.filter(item => item.id !== drag?.id);
  const destination = drag?.before === null ? remaining.length : remaining.findIndex(item => item.id === drag?.before);
  const rowStyle = (index: number): CSSProperties | undefined => {
    if (!drag || source < 0 || destination < 0) return;
    let offset = 0;
    if (index === source) {
      const rows = list.current?.querySelectorAll<HTMLElement>("[data-queue-id]");
      const target = rows?.[destination], origin = rows?.[source];
      if (target && origin) offset = target.offsetTop - origin.offsetTop + (destination > source ? target.offsetHeight - drag.box.height : 0);
    } else if (source < index && index <= destination) offset = -drag.box.height;
    else if (destination <= index && index < source) offset = drag.box.height;
    return {transform: `translateY(${offset}px)`, ...(index === source ? {height: drag.box.height} : {})};
  };
  return (
        <div className={`prompt-queue ${drag ? "queue-sorting" : ""}`} aria-label="Очередь запросов">
          <div className="queue-heading">
            <b>В очереди · {store.getQueue().length}</b>
            <span>
              {store.isQueueArmed()
                ? "После текущего ответа"
                : "Приостановлена"}
            </span>
            {!store.isQueueArmed() && (
              <button disabled={!!queueEdit || s.ui.sending || !connected || store.getQueue()[0]?.state !== "ready"} onClick={() => void store.resumeQueue()}>
                Продолжить очередь
              </button>
            )}
          </div>
          {!store.isQueueArmed() && store.queueRecoveryReason() && <p className="queue-recovery" role="status">{store.queueRecoveryReason()}</p>}
          {!store.isQueueArmed() && store.queueHasDifferentModel() && <button className="queue-model-recovery" disabled={!!queueEdit || s.ui.sending || !connected || store.getQueue()[0]?.state !== "ready"} onClick={() => void store.resumeQueue(true)}>Продолжить на выбранной модели</button>}
          <div className="queued-prompts" ref={list}>
          <span className="queue-announcement" role="status" aria-live="polite">{announcement}</span>
          {queue.map((item, index) => {
            // While editing: the item's stored files that are still kept (removal only
            // marks them; Apply sends it atomically) plus the newly added draft files.
            const editing = queueEdit?.id === item.id;
            const itemFiles: { id: string; name: string; kept: boolean }[] = editing
              ? [...store.editKeptFiles().map(file => ({ id: file.id, name: file.name, kept: true })), ...attachments.map(file => ({ id: file.id, name: file.name, kept: false }))]
              : (item.attachments?.files ?? []).map(file => ({ id: file.id, name: file.name, kept: true }));
            return (
            <div className={`queued-prompt ${queueEdit?.id === item.id ? "queued-prompt-editing" : ""} ${drag?.id === item.id ? "queue-dragging" : ""}`} key={item.id} data-queue-id={item.id} style={rowStyle(index)}>
              <button type="button" className="queue-drag-handle" disabled={disabled || queue.length < 2}
                aria-label={`Переместить задание ${index + 1}`} title="Перетащите для изменения порядка. Стрелки ↑ и ↓ — переместить с клавиатуры"
                onPointerDown={e => pointerDown(e, item.id)} onPointerMove={pointerMove}
                onPointerUp={() => finish()} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)}
                onKeyDown={e => {
                  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                  e.preventDefault(); const target = index + (e.key === "ArrowUp" ? -1 : 1);
                  if (target < 0 || target >= queue.length) return;
                  if (store.reorderQueued(item.id, queue[e.key === "ArrowUp" ? target : target + 1]?.id ?? null))
                    setAnnouncement(`Задание перемещено на позицию ${target + 1}`);
                }}><Icon name="grip" size={14}/></button>
              <p className="queued-summary" title={item.text}>{item.text.replace(/\s+/g, " ").trim()}</p>
              {!!itemFiles.length && <button type="button" className="queued-file-count" aria-label="Вложения в очереди" aria-expanded={queueFiles === item.id} title={itemFiles.map(file => file.name).join("\n")} onClick={() => setQueueFiles(queueFiles === item.id ? null : item.id)}><Icon name="file" size={14}/>{itemFiles.length}</button>}
              {item.error && <span className="queued-error" role="alert" title={item.error}><span aria-hidden="true">!</span><span>{item.error}</span></span>}
              <div className="queue-actions">
                {item.state === "ready" ? (
                  <>
                    <button
                      disabled={(!!queueEdit && queueEdit.id !== item.id) || (!queueEdit && store.isQueueLocked()) || !connected || switching || s.ui.sending}
                      title={queueEdit?.id === item.id ? "Применить изменения и передать уточнение" : "Передать уточнение на следующий шаг агента без остановки инструмента"}
                      onClick={() => void store.steerQueued(item.id)}
                    >
                      Скорректировать
                    </button>
                    <button
                      disabled={!!queueEdit || store.isQueueLocked() || !!draft.trim() || attachments.length > 0 || s.ui.sending}
                      title={draft.trim() || attachments.length ? "Сначала отправьте или очистите черновик" : "Редактировать в поле ввода"}
                      onClick={() => void store.editQueued(item.id).then(opened => { if (opened) focusEditor(); })}
                    >
                      Изменить
                    </button>
                  </>
                ) : item.state === "sending" ? (
                  <span>Отправляется…</span>
                ) : (
                  // Delivery unknown after a restart: never replayed automatically. The user
                  // checks the chat history above and tells the runtime what happened.
                  <>
                    <span>Отправка не подтверждена. Проверьте историю чата.</span>
                    <button disabled={!!queueEdit || s.ui.sending || !connected}
                      title="Запрос виден в истории: убрать его из очереди без повтора"
                      onClick={() => void store.acknowledgeQueued(item.id, "drop").catch(error => setAnnouncement(String(error)))}>
                      Уже отправлен
                    </button>
                    <button disabled={!!queueEdit || s.ui.sending || !connected}
                      title="Запроса нет в истории: вернуть его в очередь (очередь останется на паузе)"
                      onClick={() => void store.acknowledgeQueued(item.id, "requeue").catch(error => setAnnouncement(String(error)))}>
                      Вернуть в очередь
                    </button>
                  </>
                )}
                <button
                  disabled={!!queueEdit || store.isQueueLocked() || item.state === "sending"}
                  aria-label="Убрать из очереди"
                  onClick={() => void store.removeQueued(item.id)}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
              {queueFiles === item.id && <div className="queued-attachments" aria-label="Файлы запроса в очереди">
                {itemFiles.map(file => <div className="queued-attachment" key={`${file.kept ? "kept" : "draft"}:${file.id}`}>
                  <Icon name="file" size={14}/><span title={file.name}>{file.name}</span>
                  <button type="button" aria-label={`Убрать из запроса ${file.name}`} disabled={item.state !== 'ready' || s.ui.sending || (store.isQueueLocked() && !editing)}
                    onClick={() => { if (editing && !file.kept) removeFile(file.id); else void store.removeQueuedAttachment(item.id, file.id); }}><Icon name="close" size={14}/></button>
                </div>)}
              </div>}
            </div>
          ); })}
          </div>
          {drag && source >= 0 && createPortal(<div ref={preview} className="queue-drag-preview" aria-hidden="true"
            style={{left: drag.box.left, top: drag.box.top, width: drag.box.width, height: drag.box.height,
              transform: `translate3d(${(gesture.current?.x ?? 0) - (gesture.current?.startX ?? 0)}px, ${(gesture.current?.y ?? 0) - (gesture.current?.startY ?? 0)}px, 0) scale(1.015)`}}>
            <Icon name="grip" size={14}/><span>{queue[source].text.replace(/\s+/g, " ").trim()}</span>
            {!!queue[source].attachments?.files.length && <small><Icon name="file" size={14}/>{queue[source].attachments.files.length}</small>}
          </div>, document.body)}
        </div>
  );
}
