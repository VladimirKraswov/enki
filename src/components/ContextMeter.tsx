import { useEffect, useRef, useState } from "react";
import { FloatingPopover } from "./FloatingPopover";
import { store, useAppState } from "../state/store";
import { limitPercent, loadMonthlyUsage } from "../usage/windows";

export function ContextMeter() {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const s = useAppState(),
    c = store.contextInfo();
  const n = (x: number | null) =>
    x === null ? "—" : x.toLocaleString("ru-RU");
  const choice = store.getModelChoice();
  const provider = choice?.providerID ?? null;
  const limit = provider ? store.monthlyLimit(provider) : undefined;
  const [monthly, setMonthly] = useState<Awaited<ReturnType<typeof loadMonthlyUsage>> | null>(null);
  const [monthlyFailed, setMonthlyFailed] = useState(false);
  const [draftLimit, setDraftLimit] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !provider) return;
    let alive = true;
    setMonthly(null); setMonthlyFailed(false); setDraftLimit(null);
    void loadMonthlyUsage(provider).then(value => { if (alive) setMonthly(value); }).catch(() => { if (alive) setMonthlyFailed(true); });
    return () => { alive = false; };
  }, [open, provider]);
  const monthPercent = monthly && limit !== undefined ? limitPercent(monthly.usage.tokens, limit) : null;
  const saveLimit = (value: string) => {
    if (!provider) return;
    const parsed = Number(value);
    store.setMonthlyLimit(provider, value.trim() !== "" && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined);
    setDraftLimit(null);
  };
  // The runtime (SDK) decides when to compact; the window only shows the
  // runtime's setting (kept current by `runtime.settings`), never its own threshold.
  const title = `Контекст: ${n(c.used)} / ${n(c.limit)} токенов. Данные обновляются после ответа. Автосжатие ${c.auto === false ? "выключено" : "включено"} в настройках агента.`;
  return (
    <div className="context-meter">
      <button ref={ref} className="context-trigger" aria-label={title} title={title}
        aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <circle
            cx="12"
            cy="12"
            r="9"
            fill="none"
            stroke="var(--border)"
            strokeWidth="2.5"
          />
          <circle
            cx="12"
            cy="12"
            r="9"
            fill="none"
            stroke={
              c.limit > 0 && c.used !== null && c.used >= c.threshold
                ? "var(--warn)"
                : "currentColor"
            }
            strokeWidth="2.5"
            strokeDasharray={`${c.percent * 0.5655} 56.55`}
            transform="rotate(-90 12 12)"
          />
        </svg>
        <span>
          {c.compacting
            ? "Сжатие…"
            : c.used === null || !c.limit
              ? "Контекст"
              : `${c.percent}%`}
        </span>
      </button>
      {monthPercent !== null && <span className="context-month" role="status"
        title={`Месячный расход ${provider}: ${n(monthly!.usage.tokens)} токенов из ${n(limit!)}. Остаток по данным Enki, а не по квоте провайдера.`}>
        Месяц {monthPercent}%</span>}
      {open && <FloatingPopover anchor={ref.current} className="context-popover" role="dialog"
        label="Контекст диалога" onClose={() => setOpen(false)}>
        <strong>Контекст диалога</strong>
        <div className="kv">
          <span>Занято / окно</span>
          <b>
            {n(c.used)} / {n(c.limit)}
          </b>
        </div>
        <div className="kv">
          <span>Автосжатие</span>
          <b>{c.auto === false ? "Выключено" : "Включено"}</b>
        </div>
        {c.auto && c.limit > 0 && <p className="muted">Сжатие запускается между шагами при заполнении около {Math.round(c.threshold / c.limit * 100)}% окна. Остальное зарезервировано для ответа. Сжатие истории и кэш вычислений — разные механизмы.</p>}
        {store.conversation().capabilities.compaction && <button
          className="btn small"
          disabled={!s.activeSessionId || store.isRunning() || c.compacting}
          title={store.isRunning() ? 'Сжатие вручную доступно после завершения текущего ответа агента' : 'Создать выжимку истории; исходная переписка сохранится'}
          onClick={() =>
            s.activeSessionId && void store.compactSession(s.activeSessionId)
          }
        >
          Сжать сейчас
        </button>}
        {provider && <>
          <strong>Месячный расход · {provider}</strong>
          <div className="kv">
            <span>Токенов с 1-го числа</span>
            <b>{monthly ? n(monthly.usage.tokens) : monthlyFailed ? "не удалось загрузить" : "…"}</b>
          </div>
          {monthly && <div className="kv">
            <span>Сброс счёта (1-е число)</span>
            <b>{new Date(monthly.usage.resetAt).toLocaleDateString("ru-RU")}</b>
          </div>}
          {monthly && limit !== undefined && monthPercent !== null && <>
            <div className="kv">
              <span>Осталось до лимита</span>
              <b>{n(Math.max(0, limit - monthly.usage.tokens))} ({Math.max(0, 100 - monthPercent)}%)</b>
            </div>
            <progress max={100} value={monthPercent} aria-label="Израсходовано месячного лимита" />
          </>}
          <label className="kv">
            <span>Месячный лимит, токенов</span>
            <input type="number" min={0} step={1000} placeholder="не задан"
              aria-label="Месячный лимит провайдера в токенах"
              value={draftLimit ?? (limit !== undefined ? String(limit) : "")}
              onChange={e => setDraftLimit(e.target.value)}
              onBlur={e => saveLimit(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") saveLimit((e.target as HTMLInputElement).value); }} />
          </label>
          <p className="muted">Провайдер не публикует остаток квоты. Это расход по записям Enki на этом устройстве; реальный сброс квоты может привязываться к дате подписки. Без заданного лимита процентов нет, с заданным — «расход / ваш лимит».</p>
        </>}
      </FloatingPopover>}
    </div>
  );
}
