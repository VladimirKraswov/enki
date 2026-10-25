import { RecoveryButton } from "./RecoveryCenter";
import { BrowserButton } from "./BrowserSettings";
import { RUNTIME_CAPABILITIES } from "../agent/runtime/backend";
import { store, useAppState } from "../state/store";
import { Icon } from "./Icon";
import { CONTEXT_PANEL_ID } from "./ContextPanel";
export function TopBar() {
  const s = useAppState(),
    l = s.prefs.layout,
    session = store.activeSession();
  // One executing agent. An imported OpenCode chat is a read-only archive with
  // an explicit continuation into a new Enki chat (nothing is sent or replayed).
  const archive = !!session && store.isLegacySession(session.id);
  return (
    <header className="topbar" data-tauri-drag-region="deep">
      {!l.sidebarOpen && (
        <button
          className="icon-btn"
          aria-label="Показать боковую панель"
          onClick={() => store.setLayout({ sidebarOpen: true })}
        >
          <Icon name="sidebar" />
        </button>
      )}
      <span className="session-title">{session?.title ?? "Новый чат"}</span>
      <span className="spacer" />
      {store.currentHost() && (
        <span
          className="execution-badge"
          title="Инструменты выполняются на удалённой машине"
        >
          <Icon name="server" size={14} />
          {store.hostLabel()}
        </span>
      )}
      {archive && (
        <span className="execution-badge" title="Импортированный чат OpenCode: история доступна только для чтения">
          Архив OpenCode
        </span>
      )}
      {session && archive && (
        <button
          className="icon-btn handoff-button"
          title="Создать новый чат Enki с историей этого архива. Архив не меняется, ничего не отправляется."
          aria-label="Продолжить в Enki"
          disabled={s.connection.phase !== "connected"}
          onClick={() => void store.continueLegacySession(session)}
        >
          <Icon name="handoff" size={17} />
          <span>Продолжить в Enki</span>
        </button>
      )}
      {session && !archive && <button className="icon-btn handoff-button" title="Передать задачу в другую сессию" aria-label="Передать задание" disabled={s.connection.phase !== "connected" || !RUNTIME_CAPABILITIES.fork} onClick={() => store.setUi({ handoffSource: session })}>
        <Icon name="handoff" size={17} /><span>Передать</span>
      </button>}
      <button className={`icon-btn${s.ui.contextOpen ? " on" : ""}`} aria-label="Контекст задачи" aria-expanded={s.ui.contextOpen} aria-controls={s.ui.contextOpen ? CONTEXT_PANEL_ID : undefined} title="Расписание, результаты, субагенты и источники" onClick={() => store.setUi({ contextOpen: !s.ui.contextOpen })}><Icon name="context" /></button>
      <RecoveryButton/>
      <BrowserButton/>
      {s.ui.vcs?.branch && (
        <span className="branch-label">
          <Icon name="branch" size={14} />
          {s.ui.vcs.branch}
        </span>
      )}
      {<button
        className={`icon-btn${l.bottomOpen ? " on" : ""}`}
        aria-label="Терминал"
        aria-pressed={l.bottomOpen}
        title="Терминал · Ctrl+`"
        disabled={s.connection.phase !== "connected" || s.ui.workspacePreparing}
        onClick={() => void store.toggleTerminal()}
      >
        <Icon name="terminal" />
      </button>}
      {<button
        className={`icon-btn review-button${l.rightOpen ? " on" : ""}`}
        disabled={!store.workspaceToolsAvailable()}
        aria-label="Изменения и файлы"
        aria-pressed={l.rightOpen}
        onClick={() => store.setLayout({ rightOpen: !l.rightOpen })}
      >
        <Icon name="panel" size={17} />
        <span>Изменения</span>
      </button>}
    </header>
  );
}
