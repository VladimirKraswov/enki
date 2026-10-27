import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { activePluginUi, type ActiveUi } from "../agent/runtime/pluginUi/active";
import type { DraftSyncState } from "../agent/runtime/pluginUi/draftSync";
import type { PluginUiView } from "../agent/runtime/pluginUi/session";
import type { UiWidget } from "../agent/runtime/pluginUi/types";
import { store, useAppSelector, errText } from "../state/store";
import type { AppState } from "../state/types";
import { PluginTerminalSurface } from "./PluginTerminalSurface";
import { isMcpStartupNotice } from "../capabilities/recovery";

const NO_VIEW: PluginUiView = { phase: "connecting", detail: "", snapshot: null, mode: { custom: false, terminalInput: false }, draftRevision: -1, generation: 0, notices: [] };
const OFFLINE: DraftSyncState = { kind: "offline" };
const noop = () => () => {};

function useActive(): { active: ActiveUi | null; view: PluginUiView; draft: DraftSyncState } {
  const active = useSyncExternalStore(activePluginUi.subscribe, activePluginUi.get);
  const view = useSyncExternalStore(active?.session.subscribe ?? noop, active?.session.getView ?? (() => NO_VIEW));
  const draft = useSyncExternalStore(active?.draft.subscribe ?? noop, active?.draft.getState ?? (() => OFFLINE));
  return { active, view, draft };
}

function Widgets({ widgets, placement }: { widgets: UiWidget[]; placement: UiWidget["placement"] }) {
  const list = widgets.filter(widget => widget.placement === placement);
  if (!list.length) return null;
  return <div className="plugin-widgets" aria-label="Виджеты расширений">
    {list.map(widget => <pre key={widget.key} className="plugin-widget" data-kind={widget.kind}>
      {widget.kind === "text" ? (widget.lines ?? []).join("\n") : `«${widget.key}»: компонент расширения показан в интерфейсе расширения.`}
    </pre>)}
  </div>;
}

/** Below the composer: belowEditor widgets of the same live surface. */
export function PluginUiBelowComposer() {
  const { view } = useActive();
  if (view.phase !== "live" || !view.snapshot) return null;
  return <Widgets widgets={view.snapshot.state.widgets} placement="belowEditor" />;
}

/**
 * Runtime plugin UI of the selected chat, integrated with the normal composer:
 * statuses, working indicator, widgets, notifications, the real SDK TUI surface
 * (custom components, overlays, expanded editor), pending editor submissions and
 * the shared draft CAS state. Dialogs are shown by the existing dialog host.
 */
export function PluginUiPanel({ sessionId, directory }: { sessionId: string; directory: string }) {
  // Only what the panel shows: streamed chat deltas must not re-render it.
  const selectPanel = useCallback((s: AppState) => ({ connected: s.connection.phase === "connected", theme: String(s.prefs.theme), running: store.isRunning(sessionId) }), [sessionId]);
  const { connected, theme, running } = useAppSelector(selectPanel);
  const client = connected ? store.client : null;
  useEffect(() => {
    if (!client) return;
    activePluginUi.activate(client, sessionId, directory, store);
    return () => { void activePluginUi.deactivate(); };
  }, [client, sessionId, directory]);
  const { active, view, draft } = useActive();
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(0);
  const [actionError, setActionError] = useState("");
  useEffect(() => { setExpanded(false); setDismissed(0); setActionError(""); }, [sessionId]);
  if (!active || active.session.sessionID !== sessionId) return null;
  const session = active.session, snapshot = view.snapshot;
  const act = (work: () => Promise<void>) => { setActionError(""); void work().catch(error => setActionError(errText(error))); };
  const notices = view.notices.filter(notice => notice.at > dismissed && !isMcpStartupNotice(notice.text));

  if (view.phase === "error") return <div className="plugin-ui plugin-ui-error" role="alert">
    <span>{view.detail}</span>
    <button type="button" className="btn small" onClick={() => session.retry()}>Подключиться снова</button>
  </div>;
  // Waiting: no worker yet. This window already holds the UI authority, so a
  // session_start UI of the worker a prompt starts appears here without a race.
  if (!snapshot || view.phase !== "live")
    return view.phase === "reconnecting" ? <div className="plugin-ui" role="status">{view.detail}</div> : null;

  const state = snapshot.state;
  const statuses = Object.entries(state.statuses);
  const showSurface = expanded || view.mode.custom || view.mode.terminalInput;
  // ChatView already owns the generic activity indicator. Only an explicit
  // extension message adds useful information here.
  const workingMessage = running && state.working.visible ? state.working.message?.trim() : undefined;
  if (!showSurface && !workingMessage && !statuses.length && !state.widgets.length && !notices.length
      && !snapshot.pendingDraft && !snapshot.pendingSubmission && active.draft.stash === null
      && draft.kind !== "conflict" && draft.kind !== "retrying" && !actionError) return null;
  return <div className="plugin-ui" aria-label="Расширения чата">
    <div className="plugin-ui-bar">
      {workingMessage && <span className="plugin-ui-working" role="status">{workingMessage}</span>}
      {statuses.map(([key, text]) => <span key={key} className="plugin-ui-status" title={key}>{text}</span>)}
      <span style={{ flex: 1 }} />
      <button type="button" className="btn small ghost" aria-expanded={showSurface} disabled={view.mode.custom}
        title={view.mode.custom ? "Расширение ожидает ввода в своём интерфейсе" : undefined}
        onClick={() => setExpanded(value => !value)}>{showSurface ? "Скрыть интерфейс расширения" : "Интерфейс расширения"}</button>
    </div>
    {notices.length > 0 && <ul className="plugin-ui-notices" role="log" aria-live="polite">
      {notices.map((notice, index) => <li key={`${notice.at}:${index}`} data-level={notice.level}>{notice.text}</li>)}
      <li><button type="button" className="btn small ghost" onClick={() => setDismissed(Date.now())}>Скрыть уведомления</button></li>
    </ul>}
    <Widgets widgets={state.widgets} placement="aboveEditor" />
    {snapshot.pendingSubmission && <div className="composer-error" role="alert">
      <span>Отправка из редактора расширения не подтверждена: «{snapshot.pendingSubmission.text.slice(0, 120)}». Повтор использует тот же идентификатор.</span>
      <button type="button" className="btn small" onClick={() => act(() => session.retrySubmission())}>Проверить и повторить</button>
    </div>}
    {snapshot.pendingDraft && <div className="composer-error" role="alert">
      <span>Изменение черновика расширения не подтверждено.</span>
      <button type="button" className="btn small" onClick={() => act(() => session.retryDraft())}>Повторить</button>
      <button type="button" className="btn small ghost" onClick={() => act(() => session.discardPendingDraft())}>Отменить изменение</button>
    </div>}
    {draft.kind === "conflict" && <div className="composer-error" role="alert">
      <span>{draft.message} Ваш текст сохранён.</span>
      <button type="button" className="btn small" onClick={() => act(() => active.draft.keepMine())}>Оставить мой текст</button>
      <button type="button" className="btn small ghost" onClick={() => active.draft.takeTheirs()}>Взять текст расширения</button>
    </div>}
    {draft.kind === "retrying" && <div className="workspace-progress" role="status">Черновик не подтверждён ({draft.message}). Повторяю ту же правку…</div>}
    {active.draft.stash !== null && draft.kind !== "conflict" && <div className="workspace-progress" role="status">
      <span>Ваш черновик сохранён.</span>
      <button type="button" className="btn small ghost" onClick={() => active.draft.restoreStash()}>Вернуть мой текст</button>
    </div>}
    {actionError && <div className="composer-error" role="alert">{actionError}</div>}
    {showSurface && <PluginTerminalSurface session={session} scope={snapshot.scope} generation={view.generation}
      nativeScope={snapshot.nativeScope} themeKey={theme} />}
  </div>;
}
