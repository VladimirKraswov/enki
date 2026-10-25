import { useId, useState, useSyncExternalStore } from "react";
import { store } from "../state/store";
import { MAX_MINUTES, STORAGE_FAILED, type ScheduledTask, type TaskScheduler } from "../schedules/tasks";
import { Icon } from "./Icon";
import { errText } from "../state/errors";
import { RUNTIME_AGENT_ID } from "../agent/runtime/ids";
import { SCHEDULE_MAX_ATTEMPTS } from "../../src-tauri/resources/agent/src/protocol";

const time = (n: number) => new Date(n).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const UNITS = [{ id: "min", label: "минут", factor: 1 }, { id: "hour", label: "часов", factor: 60 }, { id: "day", label: "дней", factor: 1440 }] as const;
export function intervalLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} дн`;
  if (minutes % 60 === 0) return `${minutes / 60} ч`;
  return `${minutes} мин`;
}
const modelLabel = (t: Pick<ScheduledTask, "model" | "agent">) =>
  [`${t.model.providerID}/${t.model.modelID}`, t.model.variant, t.agent && `агент ${t.agent}`].filter(Boolean).join(" · ");

export function statusLine(t: ScheduledTask, pending: "pause" | "remove" | undefined): string {
  if (pending) return pending === "remove" ? "Будет удалено после текущей проверки" : "Будет приостановлено после текущей проверки";
  if (t.state === "dispatching") return t.attempt ? `Повторная отправка (попытка ${t.attempt + 1} из ${SCHEDULE_MAX_ATTEMPTS})…` : "Проверка чата и отправка…";
  if (!t.enabled && t.mode === "once" && t.state === "sent") return "Выполнено: запрос передан агенту";
  if (!t.enabled) return t.state === "error" ? "Приостановлено" : "Приостановлено вручную";
  // A refused (provably unsent) wake-up is re-attempted under a new id, bounded by the runtime.
  if (t.state === "waiting" && t.attempt)
    return `Не отправлено: ${t.detail ?? "отказ среды выполнения"} · повторная попытка ${t.attempt + 1} из ${SCHEDULE_MAX_ATTEMPTS} скоро`;
  if (t.state === "waiting") return `${t.detail ?? "Ожидает"} · проверка повторяется`;
  return `Следующий запуск: ${time(t.nextAt)}`;
}

/** Runtime explanation of a ready timer (e.g. a wake-up cancelled before it was sent). */
export function readyDetail(t: ScheduledTask): string | null {
  return t.enabled && t.state === "ready" && t.detail ? t.detail : null;
}

/** Recurring prompts of one chat. A schedule is an explicit user action; nothing is sent on save. */
export function ScheduleSection({ scheduler, server, directory, sessionID, showAll = false }: {
  scheduler: TaskScheduler; server: string; directory: string | null; sessionID: string | null; showAll?: boolean;
}) {
  const sectionId=useId();
  const all = useSyncExternalStore(scheduler.subscribe, scheduler.snapshot);
  const status = useSyncExternalStore(scheduler.subscribe, scheduler.status);
  const tasks = all.filter(t => showAll || t.server === server && t.sessionID === sessionID && t.directory === directory);
  const elsewhere = all.filter(t => t.enabled && t.server === server && t.sessionID !== sessionID).length;
  const [mode, setMode] = useState<"once" | "repeat">("repeat");
  const [form, setForm] = useState(false), [title, setTitle] = useState(""), [prompt, setPrompt] = useState("");
  const [amount, setAmount] = useState(15), [unit, setUnit] = useState<(typeof UNITS)[number]["id"]>("min");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const model = store.getModelChoice();
  const minutes = amount * (UNITS.find(u => u.id === unit)?.factor ?? 1);
  const intervalValid = Number.isInteger(amount) && amount >= 1 && minutes <= MAX_MINUTES;
  const unavailable = status.storage !== "ok";

  // Saving only stores the timer in the runtime; the form keeps its input
  // until the runtime accepted it, so a refusal never loses the prompt.
  const addTask = async () => {
    if (saving) return;
    setSaving(true);
    try {
      if (!sessionID || !directory || !model) throw new Error("Откройте чат и выберите модель.");
      if (!intervalValid) throw new Error("Интервал — целое число от 1 минуты до 7 дней.");
      await scheduler.add({ server, directory, sessionID, engine: RUNTIME_AGENT_ID, title: title.trim(), prompt: prompt.trim(), minutes, mode, model: { ...model } });
      setForm(false); setTitle(""); setPrompt(""); setError("");
    } catch (e) { setError(errText(e) || "Не удалось сохранить задание."); }
    finally { setSaving(false); }
  };
  const mutate = async (action: () => Promise<void>) => {
    try { await action(); setError(""); }
    catch (e) { setError(errText(e) || STORAGE_FAILED); }
  };

  return <section aria-labelledby={`${sectionId}-title`}>
    <div className="context-section-title">
      <h3 id={`${sectionId}-title`}>Запланировано</h3>
      <button className="icon-btn" aria-label="Добавить таймер" aria-expanded={form} aria-controls={`${sectionId}-form`}
        disabled={!sessionID || !directory || unavailable} onClick={() => { setForm(!form); setError(""); }}><Icon name="plus" size={16}/></button>
    </div>
    {unavailable && <p className="context-error" role="alert">{STORAGE_FAILED}</p>}
    {status.skipped > 0 && <p className="context-note" role="status">Не удалось прочитать сохранённых записей: {status.skipped}. Они отключены; исходные данные сохранены в резервной копии профиля Desktop.</p>}
    {!tasks.length && !form && <p className="context-note">Таймеров нет</p>}
    {tasks.length > 0 && <ul className="context-list">{tasks.map(t => {
      const pending = status.pending[t.id];
      // This window can withdraw its own attempt; another window's send must settle there.
      const foreign = t.state === "dispatching" && status.flight !== t.id;
      return <li className="context-task" key={t.id}>
        <div className="context-row"><Icon name="clock" size={16}/><strong title={t.prompt}>{t.title}</strong><span>{t.mode === "once" ? "Один раз" : `Каждые ${intervalLabel(t.minutes)}`}</span></div>
        <small>{modelLabel(t)}</small>
        {showAll && <small title={t.directory}>Чат: {t.sessionID} · {t.directory}{t.server !== server ? " · другое подключение" : ""}</small>}
        <p className="context-note">{t.prompt}</p>
        <small>{statusLine(t, pending)}</small>
        {readyDetail(t) && <small className="context-note">{readyDetail(t)}</small>}
        {t.lastAt && <small>Последний запрос принят агентом: {time(t.lastAt)}. Результат — в истории чата.</small>}
        {t.state === "error" && t.detail && <p className="context-error">{t.detail}</p>}
        <div className="context-task-actions">
          <button className="btn small ghost" disabled={!!pending || unavailable || foreign}
            onClick={() => void mutate(() => scheduler.toggle(t.id))}>{t.enabled ? "Пауза" : "Возобновить"}</button>
          <button className="btn small ghost" disabled={pending === "remove" || unavailable || foreign}
            onClick={() => void mutate(() => scheduler.remove(t.id))}>Удалить</button>
        </div>
      </li>;
    })}</ul>}
    {form && <form id={`${sectionId}-form`} className="context-task-form" onSubmit={e => { e.preventDefault(); void addTask(); }}
      onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); setForm(false); } }}>
      <label>Режим<select value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="repeat">Повторять</option><option value="once">Выполнить один раз</option></select></label>
      <label>Название<input autoFocus required maxLength={120} value={title} onChange={e => setTitle(e.target.value)} placeholder="Например, проверить CI"/></label>
      <label>Задание агенту<textarea required maxLength={20000} rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Что нужно проверять или выполнять?"/></label>
      <div className="context-interval">
        <label>Интервал<input type="number" required min={1} max={MAX_MINUTES} step={1} value={Number.isFinite(amount) ? amount : ""} onChange={e => setAmount(e.target.valueAsNumber)}/></label>
        <label>Единица<select value={unit} onChange={e => setUnit(e.target.value as typeof unit)}>{UNITS.map(u => <option key={u.id} value={u.id}>{u.label}</option>)}</select></label>
      </div>
      <p className="context-note">
        Модель: {model ? modelLabel({ model }) : "не выбрана"}. Работает и в трее. После полного выхода проверки ждут открытия Enki; пропущенные повторы не накапливаются.</p>
      <button className="btn small" type="submit" disabled={!model || !intervalValid || saving}>{saving ? "Сохранение…" : "Сохранить расписание"}</button>
    </form>}
    {error && <p className="context-error" role="alert">{error}</p>}
    {!showAll && elsewhere > 0 && <p className="context-note">Ещё активных заданий в других чатах этого сервера: {elsewhere}. Они выполняются в фоне.</p>}
  </section>;
}
