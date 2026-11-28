import { useEffect, useRef, useState } from "react";
import { browserNative } from "../browser/integration";
import { parseFrame, type BrowserFrame } from "../browser/view";
import { Icon } from "./Icon";
import { listen } from "@tauri-apps/api/event";

/** A passive projection: never installs a resize observer or input handlers.
 * Only the two presentation controls invoke native commands. Chromium, agent
 * loops and page state all remain owned by the existing main-window runtime. */
export function BrowserMonitor() {
  const [frame, setFrame] = useState<BrowserFrame>();
  const [catalog, setCatalog] = useState<BrowserFrame["tabs"]>([]);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [changing, setChanging] = useState(false);
  const scopeRevision = useRef(0);
  const observed = useRef<string | undefined>(undefined)
  const selectionEpoch = useRef(0);
  const [order, setOrder] = useState<string[]>([]);
  const [dragged, setDragged] = useState<string>();
  const [dropTarget, setDropTarget] = useState<string>();
  const choose = (id: string) => { observed.current = id; selectionEpoch.current++; setFrame(undefined); setStale(false); };
  const move = (from: string, to: string) => setOrder(previous => {
    if (from === to || !previous.includes(from) || !previous.includes(to)) return previous;
    const next = previous.filter(id => id !== from); next.splice(previous.indexOf(to), 0, from); return next;
  });
  useEffect(() => {
    let cancelled = false, failures = 0, revision = 0;
    let stop: (() => void) | undefined;
    void listen("browser-monitor://scope", () => {
      revision++; scopeRevision.current++; selectionEpoch.current++; observed.current = undefined; setCatalog([]); setOrder([]); setDragged(undefined); setDropTarget(undefined); setFrame(undefined); setStale(false); setError(""); setChanging(false);
    }).then(unlisten => { if(cancelled) unlisten(); else stop = unlisten; }).catch(() => {});
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = 800;
      try {
        const epoch = revision, selection = selectionEpoch.current;
        const value = await browserNative<unknown>("browser_monitor_frame", observed.current ? { pageId: observed.current } : undefined);
        if (cancelled) return;
        if (epoch !== revision || selection !== selectionEpoch.current) { timer = setTimeout(() => void poll(), 100); return; }
        if (value !== null) {
          const next = parseFrame(value);
          if (observed.current && !next.tabs.some(t => t.id === observed.current)) observed.current = undefined;
          setCatalog(next.tabs);
          const ids = next.tabs.flatMap(t => t.id ? [t.id] : []);
          setOrder(previous => [...previous.filter(id => ids.includes(id)), ...ids.filter(id => !previous.includes(id))]);
          setFrame(next); setStale(false); failures = 0;
          delay = next.busy ? 250 : 500;
        } else {
          setStale(true); // Hidden window: never label retained pixels as current.
        }
      } catch {
        if (cancelled) return;
        setStale(true); failures++;
        delay = Math.min(4000, 500 * 2 ** failures);
      }
      if (!cancelled) timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); stop?.(); };
  }, []);

  async function present(action: "restore" | "hide") {
    if (changing) return;
    const epoch = scopeRevision.current;
    setChanging(true);
    try { await browserNative("browser_monitor", { action }); if (epoch === scopeRevision.current) setError(""); }
    catch { if (epoch === scopeRevision.current) setError("Не удалось вернуть или скрыть окно. Повторите действие."); }
    finally { if (epoch === scopeRevision.current) setChanging(false); }
  }
  const hasImage = !!frame?.browserOpen && !!frame.image;
  const cursor = frame?.cursor;
  const tabs = catalog.filter(t => t.id).sort((a,b) => order.indexOf(a.id!) - order.indexOf(b.id!));
  const selected = observed.current ?? catalog.find(t => t.active)?.id;
  return <section className="browser-monitor" aria-label="Наблюдение за браузером">
    <header data-tauri-drag-region="deep">
      <Icon name="browser" size={16}/>
      <span className="browser-monitor-title" title={frame?.title || "Браузер"}>{frame?.title || "Браузер"}</span>
      <button className="icon-btn" aria-label="Вернуть браузер в приложение" title="Вернуть в приложение для ручной работы" disabled={changing} onClick={() => void present("restore")}><Icon name="expand" size={16}/></button>
      <button className="icon-btn" aria-label="Скрыть окно наблюдения" title="Скрыть окно — браузер продолжит работать" disabled={changing} onClick={() => void present("hide")}><Icon name="close" size={16}/></button>
    </header>
    {tabs.length > 1 && <nav className="browser-monitor-tabs" aria-label="Страницы группы" role="tablist">
      {tabs.map(tab => <button key={tab.id} type="button" role="tab" aria-selected={selected === tab.id}
        data-dragging={dragged === tab.id || undefined} data-drop-target={dropTarget === tab.id || undefined}
        title={`${tab.title || "Без названия"}${tab.active ? " · Вкладка агента" : ""}`} draggable
        onClick={() => choose(tab.id!)} onDragStart={event => { setDragged(tab.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", tab.id!); }}
        onDragOver={event => { if (dragged) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget(tab.id); } }}
        onDrop={event => { event.preventDefault(); if (dragged) move(dragged, tab.id!); setDragged(undefined); setDropTarget(undefined); }} onDragEnd={() => { setDragged(undefined); setDropTarget(undefined); }}
        onKeyDown={event => { if (event.altKey && ["ArrowLeft","ArrowRight"].includes(event.key)) { event.preventDefault(); const target = tabs[tabs.indexOf(tab) + (event.key === "ArrowLeft" ? -1 : 1)]; if (target) move(tab.id!, target.id!); } }}>
        <Icon name="browser" size={12}/><span>{tab.title || "Без названия"}</span>{tab.active && <i className="browser-status-dot" title="Вкладка агента"/>}
      </button>)}
    </nav>}
    <div className="browser-monitor-viewport" aria-label="Страница только для наблюдения">
      {hasImage ? <div className={`browser-monitor-frame${stale ? " stale" : ""}`} >
        <img src={`data:image/jpeg;base64,${frame.image}`} alt={frame.title || "Живая страница браузера"} draggable={false}/>
        {cursor && <div className={`browser-agent-cursor ${cursor.owner}`} aria-label={cursor.owner === "agent" ? "Курсор агента" : "Курсор пользователя"} style={{left:`${cursor.x / frame.width! * 100}%`,top:`${cursor.y / frame.height! * 100}%`}}><span>➤</span></div>}
      </div> : <p>{frame?.browserOpen === false ? "Браузер закрыт" : "Жду страницу браузера…"}</p>}
    </div>
    <footer>
      <span className={`browser-status-dot${frame?.busy ? " busy" : ""}`}/>
      <span role={stale || error ? "alert" : "status"}>{error || (stale ? "Нет свежего кадра" : frame?.busy ? "Агент работает…" : "Только наблюдение")}</span>
      <span title="Для кликов и прокрутки верните браузер в приложение"><Icon name="lock" size={12}/></span>
    </footer>
  </section>;
}
