import { useEffect, useRef, useState } from "react";
import { RecoveryCenter } from "./RecoveryCenter";
import { BrowserButton } from "./BrowserSettings";
import { FloatingPopover } from "./FloatingPopover";
import { RUNTIME_CAPABILITIES } from "../agent/runtime/backend";
import { store, useAppState } from "../state/store";
import { Icon } from "./Icon";
import { CONTEXT_PANEL_ID } from "./ContextPanel";

/** Stable compact controls; named secondary actions share one keyboard menu. */
export function TopBar() {
  const s = useAppState(), l = s.prefs.layout, session = store.activeSession();
  const archive = !!session && store.isLegacySession(session.id);
  const [menu, setMenu] = useState(false), [recovery, setRecovery] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  useEffect(() => setMenu(false), [s.activeSessionId, s.directory]);
  useEffect(() => { if (menu) popup.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus(); }, [menu]);
  const action = (work: () => void) => { setMenu(false); work(); };
  const ready = s.connection.phase === "connected";
  const workspace = s.prefs.workspaceKey ?? s.prefs.endpoint;
  return <header className="topbar" data-tauri-drag-region="deep">
    {!l.sidebarOpen && <button className="icon-btn" aria-label="Показать боковую панель" onClick={() => store.setLayout({ sidebarOpen: true })}><Icon name="sidebar"/></button>}
    <span className="session-title" title={session?.title}>{session?.title ?? "Новый чат"}</span>
    {store.currentHost() && <span className="execution-badge" title={`Инструменты выполняются на удалённой машине: ${store.hostLabel()}`}><Icon name="server" size={14}/>{store.hostLabel()}</span>}
    {archive && <span className="execution-badge" title="Этот чат доступен только для чтения">Архив</span>}
    <span className="spacer"/>
    <div className="chat-toolbar" aria-label="Инструменты чата">
      {archive && session && <button className="icon-btn" aria-label="Продолжить чат" title="Создать рабочее продолжение с историей архива" disabled={!ready || store.isArchiveContinuing(session.id)} onClick={() => void store.continueLegacySession(session)}><Icon name="handoff" size={17}/></button>}
      <button ref={anchor} className={`icon-btn${menu ? " on" : ""}`} aria-label="Действия чата" title="Действия чата" aria-haspopup="menu" aria-expanded={menu}
        onClick={() => { setMenu(!menu); store.setUi({ contextOpen: false }); }}><Icon name="dots" size={18}/></button>
      <button className={`icon-btn${s.ui.contextOpen ? " on" : ""}`} aria-label="Контекст задачи" aria-expanded={s.ui.contextOpen} aria-controls={s.ui.contextOpen ? CONTEXT_PANEL_ID : undefined}
        title="Расписание, результаты, подзадачи и источники" onClick={() => { setMenu(false); store.setUi({ contextOpen: !s.ui.contextOpen }); }}><Icon name="context" size={18}/></button>
      <BrowserButton compact/>
    </div>
    {menu && <FloatingPopover anchor={anchor.current} contentRef={popup} className="chat-actions-menu" role="menu" label="Действия чата" width={270} placement="bottom" align="end" onClose={() => setMenu(false)}>
      <div onKeyDown={event => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const rows = [...popup.current!.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)")], i = rows.indexOf(document.activeElement as HTMLButtonElement);
        const index = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : (i + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
        rows[index]?.focus();
      }}>
        <span className="chat-actions-heading">Панели</span>
        <button role="menuitem" disabled={!ready || !!s.ui.workspacePreparing} onClick={() => action(() => { void store.toggleTerminal(); })}><Icon name="terminal" size={17}/><span>{l.bottomOpen ? "Скрыть терминал" : "Терминал"}</span><small>Ctrl+`</small></button>
        <button role="menuitem" disabled={!store.workspaceToolsAvailable()} onClick={() => action(() => store.setLayout({ rightOpen: !l.rightOpen }))}><Icon name="panel" size={17}/><span>{l.rightOpen ? "Скрыть изменения" : "Изменения и файлы"}</span></button>
        <div role="separator"/>
        {session && !archive && <button role="menuitem" disabled={!ready || !RUNTIME_CAPABILITIES.fork} onClick={() => action(() => store.setUi({ handoffSource: session }))}><Icon name="handoff" size={17}/><span>Передать задание</span></button>}
        <button role="menuitem" onClick={() => action(() => setRecovery(true))}><Icon name="refresh" size={17}/><span>Журнал отправок и восстановление</span></button>
        {s.ui.vcs?.branch && <div className="chat-actions-branch" title={s.ui.vcs.branch}><Icon name="branch" size={14}/><span>{s.ui.vcs.branch}</span></div>}
      </div>
    </FloatingPopover>}
    {recovery && <RecoveryCenter key={workspace} workspace={workspace} close={() => { setRecovery(false); anchor.current?.focus(); }}/>}
  </header>;
}
