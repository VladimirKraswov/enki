import type { PendingCorrectionDTO } from "../../src-tauri/resources/agent/src/protocol";
import { memo } from "react";
import { CopyButton } from "./CopyButton";

/** Durable receipts: never dispatch, replay or interrupt the active turn. */
export const PendingCorrections = memo(function PendingCorrections({ items, connected }: { items: PendingCorrectionDTO[]; connected: boolean }) {
  if (!items.length) return null;
  return <section className="pending-corrections" aria-label="Уточнения текущей задачи">
    {items.map(item => <details className="pending-correction" key={item.id} open>
      <summary><span aria-hidden="true">↳</span><b>Уточнение</b><span className="correction-status" role="status">
        {item.state === "uncertain" ? "Доставка не подтверждена" : !connected ? "Сохранено · нет связи с агентом"
          : item.state === "running" ? "Ждёт следующего шага агента" : "Передаётся агенту…"}
      </span></summary>
      <div className="correction-body"><p>{item.text || "Приложенные файлы"}</p><CopyButton text={item.text} label="Скопировать уточнение" compact/></div>
      {!!item.attachments?.length && <p className="correction-files">{item.attachments.map(a => a.name).join(" · ")}</p>}
      {item.state === "uncertain" && <p className="correction-warning" role="alert">{item.error || "Проверьте историю перед повторной отправкой."}</p>}
    </details>)}
  </section>;
});
