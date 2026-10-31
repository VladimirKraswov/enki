import { SettingHelp } from "./SettingHelp";
import { useState } from "react";
import { browserNative } from "../browser/integration";
import { browserPerformance, currentTurnPerformance, type BrowserPerformance as Metrics } from "../browser/performance";
import { store, useAppState } from "../state/store";
import { browserEnabled } from "../browser/preferences";
import { isLocalComputer } from "../state/computer";
import { isNative } from "../native/platform";
import { secondsText } from "../util/duration";
const duration = (value: number | null | undefined) => value == null ? "—" : secondsText(value);
export function BrowserPerformance() {
  const app = useAppState(), [metrics,setMetrics] = useState<Metrics | null>(null), [busy,setBusy] = useState(false), [error,setError] = useState("");
  const turn = currentTurnPerformance(app.activeSessionId ? app.chat.sessions[app.activeSessionId] : undefined);
  const refresh = async () => {
    setBusy(true); setError("");
    try { const result = await browserNative<{ performance?: unknown }>("browser_presence"); setMetrics(browserPerformance(result.performance)); }
    catch { setError("Не удалось прочитать метрики браузера."); } finally { setBusy(false); }
  };
  return <section className="setting-group" aria-label="Скорость браузера"><h2>Скорость и диагностика <SettingHelp topic="browser.metrics" title="Метрики скорости"/></h2><div className="setting-card">
    <div className="setting-row"><div className="setting-label"><span>Новая браузерная задача</span></div><div className="setting-control"><button className="btn" disabled={!isNative() || !isLocalComputer(app.prefs.endpoint, !!store.currentHost()) || !browserEnabled(app.prefs) || app.ui.sending || app.ui.workspacePreparing} onClick={() => void store.newBrowserTask()}>Создать чат</button></div></div>
    <div className="setting-row"><div className="setting-label"><label htmlFor="browser-task-effort">Начальное усилие</label><SettingHelp topic="browser.effort" title="Начальное усилие"/></div><div className="setting-control"><select id="browser-task-effort" value={app.prefs.browser?.taskEffort ?? "low"} onChange={e => store.setBrowserSettings({taskEffort: e.target.value as "low" | "medium"})}><option value="low">Low</option><option value="medium">Medium</option></select></div></div>
    <div className="setting-row"><div className="setting-label"><span>Текущий ответ · полное время</span></div><div className="setting-control">{duration(turn?.wallMs)}</div></div>
    <div className="setting-row"><div className="setting-label"><span>Инструменты / рассуждения</span></div><div className="setting-control">{duration(turn?.toolMs)} / {duration(turn?.reasoningMs)}</div></div>
    <div className="setting-row"><div className="setting-label"><span>Вызовы / ошибки / выходные токены / рассуждения</span></div><div className="setting-control">{turn ? `${turn.calls} / ${turn.failed} / ${turn.output ?? "—"} / ${turn.reasoning ?? "—"}` : "—"}</div></div>
    <div className="setting-row"><div className="setting-label"><span>Браузер · очередь / действия и ожидания / наблюдения</span></div><div className="setting-control">{duration(metrics?.queueMs)} / {duration(metrics?.actionMs)} / {duration(metrics?.observeMs)}</div></div>
    <div className="setting-row"><div className="setting-label"><span>Браузер · вызовы / ошибки / шаги цепочек</span></div><div className="setting-control">{metrics ? `${metrics.calls} / ${metrics.failed} / ${metrics.completedSteps}` : "—"}</div></div>
    <div className="settings-actions"><button className="btn" disabled={!isNative() || busy} onClick={() => void refresh()}>{busy ? "Проверяю…" : "Обновить метрики"}</button><small className="settings-muted">Действие + ожидание + наблюдение объединены в один инструмент. Цепочки ограничены шестью шагами и прекращаются при вмешательстве.</small></div>
    {error && <p role="alert" className="settings-inline-error">{error}</p>}
  </div></section>;
}
