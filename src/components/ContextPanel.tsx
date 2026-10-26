import { useEffect, useRef, useState } from "react";
import { store, useAppState } from "../state/store";
import { safeLabel, sessionContext, subagentRuns, type ContextFile, type SubagentRun } from "../state/taskContext";
import { taskScheduler } from "../schedules/tasks";
import { attachmentScope } from "../attachments/drafts";
import { focusComposer, requestComposerFiles } from "../attachments/composerBridge";
import type { Session, SessionStatus } from "../api/types";
import { sessionOf } from "../agent/runtime/backend";
import { RUNTIME_AGENT_ID } from "../agent/runtime/ids";
import type { EngineId } from "../state/engines";
import { ScheduleSection } from "./ScheduleSection";
import { TaskDiagnostics } from "./TaskDiagnostics";
import { OutcomeSection } from "./OutcomeSection";
import { MemorySection } from "./MemorySection";
import { ProjectMapSection } from "./ProjectMapSection";
import type { Outcome } from "../outcomes/store";
import { AttachmentThumbnail, AttachmentViewer } from "./AttachmentViewer";
import { Icon } from "./Icon";
import { skillAuthoringRequest } from "../capabilities/authoring";

export const CONTEXT_PANEL_ID = "chat-context-panel";
const PREVIEW = 3;
const CHILD_POLL_MS = 10_000;

/** Everything in the panel belongs to one server/folder/chat/engine; switching any of them remounts it. */
export function ContextPanel({ active = true }: { active?: boolean } = {}) {
  const s = useAppState();
  const server = s.prefs.workspaceKey ?? s.prefs.endpoint, sid = s.activeSessionId, directory = s.directory;
  const engine = store.engineIdFor();
  return <ContextContents key={JSON.stringify([server, s.prefs.endpoint, directory, sid, engine])} server={server} sid={sid} directory={directory} engine={engine} active={active} />;
}

// Result cards persist the historical agent tag (OutcomeScope "pi" | "opencode");
// every chat runs on the one runtime, whose persisted tag is RUNTIME_AGENT_ID.
// `engine` only keys the remount above.
function ContextContents({ server, sid, directory, active }: { server: string; sid: string | null; directory: string | null; engine: EngineId; active: boolean }) {
  const s = useAppState(), panel = useRef<HTMLElement>(null);
  const scheduler = taskScheduler();
  const chat = sid ? s.chat.sessions[sid] : undefined;
  // The reducer retains the chat container while replacing changed parts.
  // Cache individual part facts, not the mutable container, so streams stay live.
  const context = sessionContext(chat);
  const runs = subagentRuns(chat);
  const scope = attachmentScope(server, directory, sid);
  const [notice, setNotice] = useState("");
  const [proposed, setProposed] = useState<Outcome | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const close = () => store.setUi({ contextOpen: false });

  useEffect(() => {
    if (!active) return;
    const node = panel.current, prior = document.activeElement as HTMLElement | null;
    // The rail may still have its closed visibility at commit time. Focus after
    // layout so keyboard navigation enters the newly revealed panel reliably.
    const frame = requestAnimationFrame(() => node?.focus({ preventScroll: true }));
    // Some WebViews complete button activation after the first frame. Do not
    // steal focus if the user has already moved to another control meanwhile.
    const settled = setTimeout(() => {
      if (document.activeElement === prior) node?.focus({ preventScroll: true });
    }, 240);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settled);
      // Return focus only if it would otherwise be lost; a jump to a message keeps its own focus.
      const active = document.activeElement;
      if (prior?.isConnected && (!active || active === document.body || node?.contains(active))) prior.focus();
    };
  }, [active]);

  const jump = (messageID: string) => { if (sid) store.setUi({ revealMessage: { server, directory, sessionID: sid, messageID }, contextOpen: false }); };
  const draftResult = () => {
    const draft = store.getDraft();
    store.setDraft(`${draft}${draft.trim() ? "\n\n" : ""}Создай файл с результатом: `);
    close();
    focusComposer(scope);
  };
  const draftSkill = () => {
    const draft = store.getDraft();
    store.setDraft(`${draft}${draft.trim() ? "\n\n" : ""}${skillAuthoringRequest()}`);
    close();
    focusComposer(scope);
  };
  const addSource = () => {
    // Must stay synchronous: the WebView opens a chooser only during the user's click.
    if (requestComposerFiles(scope)) setNotice("");
    else setNotice("Поле ввода этого чата сейчас не принимает файлы. Дождитесь завершения отправки или переподключения.");
  };
  const moreHistory = !!sid && !!s.historyCursors?.[sid] && !s.olderExhausted?.[sid];

  return <aside id={CONTEXT_PANEL_ID} className="context-panel" ref={panel} tabIndex={-1} aria-labelledby="context-panel-title"
    onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
    <div className="context-panel-header">
      <h2 id="context-panel-title">В этом чате</h2>
      <button className="icon-btn" aria-label="Закрыть контекст задачи" onClick={close}><Icon name="close" size={16}/></button>
    </div>
    {!sid && <p className="context-note">Откройте чат.</p>}
    <ScheduleSection scheduler={scheduler} server={server} directory={directory} sessionID={sid} />
    {sid && <details className="context-disclosure"><summary>Запросы и подтверждения</summary>
    {sid && <OutcomeSection scope={{server,directory:directory??"",sessionID:sid,engine:RUNTIME_AGENT_ID}} requests={(chat?.messageOrder??[]).filter(id=>chat?.messages[id]?.role==="user").map(id=>({id,label:safeLabel((chat?.partsByMessage[id]??[]).map(p=>chat?.parts[p]).filter(p=>p?.type==="text"&&!p.synthetic).map(p=>p?.text??"").join(" "),100)}))} onOpen={jump} onPropose={card=>{setProposed({...card});setToolsOpen(true);}}/>}
    </details>}
    <FileSection id="results" title="Результаты" files={context.results} empty="Результатов пока нет."
      action={{ label: "Подготовить запрос на создание результата", disabled: !sid, run: draftResult }}
      icon="file" describe={resultOrigin} onOpen={jump} />
    <ChildrenSection sid={sid} directory={directory} connected={s.connection.phase === "connected"} runs={runs} />
    <FileSection id="sources" title="Источники" files={context.sources} empty="Источников пока нет."
      action={{ label: "Добавить источник в черновик", disabled: !sid || !!s.ui.sending, run: addSource }}
      icon="folder" describe={f => f.mime ? `Вложение · ${safeLabel(f.mime, 60)}` : "Вложение"} onOpen={jump} />
    <details className="context-disclosure" open={toolsOpen} onToggle={event => setToolsOpen(event.currentTarget.open)}><summary>Память, инструменты и диагностика</summary>
    {toolsOpen && <>
    {sid && <TaskDiagnostics chat={chat}/>}

    <MemorySection server={server} directory={directory} proposed={proposed}/>
    <ProjectMapSection server={server} directory={directory}/>
    {sid && <section aria-labelledby="context-skill-title">
      <div className="context-section-title"><h3 id="context-skill-title">Навык по опыту чата</h3></div>

      <button className="btn small ghost" onClick={draftSkill}>Подготовить создание навыка</button>
    </section>}
    </>}
    </details>
    {notice && <p className="context-error" role="alert">{notice}</p>}
    {sid && moreHistory && <p className="context-note">
      {moreHistory && <button className="btn small ghost" disabled={s.ui.historyLoading} onClick={() => void store.loadOlderMessages(sid)}>
        {s.ui.historyLoading ? "Загрузка…" : "Загрузить более раннюю историю"}</button>}</p>}
  </aside>;
}

const resultOrigin = (f: ContextFile) =>
  f.origin === "link" ? "Ссылка в ответе" : f.origin === "write" ? "Записан агентом" : f.origin === "edit" ? "Изменён агентом" : "Изменён патчем";

/** A bounded list of history pointers. Opening one reveals its exact message in the chat. */
function FileSection({ id, title, files, empty, action, icon, describe, onOpen }: {
  id: string; title: string; files: ContextFile[]; empty: string;
  action: { label: string; disabled: boolean; run: () => void };
  icon: "file" | "folder"; describe: (file: ContextFile) => string; onOpen: (messageID: string) => void;
}) {
  const [all, setAll] = useState(false);
  const [viewedFile,setViewedFile] = useState<string|null>(null);
  const [loadAll,setLoadAll] = useState(false);
  const s = useAppState(), sid=s.activeSessionId;
  const sources=id==="sources";
  const shown = all && !sources ? files : files.slice(0, PREVIEW);
  return <section aria-labelledby={`context-${id}-title`}>
    <div className="context-section-title">
      <h3 id={`context-${id}-title`}>{title} · {files.length}</h3>
      <button className="icon-btn" aria-label={action.label} title={action.label} disabled={action.disabled} onClick={action.run}><Icon name="plus" size={16}/></button>
    </div>
    {!files.length && <p className="context-note">{empty}</p>}
    {files.length > 0 && <ul className="context-list" id={`context-${id}-list`}>{shown.map(f => <li className="context-item" key={f.key}>
      {sources ? <button className="icon-btn" aria-label={`Открыть ${f.name}`} onClick={()=>{setLoadAll(false);setViewedFile(f.key);}}><AttachmentThumbnail file={f}/></button> : <Icon name={icon} size={16}/>}
      <div>
        <button className="context-file" title={`${f.path ? safeLabel(f.path, 600) : f.name}\n${sources ? "Открыть файл" : "Перейти к сообщению"}`} onClick={() => sources ? (setLoadAll(false),setViewedFile(f.key)) : onOpen(f.messageID)}>{f.name}</button>
        <small>{describe(f)}</small>
      </div>
    </li>)}</ul>}
    {sources && viewedFile && <AttachmentViewer files={files} initialKey={viewedFile} loadAll={loadAll} historyCursor={sid ? s.historyCursors?.[sid] : null} onClose={()=>setViewedFile(null)} hasMore={!!sid && !!s.historyCursors?.[sid] && !s.olderExhausted?.[sid]} loading={s.ui.historyLoading} historyError={s.ui.historyError} loadMore={()=>sid && void store.loadOlderMessages(sid)}/>}
    {(files.length > PREVIEW || sources && !!sid && !!s.historyCursors?.[sid] && !s.olderExhausted?.[sid]) && <button className="btn small ghost" aria-expanded={all} aria-controls={`context-${id}-list`} onClick={() => {if(sources){setLoadAll(true);setViewedFile(files[0]?.key??"all");}else setAll(!all);}}>
      {all ? "Свернуть" : `Показать все (${files.length})`}</button>}
  </section>;
}

const liveLabel = (status?: SessionStatus) =>
  status?.type === "busy" ? "работает" : status?.type === "retry" ? "повтор подключения" : status?.type === "waiting" ? "ждёт ответа" : "неактивна";
const runLabel: Record<SubagentRun["status"], string> = {
  pending: "запускается", running: "выполняется", completed: "вернул ответ", error: "вызов завершился ошибкой",
};

/**
 * Child sessions the runtime lists (GET /sessions/:id/children). Only children a
 * `task` call reported are called subagents; the rest may be forks.
 */
function ChildrenSection({ sid, directory, connected, runs }: {
  sid: string | null; directory: string | null; connected: boolean; runs: Map<string, SubagentRun>;
}) {
  const { children, statuses, error, loading } = useChildSessions(connected ? sid : null, directory);
  const [all, setAll] = useState(false);
  const list = children ?? [];
  const shown = all ? list : list.slice(0, PREVIEW);
  return <section aria-labelledby="context-children-title" aria-busy={loading || undefined}>
    <div className="context-section-title">
      <h3 id="context-children-title">Субагенты и ветки{sid && ` · ${children ? children.length : "…"}`}</h3>
      {loading && <span className="tool-spinner" role="status" aria-label="Загрузка"/>}
    </div>
    {!sid ? null
      : !connected && !children ? <p className="context-note">Список появится после подключения к среде выполнения.</p>
      : error ? <p className="context-error" role="alert">{error}</p>
      : children && !children.length && <p className="context-note">Дочерних сессий пока нет</p>}
    {list.length > 0 && <ul className="context-list" id="context-children-list">{shown.map(child => {
      const run = runs.get(child.id);
      return <li className="context-item" key={child.id}>
        <Icon name="branch" size={16}/>
        <div>
          <button className="context-file" title={`${safeLabel(child.title || child.id, 600)}\nОткрыть дочерний чат`}
            onClick={() => { store.setUi({ contextOpen: false }); void store.openChat(child); }}>{safeLabel(child.title || child.id)}</button>
          <small>{run ? `Субагент · ${runLabel[run.status]}` : "Дочерняя сессия"} · {liveLabel(statuses[child.id])}</small>
        </div>
      </li>;
    })}</ul>}
    {list.length > PREVIEW && <button className="btn small ghost" aria-expanded={all} aria-controls="context-children-list" onClick={() => setAll(!all)}>
      {all ? "Свернуть" : `Показать все (${list.length})`}</button>}
  </section>;
}

/** Polls while mounted and visible; every request is cancelled when the scope changes. */
function useChildSessions(sid: string | null, directory: string | null) {
  const [children, setChildren] = useState<Session[] | null>(null);
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});
  const [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const backend = store.maybeBackend();
  useEffect(() => {
    setChildren(null); setStatuses({}); setError("");
    if (!sid || !directory || !backend) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = () => { if (!abort.signal.aborted) timer = setTimeout(() => void read(false), CHILD_POLL_MS); };
    const read = async (initial: boolean) => {
      // A hidden window does not need fresh child lists; the next visible tick catches up.
      if (!initial && document.hidden) { next(); return; }
      setLoading(true);
      try {
        const [list, status] = await Promise.all([
          backend.client.children(sid, directory, abort.signal).then(items => items.map(sessionOf)),
          backend.sessionStatuses(directory, abort.signal),
        ]);
        if (abort.signal.aborted) return;
        setChildren(list.filter(c => c.parentID === sid && c.directory === directory && !c.time?.archived));
        setStatuses(status); setError("");
      } catch {
        if (!abort.signal.aborted) setError("Не удалось прочитать дочерние сессии. Следующая проверка через 10 секунд.");
      } finally {
        if (!abort.signal.aborted) { setLoading(false); next(); }
      }
    };
    void read(true);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [sid, directory, backend]);
  return { children, statuses, error, loading };
}
