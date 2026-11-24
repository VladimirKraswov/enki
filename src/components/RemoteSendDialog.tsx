// "Отправить в удалённую сессию": pick another Enki on the Hub, then either an
// existing chat there or a new one, and hand the text to that device's Runtime.
// Delivery is honest: the command state comes from the Hub, and a lost answer is
// never retried blindly.
import { useEffect, useRef, useState } from "react";
import type { Session } from "../api/types";
import { store, useAppState } from "../state/store";
import { Icon } from "./Icon";
import { remoteOverview, remoteCommand, sendToSession, createRemoteSession, pasteToSession, modelRef, newestSession,
  type RemoteDevice, type RemoteSession } from "../hub/remote";
import { pathBasename } from "../util/paths";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const TERMINAL = new Set(["done", "error", "failed"]);
const UUID = /^[A-Za-z0-9_.:-]{1,200}$/;

export function RemoteSendDialog() {
  const s = useAppState();
  const source = s.ui.remoteSend;
  return source ? <RemoteSendForm key={`${s.prefs.workspaceKey ?? s.prefs.endpoint}:${source.id}`} source={source} /> : null;
}

function RemoteSendForm({ source }: { source: Session }) {
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [sessionId, setSessionId] = useState("");
  const [directory, setDirectory] = useState("");
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<{ state: string; detail: string } | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const close = () => { if (!sending) { clearTimeout(poll.current); store.setUi({ remoteSend: null }); } };
  const device = devices.find(d => d.id === deviceId);
  const sessions = device?.overview?.sessions ?? [];
  const projects = device?.overview?.projects ?? [];
  const target = sessions.find(item => item.id === sessionId);
  const fallbackModel = modelRef(newestSession(device) ?? target);

  async function load() {
    setLoading(true); setError("");
    try {
      const overview = await remoteOverview();
      const list = (overview.devices ?? []).filter(d => d.online !== false && d.overview);
      setDevices(list);
      if (!deviceId && list[0]) setDeviceId(list[0].id);
    } catch (e) { setError(`${errorText(e)} Обновите подключение к Hub и повторите.`); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => () => clearTimeout(poll.current), []);
  useEffect(() => { setSessionId(""); }, [deviceId]);

  async function watch(id: string, run: boolean) {
    let failures = 0;
    const tick = async () => {
      try {
        const card = await remoteCommand(id);
        failures = 0;
        if (TERMINAL.has(card.state)) {
          const failure = (card.result as { error?: string } | null | undefined)?.error;
          setReceipt(card.state === "done" && !failure
            ? { state: "accepted", detail: run
                ? "Устройство приняло запрос и запустило работу."
                : "Текст доставлен в поле ввода получателя. Агент не запущен — отправит человек." }
            : { state: "failed", detail: failure || "Устройство не выполнило запрос." });
          setSending(false);
          return;
        }
        setReceipt({ state: "pending", detail: "Передано в Hub, жду устройство…" });
      } catch { if (++failures > 5) { setSending(false); setReceipt({ state: "unknown", detail: "Ответ Hub потерялся. Проверьте сессию на получателе перед повтором." }); return; } }
      poll.current = setTimeout(() => void tick(), 800);
    };
    await tick();
  }

  async function send(run: boolean) {
    if (!device || !text.trim() || sending) return;
    if (mode === "new" && !run) return;
    setSending(true); setError("");
    try {
      if (mode === "existing") {
        if (!target) throw new Error("Выберите сессию получателя.");
        const { id } = run ? await sendToSession(device.id, target, text.trim()) : await pasteToSession(device.id, target, text.trim());
        await watch(id, run);
      } else {
        const { id } = await createRemoteSession(device.id, directory, text.trim(), modelRef(newestSession(device)));
        await watch(id, true);
      }
    } catch (e) { setError(errorText(e)); setSending(false); }
  }

  const ready = !!device && !!text.trim() && (mode === "new" ? !!directory : !!target);

  return <div className="modal-overlay" onKeyDown={e => { if (e.key === "Escape") close(); }}>
    <div className="modal handoff-modal" role="dialog" aria-modal="true" aria-label="Отправить в удалённую сессию">
      <div className="handoff-heading"><h3>Отправить в удалённую сессию</h3><button className="icon-btn" aria-label="Закрыть отправку" disabled={sending} onClick={close}><Icon name="close"/></button></div>
      <p className="handoff-source">Из «{source.title}»<small className="project-path">{source.directory}</small></p>
      {!receipt && <>
        <div className="handoff-filters">
          <label>Устройство получателя<select aria-label="Устройство получателя" value={deviceId} disabled={loading || sending} onChange={e => setDeviceId(e.target.value)}>
            {!devices.length && <option value="">{loading ? "Загрузка…" : "Нет доступных устройств"}</option>}
            {devices.map(d => <option key={d.id} value={d.id}>{d.name}{d.appVersion ? ` · ${d.appVersion}` : ""}</option>)}
          </select></label>
          <label>Куда отправить<select aria-label="Способ отправки" value={mode} disabled={sending} onChange={e => setMode(e.target.value as "existing" | "new")}>
            <option value="existing">В существующую сессию</option>
            <option value="new">Создать новую сессию</option>
          </select></label>
        </div>
        {mode === "existing"
          ? <div className="handoff-targets" aria-label="Сессии получателя">{sessions.map(item => <button key={item.id} className={`handoff-target${sessionId === item.id ? " selected" : ""}`} aria-pressed={sessionId === item.id} disabled={sending} onClick={() => setSessionId(item.id)}>
              <Icon name="chat" size={16}/><span><b>{item.title || "Без названия"}</b><small>{item.directory}</small></span>{sessionId === item.id && <Icon name="check" size={16}/>}
            </button>)}
            {!loading && !sessions.length && <p className="empty-hint">На этом устройстве нет открытых сессий. Создайте новую или выберите другое устройство.</p>}
          </div>
          : <label>Папка проекта на получателе{directory
              ? <select aria-label="Папка проекта" value={directory} disabled={sending} onChange={e => setDirectory(e.target.value)}>{projects.map(dir => <option key={dir} value={dir}>{pathBasename(dir)} — {dir}</option>)}</select>
              : <select aria-label="Папка проекта" value="" disabled={sending || !projects.length} onChange={e => setDirectory(e.target.value)}>
                  {!projects.length && <option value="">Нет проектов на устройстве</option>}
                  <option value="">Выберите папку…</option>
                  {projects.map(dir => <option key={dir} value={dir}>{pathBasename(dir)} — {dir}</option>)}
                </select>}
            </label>}
        <label>Запрос<textarea aria-label="Текст запроса" placeholder="Что нужно сделать в сессии на другом компьютере…" rows={4} maxLength={200000} value={text} disabled={sending} onChange={e => setText(e.target.value)}/></label>
        {mode === "new" && <p className="handoff-note">Новая сессия создаётся на получателе и сразу запускается с этим запросом{fallbackModel ? ` на модели ${fallbackModel.providerID}/${fallbackModel.modelID}` : ""}.</p>}
        {mode === "existing" && target && !modelRef(target) && <p className="handoff-note">У выбранной сессии не записана модель: «Переслать и выполнить» недоступно, «Только переслать» работает.</p>}
      </>}
      {receipt && <div className="handoff-receipt" role="status">
        <h4>{receipt.state === "accepted" ? "Запрос отправлен" : receipt.state === "pending" ? "Отправляю…" : receipt.state === "failed" ? "Получатель не выполнил запрос" : "Доставка не подтверждена"}</h4>
        <p>{device?.name}{mode === "existing" && target ? ` · ${target.title}` : ""}</p>
        <p>{receipt.detail}</p>
      </div>}
      {error && <p className="handoff-error" role="alert">{error}</p>}
      <div className="btn-row">
        <button className="btn" disabled={sending} onClick={close}>{receipt ? "Закрыть" : "Отмена"}</button>
        {!receipt && <>
          <button className="btn" disabled={!ready || sending || mode === "new" || !target || !modelRef(target)}
            title={mode === "new" ? "Для новой сессии сразу запускается работа" : "Текст появится в поле ввода получателя, агент не запустится"}
            onClick={() => void send(false)}>Только переслать</button>
          <button className="btn primary" disabled={!ready || sending || (mode === "existing" && !!target && !modelRef(target))} onClick={() => void send(true)}>{sending ? "Отправляю…" : "Переслать и выполнить"}</button>
        </>}
        {receipt && <button className="btn primary" onClick={close}>Готово</button>}
      </div>
    </div>
  </div>;
}

export function remoteDeviceLabel(device: RemoteDevice) {
  const name = device.name?.trim();
  return name && UUID.test(name) ? name : device.name || device.id.slice(0, 8);
}

export function remoteSessionLabel(session: RemoteSession) {
  return session.title?.trim() || "Без названия";
}
