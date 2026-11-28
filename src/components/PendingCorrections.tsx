import type { PendingCorrectionDTO } from "../../src-tauri/resources/agent/src/protocol";
import { memo } from "react";
import { CopyButton } from "./CopyButton";

export interface VisibleSteering { text: string; createdAt: number }

/** A delivered correction is already displayed as a steering note in the
 * transcript. Keep the receipt hidden then; otherwise it would say "waiting
 * for the next agent step" forever when the runtime did not attach entry_id. */
export function correctionIsVisible(item: PendingCorrectionDTO, visible: readonly VisibleSteering[]): boolean {
  const text = item.text.trim();
  return !!text && visible.some(value => value.text.trim() === text && value.createdAt >= item.createdAt - 5_000);
}

/** Durable receipts: never dispatch, replay or interrupt the active turn. */
export const PendingCorrections = memo(function PendingCorrections({ items, connected, visible = [], onAction }: {
  items: PendingCorrectionDTO[]; connected: boolean; visible?: readonly VisibleSteering[];
  onAction?: (command: string, action: "cancel" | "close" | "retry") => void;
}) {
  const pending = items.filter(item => !correctionIsVisible(item, visible));
  if (!pending.length) return null;
  return <section className="pending-corrections" aria-label="Уточнения текущей задачи">
    {pending.map(item => <details className="pending-correction" key={item.id} open>
      <summary><span aria-hidden="true">↳</span><b>Уточнение</b><span className="correction-status" role="status">
        {item.state === "uncertain" ? "Доставка не подтверждена" : !connected ? "Сохранено · нет связи с агентом"
          : item.state === "running" ? "Ждёт следующего шага агента" : "Передаётся агенту…"}
      </span></summary>
      <div className="correction-body"><p>{item.text || "Приложенные файлы"}</p><CopyButton text={item.text} label="Скопировать уточнение" compact/></div>
      {!!item.attachments?.length && <p className="correction-files">{item.attachments.map(a => a.name).join(" · ")}</p>}
      {item.state === "uncertain" && <p className="correction-warning" role="alert">{item.error || "Проверьте историю перед повторной отправкой."}</p>}
      {onAction && <div className="correction-actions">
        {item.state === "uncertain"
          ? <><button className="btn small" onClick={() => onAction(item.id, "retry")}>Отправить заново</button>
            <button className="btn small" onClick={() => onAction(item.id, "close")}>Закрыть</button></>
          : <button className="btn small" title="Пока агент не взял уточнение в работу" onClick={() => onAction(item.id, "cancel")}>Отменить</button>}
      </div>}
    </details>)}
  </section>;
});
