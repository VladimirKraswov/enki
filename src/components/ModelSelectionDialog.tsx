import { useEffect, useRef } from "react";
import type { SwitchStatus } from "../models/services";
import { ModelSwitchStatus } from "./ModelSwitchStatus";

/** The dialog describes the requested target, never the previously selected model. */
export function ModelSelectionDialog({ label, pending, error, status, progress, question, onClose, onRetry, onReset }: {
  label: string; pending: boolean; error: string; status?: SwitchStatus; progress?: string;
  /** First question the transition is waiting on in the chat (e.g. consent to
   * compact with another provider's model). The modal is otherwise inert, so
   * the user must be told to close it — closing only stops WAITING here; the
   * runtime operation continues on its own. */
  question?: string | null;
  /** Offered when the runtime says the history cannot be summarized into the
   * target (dead source model, oversized history): reset the model context —
   * the transcript stays in the chat — and switch without summarization. */
  onReset?: () => void;
  onClose: () => void; onRetry: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className="model-selection-dialog" aria-labelledby="model-selection-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <h2 id="model-selection-title">{pending ? "Подготовка модели" : "Не удалось переключить модель"}</h2>
    <p className="model-selection-name">{label}</p>
    {pending ? <>
      <p role="status">{progress || "Проверяем подключение и готовность. Переключение может занять некоторое время."}</p>
      {question && <p role="status">Модель ждёт ответа в чате: {question} Закройте это окно, чтобы ответить — переход продолжится.</p>}
      {status && <ModelSwitchStatus state={status} modelName={label}/>}
    </> : <>
      <p>Модель остаётся в списке. Текущий выбор сохранён. Устраните указанную причину и повторите переход.</p>
      <p className="model-selection-error" role="alert">{error}</p>
      {onReset && <p>Можно сбросить контекст: прежняя история останется в чате и на экране, но перестанет передаваться модели. Суммаризация не потребуется.</p>}
    </>}
    <div className="btn-row">
      <button type="button" className="btn" onClick={onClose}>{pending ? (question ? "Перейти к вопросу" : "Отменить") : "Закрыть"}</button>
      {!pending && onReset && <button type="button" className="btn primary" onClick={onReset}>Сбросить контекст и перейти</button>}
      {!pending && <button type="button" className={onReset ? "btn" : "btn primary"} onClick={onRetry}>Проверить снова</button>}
    </div>
  </dialog>;
}
