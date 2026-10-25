import { useEffect, useRef, useState } from "react";
import type { Session } from "../api/types";
import { store, useAppState } from "../state/store";
import { deliverHandoff, handoffConnection, handoffText, prepareHandoff, recipientProfile,
  type HandoffConnection, type HandoffSource, type DeliveryReceipt } from "../state/handoff";
import { Icon } from "./Icon";
import { pathBasename } from "../util/paths";

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const folderName = pathBasename;

export function HandoffDialog() {
  const s = useAppState();
  const source = s.ui.handoffSource;
  return source ? <HandoffForm key={`${s.prefs.workspaceKey ?? s.prefs.endpoint}:${source.id}`} session={source} /> : null;
}
function HandoffForm({ session }: { session: Session }) {
  const s = useAppState();
  const [source] = useState<HandoffSource>(() => ({ session, connection: {
    client: store.backend, key: s.prefs.workspaceKey ?? s.prefs.endpoint,
    hostId: s.prefs.activeHost ?? "local", label: store.hostLabel(),
  } }));
  const [host, setHost] = useState(source.connection.hostId);
  const [connection, setConnection] = useState<HandoffConnection | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [directory, setDirectory] = useState("");
  const [search, setSearch] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [selected, setSelected] = useState<Session | null>(null);
  const [context, setContext] = useState("");
  const [instruction, setInstruction] = useState("");
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [contextReady, setContextReady] = useState(false);
  const prepareController = useRef<AbortController | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<DeliveryReceipt | "draft" | null>(null);
  const [retry, setRetry] = useState(0);
  const locked = useRef(false), generation = useRef(0);
  const frozen = sending || preparing || !!receipt;
  const close = () => { if (!locked.current) { prepareController.current?.abort(); store.setUi({ handoffSource: null }); } };

  useEffect(() => () => { prepareController.current?.abort(); }, []);

  const prepare = async () => {
    if (prepareController.current || !selected || !connection || locked.current) return;
    if (Object.values(store.state.activityStatuses).some((status) => status.type !== "idle")) {
      setError("Агент выполняет задачу. Дождитесь завершения или заполните пакет вручную."); return;
    }
    const ctrl = new AbortController(); prepareController.current = ctrl;
    setPreparing(true); setContextReady(false); setError("");
    try {
      const profile = recipientProfile(store.state.prefs, source.connection.key, source.session);
      if (store.state.activeSessionId === source.session.id && source.connection.key === (store.state.prefs.workspaceKey ?? store.state.prefs.endpoint)) {
        const choice = store.getModelChoice();
        // The runtime has one agent profile; only model and variant are per turn.
        if (choice) { profile.model = { providerID: choice.providerID, modelID: choice.modelID }; profile.variant = choice.variant ?? null; }
      }
      const text = await prepareHandoff(source, instruction, selected, connection, profile, ctrl.signal);
      if (!ctrl.signal.aborted) { setContext(text); setContextReady(true); }
    } catch (e) { setError(errorText(e)); }
    finally { prepareController.current = null; setPreparing(false); }
  };

  useEffect(() => {
    let live = true;
    generation.current++;
    setConnection(null); setSelected(null); setSessions([]); setCursor(null); setProjects([]); setLoading(true); setError("");
    void handoffConnection(store.state.prefs, store.backend, host).then(async (target) => {
      const list = await target.client.projects();
      if (!live) return;
      const prefs = target.key === (store.state.prefs.workspaceKey ?? store.state.prefs.endpoint)
        ? store.state.prefs : store.state.prefs.endpointState?.[target.key];
      setProjects([...new Set([...list.map((p) => p.worktree), ...(prefs?.pinnedProjects ?? []), ...(prefs?.hiddenProjects ?? [])])].filter((p) => p && p !== "/").sort());
      setConnection(target);
    }).catch((e) => { if (live) { setError(`Не удалось подключиться: ${errorText(e)}`); setLoading(false); } });
    return () => { live = false; generation.current++; };
  }, [host, retry]);

  useEffect(() => {
    if (!connection) return;
    let live = true;
    const request = ++generation.current;
    setLoading(true); setSelected(null); setError(""); setSessions([]); setCursor(null);
    const timer = setTimeout(() => {
      void connection.client.recentSessions(false, undefined, { search: search.trim() || undefined, directory: directory || undefined })
        .then((page) => {
          if (!live || request !== generation.current) return;
          setSessions(page.sessions.filter((x) => !x.parentID && !x.time.archived && (!directory || x.directory === directory) && !(connection.key === source.connection.key && x.id === source.session.id)));
          setCursor(page.cursor);
          setProjects((prev) => [...new Set([...prev, ...page.sessions.map((x) => x.directory)])].sort());
        }).catch((e) => { if (live && request === generation.current) setError(errorText(e)); })
        .finally(() => { if (live && request === generation.current) setLoading(false); });
    }, 200);
    return () => { live = false; clearTimeout(timer); generation.current++; };
  }, [connection, search, directory, source]);

  const more = async () => {
    if (!connection || cursor === null || loading) return;
    const request = generation.current; setLoading(true); setError("");
    try {
      const page = await connection.client.recentSessions(false, cursor, { search: search.trim() || undefined, directory: directory || undefined });
      if (request !== generation.current) return;
      setSessions((prev) => [...new Map([...prev, ...page.sessions].map((x) => [x.id, x])).values()]
        .filter((x) => !x.parentID && !x.time.archived && (!directory || x.directory === directory) && !(connection.key === source.connection.key && x.id === source.session.id)));
      setCursor(page.cursor);
    } catch (e) { if (request === generation.current) setError(errorText(e)); }
    finally { if (request === generation.current) setLoading(false); }
  };

  const submit = async (draft: boolean) => {
    if (locked.current || prepareController.current || preparing || !contextReady || receipt || !connection || !selected) return;
    locked.current = true; setSending(true); setError("");
    try {
      if (draft) {
        const fresh = await connection.client.getSession(selected.id, selected.directory);
        if (fresh.directory !== selected.directory || fresh.time.archived || fresh.parentID) throw new Error("Получатель больше не доступен. Выберите другую сессию.");
        store.saveHandoffDraft(connection.key, fresh, handoffText(source, instruction, context));
        setReceipt("draft");
      } else {
        setReceipt(await deliverHandoff(connection, selected, source, instruction, context, store.state.prefs));
      }
    } catch (e) { setError(errorText(e)); }
    finally { locked.current = false; setSending(false); }
  };
  const openTarget = async () => {
    if (!connection || !selected || locked.current) return;
    locked.current = true; setSending(true);
    try {
      if (connection.key !== (store.state.prefs.workspaceKey ?? store.state.prefs.endpoint)) {
        if (!await store.connectHost(connection.hostId)) throw new Error("Не удалось открыть компьютер получателя.");
      }
      if (connection.key !== (store.state.prefs.workspaceKey ?? store.state.prefs.endpoint)) throw new Error("Подключение изменилось. Откройте получателя вручную.");
      await store.openChat(selected);
      store.setUi({ handoffSource: null });
    } catch (e) { setError(errorText(e)); }
    finally { locked.current = false; setSending(false); }
  };

  return <div className="modal-overlay" onKeyDown={(e) => { if (e.key === "Escape") close(); }}>
    <div className="modal handoff-modal" role="dialog" aria-modal="true" aria-label="Передать задание в другую сессию">
      <div className="handoff-heading"><h3>Передать задание</h3><button className="icon-btn" aria-label="Закрыть передачу" disabled={sending} onClick={close}><Icon name="close" /></button></div>
      <p className="handoff-source">Из «{source.session.title}» · {source.connection.label}<small className="project-path">{source.session.directory}</small></p>
      {!receipt && <>
        <div className="handoff-filters">
          <label>Компьютер получателя<select value={host} disabled={frozen} onChange={(e) => { setHost(e.target.value); setDirectory(""); setSearch(""); }}><option value="local">Этот компьютер</option>{s.prefs.remoteHosts?.map((h) => <option key={h.id} value={h.id}>{h.name} · {h.target}</option>)}</select></label>
          <label>Проект<select aria-label="Проект получателя" value={directory} disabled={frozen || !connection} onChange={(e) => setDirectory(e.target.value)}><option value="">Все проекты и чаты</option>{projects.map((dir) => <option key={dir} value={dir}>{folderName(dir)} — {dir}</option>)}</select></label>
        </div>
        <input autoFocus aria-label="Найти сессию получателя" placeholder="Поиск по названию сессии…" value={search} disabled={frozen} onChange={(e) => setSearch(e.target.value)} />
        <div className="handoff-targets" aria-label="Сессии получателя">{sessions.map((item) => <button key={item.id} className={`handoff-target${selected?.id === item.id ? " selected" : ""}`} aria-pressed={selected?.id === item.id} disabled={frozen} onClick={() => { if (selected?.id !== item.id) setContextReady(false); setSelected(item); }}>
          <Icon name="chat" size={16} /><span><b>{item.title}</b><small>{item.directory}</small></span>{selected?.id === item.id && <Icon name="check" size={16} />}
        </button>)}</div>
        {loading && <p className="empty-hint" role="status">Загрузка сессий…</p>}
        {!loading && !error && !sessions.length && <p className="empty-hint">Сессий не найдено. Измените поиск или выберите другой проект.</p>}
        {cursor !== null && <button className="show-more" disabled={loading || frozen} onClick={() => void more()}>Ещё сессии</button>}
        <label>Поручение<textarea aria-label="Поручение получателю" placeholder="Что нужно сделать в другой сессии…" value={instruction} maxLength={8000} disabled={frozen} onChange={(e) => { setInstruction(e.target.value); setContextReady(false); }} rows={3} /></label>
        <div className="handoff-prepare">
          <button className="btn" disabled={sending || preparing || !selected || !instruction.trim()} onClick={() => void prepare()}>Собрать важный контекст</button>
          {preparing && <><span role="status">Агент готовит пакет по истории задачи…</span><button className="btn small" onClick={() => prepareController.current?.abort()}>Остановить подготовку</button></>}
        </div>
        <label>Пакет передачи <small>{context.length.toLocaleString()} / 24 000 символов</small><textarea aria-label="Контекст для передачи" placeholder="Соберите пакет кнопкой выше или заполните вручную: цель, решения, состояние, машины и доступы, файлы, проверки, следующий шаг." value={context} maxLength={24000} disabled={frozen} onChange={(e) => { setContext(e.target.value); setContextReady(!!e.target.value.trim()); }} rows={6} /></label>
        <p className="handoff-note">Агент соберёт важное из доступной истории в отдельной служебной копии чата. Проверьте пакет перед отправкой. Можно отредактировать его вручную. Черновик добавится к уже набранному тексту получателя и не запустит его агента.</p>
        {selected && <p className="handoff-destination">Куда: <b>{selected.title}</b> · {connection?.label}<small className="project-path">{selected.directory}</small></p>}
      </>}
      {receipt && <div className="handoff-receipt" role="status">
        <h4>{receipt === "draft" ? "Черновик сохранён" : receipt.state === "accepted" ? "Задание передано" : "Доставка не подтверждена"}</h4>
        <p>{selected?.title} · {connection?.label}</p>
        <p>{receipt === "draft" ? "Откройте сессию, проверьте черновик и отправьте его, когда будете готовы." : receipt.state === "accepted" ? "Среда выполнения получателя приняла поручение. Ход выполнения и ответ появятся в сессии получателя." : "Ответ сервера потерялся. Сообщение могло быть принято. Откройте сессию и проверьте историю перед повторной отправкой."}</p>
      </div>}
      {error && <p className="handoff-error" role="alert">{error}{!connection && <button className="btn small" disabled={sending} onClick={() => setRetry(retry + 1)}>Повторить подключение</button>}</p>}
      <div className="btn-row">
        <button className="btn" disabled={sending} onClick={close}>{receipt ? "Закрыть" : "Отмена"}</button>
        {receipt ? <button className="btn primary" disabled={sending} onClick={() => void openTarget()}>Открыть сессию</button> : <>
          <button className="btn" disabled={frozen || loading || !selected || !instruction.trim() || !contextReady} onClick={() => void submit(true)}>Сохранить черновик</button>
          <button className="btn primary" disabled={frozen || loading || !selected || !instruction.trim() || !contextReady} onClick={() => void submit(false)}>{sending ? "Передача…" : "Отправить и начать"}</button>
        </>}
      </div>
    </div>
  </div>;
}
