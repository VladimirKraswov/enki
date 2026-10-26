import {SessionSpinner} from "./SessionSpinner";
import {taskScheduler} from "../schedules/tasks";
import {activeTimers, directoryTimers} from "../schedules/indicators";
import {TimerBadge} from "./TimerBadge";
import {ScheduleDialog} from "./ScheduleDialog";
import { UpdateBadge } from "../updates/runtime";
import { InformationDialog } from "./InformationDialog";
import enkiMark from "../assets/enki-icon.png";
import { modKeyLabel } from "../native/platform";
import { ProjectActions, RemovedProjects } from "./ProjectActions";
import { HostPicker, pickProjectFolder } from "./WorkspacePicker";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Session } from "../api/types";
import { store, useAppSelector } from "../state/store";
import { FloatingPopover } from "./FloatingPopover";
import { Icon } from "./Icon";
import { pathBasename } from "../util/paths";
import { isNative } from "../native/platform";
import { WORKSHOP_TITLE } from "../workshop/workspace";
import { liveStatusConfirmed, sessionWorkMark } from "../state/sidebar";
export const pickFolder = pickProjectFolder;

function ActivityMark({ id, directory, pending = false }: { id: string; directory: string; pending?: boolean }) {
  const scheduler=taskScheduler();
  const tasks=useSyncExternalStore(scheduler.subscribe,scheduler.snapshot);
  const timers=activeTimers(tasks,id);
  const status = store.activityStatus(id);
  const mark = sessionWorkMark(pending, status?.type, liveStatusConfirmed(store.state.connection, directory, store.state.directory));
  if (mark === "waiting") return <span className="pending-dot waiting-for-user" role="status" aria-label="Ожидает вашего ответа" title="Ожидает вашего ответа">!</span>;
  if (mark === "unconfirmed") return <span className="pending-dot connection-pending" role="status" aria-label="Нет свежего статуса задачи" title="Восстанавливаем связь. Статус задачи пока не подтверждён."><Icon name="connectionLost" size={13}/></span>;
  if (mark === "working") return <SessionSpinner/>;
  if (store.state.chat.sessions[id]?.lastError || tasks.some(t=>t.sessionID===id&&t.state==="error"))
    return <span className="pending-dot" aria-label="Требуется внимание" title="Проверьте ответ, ошибку или расписание чата">!</span>;
  return <>{store.isUnread(id) && <span className="unread-dot" role="status" aria-label="Задача завершена, результат не прочитан" />}
    <TimerBadge tasks={timers} label="Запланировано пробуждение"/></>;
}

/** Collapsed projects still advertise a timer so it is not hidden behind the disclosure. */
function ProjectTimerMark({ directory }: { directory: string }) {
  const scheduler=taskScheduler();
  const tasks=useSyncExternalStore(scheduler.subscribe,scheduler.snapshot);
  return <TimerBadge tasks={directoryTimers(tasks,directory)} label="В проекте есть таймер" size={13} className="project-timer"/>;
}

const sidebarSnapshot = (s: import('../state/types').AppState) => ({
  prefs:s.prefs, connection:s.connection, directory:s.directory, activeSessionId:s.activeSessionId,
  projects:s.projects, projectSessionLists:s.projectSessionLists,
  recentSessionList:s.recentSessionList, sessions:s.sessions, archivedSessions:s.archivedSessions,
  activityStatuses:s.activityStatuses,
  pending:Object.keys(s.chat.permissions).join('|')+';'+Object.keys(s.chat.questions).join('|'),
});
export function Sidebar() {
  const s = useAppSelector(sidebarSnapshot);
  const [timersOpen,setTimersOpen]=useState(false);
  const [information,setInformation] = useState<Session|null>(null);
  const [archived, setArchived] = useState(false),
    [menu, setMenu] = useState<string | null>(null),
    [rename, setRename] = useState<Session | null>(null),
    [title, setTitle] = useState(""),
    [all, setAll] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null);
  const projectName = pathBasename;
  const pinned = s.prefs.pinnedProjects ?? [];
  const dirs = store.projectDirectories().sort((a, b) => {
    const ai = pinned.indexOf(a), bi = pinned.indexOf(b);
    return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) ||
      Number(b.startsWith("/Volumes/")) - Number(a.startsWith("/Volumes/")) ||
      projectName(a).localeCompare(projectName(b)) || a.localeCompare(b);
  });
  const [shownByProject, setShownByProject] = useState<Record<string, number>>({});
  const [recentCount, setRecentCount] = useState(8);
  const [openingWorkshop, setOpeningWorkshop] = useState(false);
  const expandedKey = JSON.stringify(dirs.filter((dir) => store.isProjectExpanded(dir)));
  const hostKey = s.prefs.workspaceKey ?? s.prefs.endpoint;
  // Every chat list comes from the connected runtime; there is no separate local agent catalogue.
  useEffect(() => {
    if (isNative() && (s.prefs.activeHost ?? "local") === "local" && s.connection.phase === "connected" && !s.prefs.workshop)
      void store.ensureWorkshop().catch(() => {});
  }, [s.connection.phase, hostKey, s.prefs.workshop]);
  useEffect(() => {
    if (s.connection.phase === "connected") void store.loadRecentSessions(archived);
  }, [s.connection.phase, hostKey, archived]);
  useEffect(() => {
    if (s.connection.phase === "connected") {
      for (const dir of JSON.parse(expandedKey) as string[]) void store.loadProjectSessions(dir);
    }
  }, [s.connection.phase, hostKey, expandedKey]);
  useEffect(() => { setMenu(null); setRename(null); setShownByProject({}); setRecentCount(8); }, [hostKey]);
  const row = (sess: Session, prefix: string, recent = false) => {
    if (store.isWorkshopSession(sess)) return null;
    const rowKey = `${prefix}:${sess.id}`;
    const isArchived = Boolean(sess.time.archived);
    const pending = store.pendingInteraction(sess.id);
    return (
      <div className="session-row-wrap" key={rowKey}>
        <button
          className={`session-item${s.activeSessionId === sess.id ? " active" : ""}`}
          onClick={() => {
            setMenu(null);
            if (!isArchived) void store.openChat(sess);
          }}
          title={sess.title}
        >
          <Icon name="chat" size={15} />
          <span className="title">{sess.title}{recent && <small className="session-project">{store.isProjectlessDirectory(sess.directory) ? "Без проекта" : projectName(sess.directory)}</small>}</span>
          <span className="session-indicators"><ActivityMark id={sess.id} directory={sess.directory} pending={pending.permissions.length + pending.questions.length > 0} /></span>
        </button>
        <button className="task-menu" aria-label={`Действия: ${sess.title}`} onClick={event=>{setMenuAnchor(event.currentTarget);setMenu(menu===rowKey?null:rowKey);}}><Icon name="dots" size={16}/></button>
        {menu === rowKey && (
          <FloatingPopover
            anchor={menuAnchor}
            className="task-popover"
            role="menu"
            label="Действия задачи"
            width={180}
            placement="bottom"
            align="end"
            onClose={() => setMenu(null)}
          >
            <button
              onClick={() => {
                setRename(sess);
                setTitle(sess.title);
                setMenu(null);
              }}
            >
              Переименовать
            </button>
            <button onClick={() => {setMenu(null);setInformation(sess);}}>Сведения</button>
            <button onClick={() => { setMenu(null); store.setUi({ handoffSource: sess }); }}>Передать задание…</button>
            <button
              onClick={() => {
                if(isArchived)void store.unarchiveSession(sess);else void store.archiveSession(sess);
                setMenu(null);
              }}
            >
              {isArchived?"Восстановить":"В архив"}
            </button>
            <button
              className="danger-text"
              onClick={() => {
                store.setUi({ confirmDelete: sess });
                setMenu(null);
              }}
            >
              Удалить…
            </button>
          </FloatingPopover>
        )}
      </div>
    );
  };
  const recent = s.recentSessionList;
  const visibleRecent = recent.sessions.filter((session) => !store.isProjectHidden(session.directory) && !store.isWorkshopSession(session));
  return (
    <aside
      className="sidebar"
      style={{ width: s.prefs.layout.sidebarWidth }}
      aria-label="Проекты и задачи"
    >
      {information&&<InformationDialog directory={information.directory} session={information} onClose={()=>setInformation(null)}/>}
      <div className="sidebar-brand" data-tauri-drag-region="deep">
        <img src={enkiMark} width={24} height={24} alt="" />
        <strong>Enki</strong>
        <span className="spacer" />
        <button
          className="icon-btn"
          aria-label="Скрыть боковую панель"
          onClick={() => store.setLayout({ sidebarOpen: false })}
        >
          <Icon name="sidebar" size={17} />
        </button>
      </div>
      <nav className="sidebar-nav">
        <button
          onClick={() => {
            void store.newSession();
          }}
        >
          <Icon name="new" />
          Новый чат<kbd>{modKeyLabel()} N</kbd>
        </button>
        <button onClick={() => store.setUi({ paletteOpen: true })}>
          <Icon name="search" />
          Поиск<kbd>{modKeyLabel()} K</kbd>
        </button>
      </nav>
      <div className="sidebar-host">
        <HostPicker compact />
      </div>
      <button className="sidebar-timers" onClick={()=>setTimersOpen(true)}><Icon name="clock" size={16}/><span>Таймеры и наблюдение</span></button>
      {timersOpen && <ScheduleDialog onClose={()=>setTimersOpen(false)}/>}
      <div className="workshop-entry">
        <button className={`workshop-button${s.activeSessionId === s.prefs.workshop?.session.id ? " active" : ""}`}
          aria-label={WORKSHOP_TITLE} aria-busy={openingWorkshop} disabled={openingWorkshop}
          onClick={async () => { setOpeningWorkshop(true); try { await store.openWorkshop(); } finally { setOpeningWorkshop(false); } }}>
          <Icon name="code" size={18}/><span className="workshop-title">{WORKSHOP_TITLE}</span>
          {s.prefs.workshop && <span className="session-indicators"><ActivityMark id={s.prefs.workshop.session.id} directory={s.prefs.workshop.directory}/></span>}
          <Icon name="lock" size={12}/>
        </button>
      </div>
      <div className="sidebar-scroll">
        <div className="section-label">
          <span>Проекты</span>
          <button className="icon-btn" aria-label="Добавить проект" title="Открыть папку" onClick={() => void pickFolder()}><Icon name="plus" size={16} /></button>
          <button className="icon-btn" aria-label="Обновить проекты" onClick={() => {
            void store.refreshProjects();
            for (const dir of dirs) if (store.isProjectExpanded(dir)) void store.loadProjectSessions(dir, { force: true });
            void store.loadRecentSessions(archived);
          }}><Icon name="refresh" size={14} /></button>
        </div>
        {(all ? dirs : dirs.slice(0, 7)).map((dir) => {
          const expanded = store.isProjectExpanded(dir);
          const list = s.projectSessionLists[dir];
          const sessions = list?.sessions.filter((session) => !session.time.archived) ?? [];
          const shown = shownByProject[dir] ?? 8;
          const name = projectName(dir);
          return <section className="project-group" key={dir} aria-label={`Проект ${name}`}>
            <div className="project-heading">
              <button className={`project-row${dir === s.directory ? " selected" : ""}`} title={dir} aria-label={name} aria-expanded={expanded}
                onClick={() => { setMenu(null); store.toggleProject(dir); }}>
                <Icon name={expanded ? "down" : "chevron"} size={12} />
                <Icon name="folder" size={17} />
                <span className="project-name">{name}</span>
                {!expanded && <ProjectTimerMark directory={dir}/>}
                {!expanded && store.hasRunningInDirectory(dir) && (liveStatusConfirmed(s.connection, dir, s.directory)
                  ? <SessionSpinner label="В проекте выполняется задача"/>
                  : <span className="pending-dot" role="status" aria-label="Нет свежего статуса проекта">?</span>)}
                {!expanded && store.hasUnreadInDirectory(dir) && <span className="unread-dot" role="status" aria-label="Есть непрочитанные результаты" />}
              </button>
              <button className="project-new icon-btn" aria-label={`Новый чат в ${name}`} title="Новый чат в проекте" onClick={() => void store.setDirectory(dir)}><Icon name="plus" size={15} /></button>
              <ProjectActions directory={dir} />
            </div>
            {expanded && <div className="project-sessions" aria-label={`Сессии ${name}`}>
              {sessions.filter((sess, index) => index < shown || store.isUnread(sess.id) || store.isRunning(sess.id)).map((sess) => row(sess, dir))}
              {list?.loading && <div className="empty-hint" role="status">Загрузка…</div>}
              {list?.error && <div className="empty-hint" role="alert">Не удалось загрузить сессии. <button title={list.error} onClick={() => void store.loadProjectSessions(dir, { force: true })}>Повторить</button></div>}
              {list?.loaded && !list.loading && !list.error && sessions.length === 0 && <button className="project-empty" onClick={() => void store.setDirectory(dir)}>Начать первый чат</button>}
              {(sessions.length > shown || list?.hasMore) && <button className="show-more" disabled={list?.loading} onClick={() => {
                setShownByProject((prev) => ({ ...prev, [dir]: shown + 20 }));
                if (shown + 20 >= sessions.length && list?.hasMore) void store.loadProjectSessions(dir, { more: true });
              }}>Ещё сессии</button>}
            </div>}
          </section>;
        })}
        {dirs.length > 7 && <button className="show-more" onClick={() => setAll(!all)}>{all ? "Меньше проектов" : `Все проекты (${dirs.length})`}</button>}
        {dirs.length === 0 && <button className="project-empty" onClick={() => void pickFolder()}>Открыть папку проекта<Icon name="plus" size={16} /></button>}
        <RemovedProjects />
        <section className="recent-sessions" aria-label={archived ? "Архив" : "Недавние"}>
          <div className="section-label task-heading">
            <span>{archived ? "Архив" : "Недавние"}</span>
            <button className={`icon-btn${archived ? " on" : ""}`} title={archived ? "Показать недавние" : "Архив всех проектов"} aria-label={archived ? "Показать недавние" : "Показать архив"} onClick={() => { setArchived(!archived); setRecentCount(8); }}><Icon name="archive" size={15} /></button>
          </div>
          {recent.archived === archived && visibleRecent.slice(0, recentCount).map((sess) => row(sess, "recent", true))}
          {recent.loading && <div className="empty-hint" role="status">Загрузка…</div>}
          {recent.error && <div className="empty-hint" role="alert">Не удалось загрузить сессии. <button title={recent.error} onClick={() => void store.loadRecentSessions(archived)}>Повторить</button></div>}
          {recent.loaded && !recent.loading && !recent.error && visibleRecent.length === 0 && <div className="empty-hint">{archived ? "Архив пуст" : "Здесь появятся ваши недавние чаты"}</div>}
          {(visibleRecent.length > recentCount || recent.hasMore) && <button className="show-more" disabled={recent.loading} onClick={() => {
            setRecentCount(recentCount + 20);
            if (recentCount + 20 >= visibleRecent.length && recent.hasMore) void store.loadRecentSessions(archived, true);
          }}>Показать ещё</button>}
        </section>
      </div>
      <div className="sidebar-footer">
        <button
          className="profile-button"
          onClick={() => store.setUi({ settingsOpen: true })}
        >
          <span className="profile-avatar">
            <Icon name="code" size={17} />
          </span>
          <span>
            <b>Enki</b>
            <small>
              <i
                className={`conn-dot ${s.connection.phase === "connected" ? "ok" : "bad"}`}
              />
              {s.connection.phase === "connected"
                ? `${store.currentHost() ? "SSH" : "Локально"} · ${s.connection.version}`
                : "Нет подключения"}
            </small>
          </span>
          <Icon name="settings" size={17} />
        </button>
        <UpdateBadge />
      </div>
      {rename && (
        <div
          className="modal-overlay"
          onKeyDown={(e) => {
            if (e.key === "Escape") setRename(null);
          }}
        >
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Переименовать задачу"
            onSubmit={(e) => {
              e.preventDefault();
              if (title.trim()) void store.renameSession(rename, title.trim());
              setRename(null);
            }}
          >
            <h3>Название задачи</h3>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <div className="btn-row">
              <button
                type="button"
                className="btn"
                onClick={() => setRename(null)}
              >
                Отмена
              </button>
              <button className="btn primary">Сохранить</button>
            </div>
          </form>
        </div>
      )}
    </aside>
  );
}
