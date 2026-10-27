import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { activePluginUi } from "../agent/runtime/pluginUi/active";
import { isMcpStartupNotice, McpRecoveryBudget } from "../capabilities/recovery";
import { errText, store, useAppSelector } from "../state/store";
import type { AppState } from "../state/types";

const budget = new McpRecoveryBudget();
const noop = () => () => {};
const notReady = () => false;
const EMPTY_NOTICES: readonly { text: string }[] = [];
const noNotices = () => EMPTY_NOTICES;
const SERVICE_NAMES: Record<string, string> = { "enki-images": "Генератор изображений", "web-search": "Поиск в интернете",
  "web-compass": "Web Compass", "cua-desktop": "Управление компьютером", "enki-schedules": "Таймеры", "rea-remote": "Удалённые инструменты" };

/** Discovery recovery only. Never interrupts a turn or repeats a tool action. */
export function McpRecoveryNotice({ sessionId, directory }: { sessionId: string; directory: string }) {
  const select = useCallback((s: AppState) => ({ connected: s.connection.phase === "connected",
    workspace: s.prefs.workspaceKey ?? s.prefs.endpoint, endpoint: s.connection.endpoint,
    instance: s.runtime?.instance,
    running: store.isRunning(sessionId), sending: s.ui.sending,
    servers: store.mcpServerStatuses(sessionId) }), [sessionId]);
  const state = useAppSelector(select);
  const active = useSyncExternalStore(activePluginUi.subscribe, activePluginUi.get);
  const ready = useSyncExternalStore(active?.session.subscribe ?? noop, active ? () => {
    const view = active.session.getView();
    return view.phase === "live" && !!view.snapshot && !view.snapshot.pendingDraft && !view.snapshot.pendingSubmission
      && !view.mode.custom && !view.mode.terminalInput;
  } : notReady);
  const draftReady = useSyncExternalStore(active?.draft.subscribe ?? noop, active ? () => active.draft.getState().kind === "synced" : notReady);
  const notices = useSyncExternalStore(active?.session.subscribe ?? noop, active ? () => active.session.getView().notices ?? EMPTY_NOTICES : noNotices);
  const canRecover = ready && draftReady && active?.session.sessionID === sessionId && active.session.directory === directory;
  const key = JSON.stringify([state.workspace, state.endpoint, state.instance, sessionId, directory]);
  const failed = state.servers.filter(server => server.state === "error");
  const hasFailure = failed.length > 0 || (!state.servers.length && notices.some(n => isMcpStartupNotice(n.text)));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const live = useRef(true), inFlight = useRef<string | null>(null), currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { setBusy(false); setError(""); }, [key]);
  const run = useCallback(async () => {
    if (inFlight.current === key) return;
    inFlight.current = key; setBusy(true); setError("");
    try { await store.recoverMcpConnection(sessionId, directory); }
    catch (e) { if (live.current && currentKey.current === key) setError(errText(e)); }
    finally { if (inFlight.current === key) inFlight.current = null; if (live.current && currentKey.current === key) setBusy(false); }
  }, [sessionId, directory, key]);
  useEffect(() => {
    if (state.servers.length && state.servers.every(server => server.state === "connected")) { budget.connected(key); if (error) setError(""); }
    if (state.connected && canRecover && hasFailure && !state.running && !state.sending && !busy && inFlight.current !== key && budget.claim(key)) void run();
  }, [state.connected, state.running, state.sending, state.servers, canRecover, key, busy, hasFailure, run, error]);
  if (!state.connected || (!hasFailure && !busy && !error)) return null;
  const message = busy ? "Переподключаю инструменты…"
    : state.running || state.sending ? budget.hasAttempted(key)
      ? "Не все инструменты подключились. Можно повторить подключение после текущего ответа."
      : "Не все инструменты подключились. Повторим подключение после текущего ответа."
      : error || "Не удалось подключить инструменты. Проверьте сервис в настройках или повторите подключение.";
  const label = failed.length ? failed.map(s => SERVICE_NAMES[s.id] ?? s.id).join(", ") : "Подключение инструментов";
  return <div className="mcp-recovery-notice workspace-progress" role="status">
    <span><strong>{label}: </strong>{message} Генерация и другие действия не повторяются.</span>
    <button className="btn small" type="button" disabled={busy || state.running || state.sending || !canRecover} onClick={() => void run()}>Повторить подключение</button>
  </div>;
}
