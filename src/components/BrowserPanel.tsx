import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Icon } from "./Icon";
import { safeExternalUrl } from "../util/markdown";
import { browserNative } from "../browser/integration";
import { browserEnabled } from "../browser/preferences";
import { browserPoint, parseFrame, frameForSession, type BrowserFrame } from "../browser/view";
import { InputQueue, TEXT_LIMIT_BYTES, WHEEL_LIMIT, textBytes } from "../browser/inputQueue";
import { fileChooserOpen } from "../attachments/composerBridge";
import { isNative } from "../native/platform";
import { isLocalComputer } from "../state/computer";
import { store, useAppState } from "../state/store";

/** Auto-reveal once when an agent opens Chromium. Closing the panel only hides
 * the projection: it does not interrupt the browser or the agent's task. */
const presentations = new Map<string, "panel" | "monitor" | "hidden">();
const presentationKey = () => JSON.stringify([store.state.prefs.workspaceKey ?? store.state.prefs.endpoint, store.state.directory, store.engineIdFor(), store.state.activeSessionId]);
export function BrowserPresence() {
  const app = useAppState();
  const local = isNative() && isLocalComputer(app.prefs.endpoint, !!store.currentHost()) && browserEnabled(app.prefs);
  const activeLocal = useRef(local);
  activeLocal.current = local;
  useEffect(() => {
    if (!local || !app.ui.browserOpen || !app.activeSessionId) return;
    let cancelled = false;
    const engine = store.engineIdFor(), session = app.activeSessionId, directory = app.directory;
    const current = () => !cancelled && store.state.activeSessionId === session && store.state.directory === directory
      && store.state.prefs.workspaceKey === app.prefs.workspaceKey && store.state.prefs.endpoint === app.prefs.endpoint;
    const key = JSON.stringify([app.prefs.workspaceKey ?? app.prefs.endpoint, directory, engine, session]);
    presentations.set(key, "panel");
    void browserNative<{scope?:{engine:string;sessionID:string};scopeKey?:string}>("browser_presence").then(presence => {
      if (current() && presence.scope?.engine === engine && presence.scope?.sessionID === session && store.state.ui.browserOpen)
        return browserNative("browser_monitor", { action: "restore", scopeKey:presence.scopeKey });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [local, app.ui.browserOpen, app.activeSessionId, app.directory, app.prefs.workspaceKey, app.prefs.endpoint]);
  useEffect(() => {
    if (!isNative()) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => listen<{mode:string;scope?:{engine:string;sessionID:string}}>("browser-monitor://presentation", event => {
      if (cancelled) return;
      const s = store.state;
      if (event.payload.scope?.engine !== store.engineIdFor() || event.payload.scope?.sessionID !== s.activeSessionId) return;
      const mode = event.payload.mode;
      const key = JSON.stringify([s.prefs.workspaceKey ?? s.prefs.endpoint, s.directory, store.engineIdFor(), s.activeSessionId]);
      if (["panel", "monitor", "hidden"].includes(mode)) presentations.set(key, mode as "panel" | "monitor" | "hidden");
      if (mode === "monitor" || mode === "hidden") store.setUi({ browserOpen: false });
      if (mode === "panel" && activeLocal.current) {
        store.setUi({ browserOpen: true });
        // Do not bypass SettingsScreen's unsaved-draft exit guard.
        if (store.state.ui.settingsOpen) store.setUi({ toast: "Браузер возвращён в панель. Вернитесь из настроек для работы с ним." });
      }
    })).then(unlisten => { if (cancelled) unlisten(); else stop = unlisten; }).catch(() => {});
    return () => { cancelled = true; stop?.(); };
  }, []);
  useEffect(() => {
    if (!isNative()) return;
    let cancelled = false, wasOpen = false, selectionReady = false;
    let timer: ReturnType<typeof setTimeout>;
    const engine = store.engineIdFor(), session = app.activeSessionId;
    const key = JSON.stringify([app.prefs.workspaceKey ?? app.prefs.endpoint, app.directory, engine, session]);
    const selection = local && app.directory && session
      ? { directory: app.directory, engine, sessionId: session }
      : { directory: null, engine: null, sessionId: null };
    const stillSelected = () => store.state.activeSessionId === session
      && store.state.directory === app.directory
      && store.state.prefs.endpoint === app.prefs.endpoint
      && store.state.prefs.workspaceKey === app.prefs.workspaceKey
      && store.engineIdFor() === engine;
    if (store.state.ui.browserOpen) store.setUi({ browserOpen: false });
    const poll = async () => {
      try {
        if (!selectionReady) {
          if (!stillSelected()) return;
          await browserNative("browser_session", selection);
          if (cancelled || !stillSelected()) return;
          selectionReady = true;
        }
        if (cancelled || !stillSelected()) return;
        if (!local || !session) return;
        let s = await browserNative<{ running?: boolean; browserOpen: boolean; monitorOpen?: boolean; scopeKey?:string; scope?: {engine:string;sessionID:string} }>("browser_presence");
        if (cancelled || !stillSelected()) return;
        // The native gateway returns running:false when its health request
        // fails. That is unknown presence, not proof the browser was closed.
        if (s.running === false) throw new Error("Browser presence temporarily unavailable");
        // A daemon restart or a late agent-side selection can leave the shared
        // service on another chat. Reconcile only on mismatch, never on every
        // health tick; a stale effect is guarded against the live store state.
        if ((s.scope?.engine !== engine || s.scope?.sessionID !== session) && stillSelected()) {
          await browserNative("browser_session", selection);
          if (cancelled || !stillSelected()) return;
          s = await browserNative("browser_presence");
          if (cancelled || !stillSelected()) return;
          if (s.running === false) throw new Error("Browser presence temporarily unavailable");
        }
        const ours = s.scope?.engine === engine && s.scope?.sessionID === session;
        if (s.browserOpen && ours && !wasOpen) {
          if (s.monitorOpen) presentations.set(key, "monitor");
          else if (presentations.get(key) === "monitor") await browserNative("browser_monitor", { action: "detach", scopeKey:s.scopeKey });
          else if (presentations.get(key) !== "hidden") store.setUi({ browserOpen: true });
        }
        // A toolbar open can reveal the panel before the native browser has
        // finished starting. Only auto-hide after observing an open browser
        // for this session; otherwise the first poll races setup.
        if (wasOpen && (!s.browserOpen || !ours) && store.state.ui.browserOpen) store.setUi({ browserOpen: false });
        wasOpen = !!s.browserOpen && ours;
      } catch { /* An unavailable service does not reveal another chat's browser. */ }
      if (!cancelled) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [local, app.activeSessionId, app.prefs.endpoint, app.prefs.workspaceKey, app.directory, app.prefs.browser?.nodeProgram]);
  return null;
}

const FRAME_MS = 150, IDLE_FRAME_MS = 250, MAX_BACKOFF_MS = 2000, SUSPENDED_MS = 400;
const NAV_KEYS = ["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"];
/** Frames nobody can see are not fetched: hidden window or a native file chooser in front. */
const suspended = () => document.hidden || fileChooserOpen();

export function BrowserPanel() {
  const app = useAppState();
  const [frame, setFrame] = useState<BrowserFrame>();
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [frameError, setFrameError] = useState("");
  const [working, setWorking] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const savedWidth = app.prefs.layout?.browserWidth;
  const preferredWidth = Number.isFinite(savedWidth) ? Math.max(280, Math.min(1100, savedWidth)) : 420;
  const [dragWidth, setDragWidth] = useState<number>();
  const panel = useRef<HTMLElement>(null);
  const widthDrag = useRef<{ x: number; initial: number; max: number; width: number } | undefined>(undefined);
  const widthLimit = () => Math.max(280, Math.min(1100,
    (panel.current?.parentElement?.getBoundingClientRect().width || window.innerWidth) - (window.innerWidth > 1100 ? 280 : 48)));
  const resizeWidth = (width: number) => Math.round(Math.max(280, Math.min(widthLimit(), width)));
  const commitWidth = (width: number) => { store.setLayout({ browserWidth: resizeWidth(width) }); setDragWidth(undefined); };
  const [resizing, setResizing] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  const [detaching, setDetaching] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const scrollPending = useRef<{pageId?:string;revision?:number} | null>(null);
  const detachPending = useRef(false);
  const viewport = useRef<{ width: number; height: number } | undefined>(undefined);
  const surface = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const displayed = useRef<BrowserFrame | undefined>(undefined);
  const gesture = useRef<{x:number;y:number;clientX:number;clientY:number;seen:BrowserFrame} | undefined>(undefined);
  const refreshFrame = useRef<(() => void) | undefined>(undefined);
  const latestFrame = useRef(frame);
  latestFrame.current = frame;
  const screen = useRef<HTMLDivElement>(null);
  const editingAddress = useRef(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const local = isNative() && isLocalComputer(app.prefs.endpoint, !!store.currentHost()) && browserEnabled(app.prefs);
  // User actions share the daemon's tool queue. A failed action is never replayed.
  const queue = useRef<InputQueue | null>(null);
  queue.current ??= new InputQueue(async ({ action, args }) => {
    if (!alive.current || !browserEnabled(store.state.prefs) || !isLocalComputer(store.state.prefs.endpoint, !!store.currentHost())) return;
    const epoch = generation.current;
    const current = () => alive.current && epoch === generation.current;
    setWorking(true);
    try {
      const result = await browserNative<{text?:string}>("browser_input", { action, args });
      if (current()) {
        if (action === "copy" && result?.text) await navigator.clipboard.writeText(result.text);
        setError("");
      }
    }
    catch (e) { if (current()) {
      setError(e instanceof Error ? e.message : String(e));
      if (action === "wheel") { scrollPending.current = null; setScrolling(false); setFrameError("Не удалось прокрутить страницу. Жду свежий кадр."); }
    } }
    finally { if (current()) { setWorking(false); refreshFrame.current?.(); } }
  });
  useEffect(() => {
    generation.current++;
    alive.current = local;
    displayed.current = undefined; setFrame(undefined); setWorking(false); setError(""); setFrameError("");
    editingAddress.current = false; scrollPending.current = null; setScrolling(false);
    if (!local) return;
    let cancelled = false, failures = 0, first = true, active = true, inFlight = false, refreshPending = false;
    const nextFrameDelay = () => active ? FRAME_MS : IDLE_FRAME_MS;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (cancelled) return;
      // The first frame always loads; afterwards nothing is captured while nobody can see it.
      if (!first && suspended()) { timer = setTimeout(() => void poll(), SUSPENDED_MS); return; }
      first = false; inFlight = true;
      try {
        const next = parseFrame(await browserNative<unknown>("browser_view"));
        if (!frameForSession(next, store.engineIdFor(), app.activeSessionId)) {
          if (!cancelled) { setFrame(undefined); displayed.current = undefined; queue.current?.clear(); }
          inFlight = false; refreshPending = false;
          if (!cancelled) timer = setTimeout(() => void poll(), IDLE_FRAME_MS);
          return;
        }
        active = !!next.busy;
        if (!cancelled) { setFrame(next); setFrameError(""); failures = 0;
          if (viewport.current?.width === next.width && viewport.current?.height === next.height) setResizing(false); }
      } catch {
        failures++;
        if (!cancelled) setFrameError("Нет свежего кадра. Проверьте подключение браузера.");
      }
      inFlight = false;
      const urgent = refreshPending; refreshPending = false;
      // A failing service is not hammered continuously.
      if (!cancelled) timer = setTimeout(() => void poll(), failures ? Math.min(MAX_BACKOFF_MS, FRAME_MS * 2 ** failures) : urgent ? 0 : nextFrameDelay());
    };
    refreshFrame.current = () => {
      if (cancelled) return;
      if (inFlight) { refreshPending = true; return; }
      clearTimeout(timer); void poll();
    };
    void poll();
    return () => { refreshFrame.current = undefined; gesture.current = undefined; cancelled = true; alive.current = false; generation.current++; queue.current?.clear(); clearTimeout(timer); };
  }, [local, app.activeSessionId, app.prefs.endpoint, app.prefs.workspaceKey, app.directory, app.prefs.browser?.nodeProgram]);
  // Never overwrite an address the user is typing; show the real URL otherwise.
  useEffect(() => { if (!editingAddress.current) setAddress(frame?.url || ""); }, [frame?.url]);
  function input(action: string, args: Record<string, unknown> = {}, seen = frame) {
    if (!local || !seen?.scopeKey || frame?.busy || widthDrag.current || resizing || changingMode || detachPending.current || scrollPending.current) return;
    if (["click", "drag", "wheel", "text", "key", "copy"].includes(action) && (!frame?.image || frameError)) return;
    if (action === "text" && textBytes(String(args.text ?? "")) > TEXT_LIMIT_BYTES) {
      setError("Текст больше 16 КБ панель не вставляет. Поручите ввод агенту через инструменты браузера.");
      return;
    }
    // Bound to the page the user saw: a changed page/revision rejects it instead of acting elsewhere.
    const expected = seen?.pageId ? { pageId: seen.pageId, revision: seen.revision, url: seen.url, width: seen.width, height: seen.height } : undefined;
    if (action === "wheel") queue.current?.clear();
    if (!queue.current?.push({ action, args: { ...args, scopeKey: seen?.scopeKey, ...(expected ? { expected } : {}) } }))
      setError("Слишком много действий ждут выполнения. Дождитесь обновления страницы.");
    else if (action === "wheel") { scrollPending.current = {pageId:seen?.pageId,revision:seen?.revision}; setScrolling(true); }
  }
  function decoded(next: BrowserFrame) {
    displayed.current = next;
    const pending = scrollPending.current;
    if (pending && !next.busy && (next.pageId !== pending.pageId || next.revision !== pending.revision)) {
      scrollPending.current = null; setScrolling(false);
    }
  }
  useEffect(() => {
    const img = image.current;
    if (!frame?.image || !img?.complete || !img.naturalWidth) return;
    let cancelled = false;
    // Same JPEG URL need not fire load again after a revision change.
    void img.decode().then(() => { if (!cancelled && alive.current) decoded(frame); }).catch(() => {});
    return () => { cancelled = true; };
  }, [frame]);
  const latestInput = useRef(input);
  latestInput.current = input;
  useEffect(() => {
    const node = screen.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      const seen = displayed.current;
      if (seen) latestInput.current("wheel", { dy: Math.max(-WHEEL_LIMIT, Math.min(WHEEL_LIMIT, event.deltaY)) }, seen);
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [local]);
  // Reflow the actual page, not just its picture. Debounce drag/zoom bursts;
  // discard pending old input and unlock only when the matching frame arrives.
  useEffect(() => {
    if (!local || !frame?.scopeKey || !surface.current || dragWidth !== undefined || typeof ResizeObserver === "undefined") return;
    const epoch = generation.current;
    let timer: ReturnType<typeof setTimeout>, cancelled = false;
    const observer = new ResizeObserver(([entry]) => {
      if (cancelled || detachPending.current || !entry || entry.contentRect.width < 1 || entry.contentRect.height < 1) return;
      const next = { width: Math.max(320, Math.min(1920, Math.round(entry.contentRect.width))), height: Math.max(240, Math.min(1200, Math.round(entry.contentRect.height))) };
      if (viewport.current?.width === next.width && viewport.current?.height === next.height) return;
      viewport.current = next; queue.current?.clear(); setResizing(true);
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (cancelled || detachPending.current) return;
        const scopeKey = latestFrame.current?.scopeKey;
        if (!scopeKey) return;
        void browserNative("browser_input", { action: "resize", args: { ...next, scopeKey } }).catch(e => {
          if (!cancelled && epoch === generation.current) { setFrameError("Не удалось изменить размер страницы. Повторите подключение браузера."); setError(String(e)); }
        });
      }, 200);
    });
    observer.observe(surface.current);
    return () => { cancelled = true; clearTimeout(timer); observer.disconnect(); viewport.current = undefined; };
  }, [local, app.prefs.endpoint, frame?.scopeKey, dragWidth !== undefined]);
  async function changeMode(mode: "fast" | "human") {
    if (!frame?.scopeKey) return;
    setChangingMode(true); queue.current?.clear();
    const epoch = generation.current;
    try {
      await browserNative("browser_input", { action: "mode", args: { mode, scopeKey: frame?.scopeKey } });
      if (alive.current && epoch === generation.current) { store.setBrowserSettings({ mode }); setError(""); }
    } catch (e) { if (epoch === generation.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (epoch === generation.current) setChangingMode(false); }
  }
  async function detach() {
    if (!local || !frame?.scopeKey || detachPending.current || resizing || changingMode || working || scrollPending.current) return;
    detachPending.current = true; setDetaching(true); queue.current?.clear();
    const epoch = generation.current;
    try {
      await browserNative("browser_monitor", { action: "detach", scopeKey:frame?.scopeKey });
      if (alive.current && epoch === generation.current) store.setUi({ browserOpen: false });
    } catch {
      if (alive.current && epoch === generation.current) setError("Не удалось открыть окно наблюдения. Браузер остаётся в панели.");
    } finally {
      detachPending.current = false;
      if (alive.current && epoch === generation.current) setDetaching(false);
    }
  }
  const locked = !frame?.scopeKey || !!frame?.busy || dragWidth !== undefined || resizing || changingMode || detaching || scrolling;
  const mode = frame?.mode ?? app.prefs.browser?.mode ?? "fast";
  const cursor = frame?.cursor;
  return <section ref={panel} className={`browser-panel${expanded ? " expanded" : ""}${dragWidth !== undefined ? " resizing-width" : ""}`} style={{ "--browser-panel-width": `${dragWidth ?? preferredWidth}px` } as CSSProperties} aria-label="Встроенный браузер">
    {!expanded && <div className="browser-panel-resizer" role="separator" tabIndex={0}
      aria-label="Ширина браузерной панели" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={widthLimit()} aria-valuenow={dragWidth ?? preferredWidth}
      title="Перетащите, чтобы изменить ширину; стрелки ← → для точной настройки"
      onPointerDown={e => {
        if (e.button !== 0) return;
        e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
        const initial = panel.current?.getBoundingClientRect().width || preferredWidth;
        widthDrag.current = { x: e.clientX, initial, max: widthLimit(), width: initial };
        queue.current?.clear();
        if (local && frame?.scopeKey) setResizing(true);
        setDragWidth(initial);
      }}
      onPointerMove={e => {
        const drag = widthDrag.current; if (!drag) return;
        drag.width = Math.round(Math.max(280, Math.min(drag.max, drag.initial + drag.x - e.clientX)));
        setDragWidth(drag.width);
      }}
      onPointerUp={e => {
        const drag = widthDrag.current; if (!drag) return;
        widthDrag.current = undefined; commitWidth(drag.width);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => { widthDrag.current = undefined; setDragWidth(undefined); }}
      onLostPointerCapture={() => { widthDrag.current = undefined; setDragWidth(undefined); }}
      onKeyDown={e => {
        const width = panel.current?.getBoundingClientRect().width || preferredWidth;
        const step = e.shiftKey ? 40 : 10;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault(); commitWidth(width + (e.key === "ArrowLeft" ? step : -step));
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault(); commitWidth(e.key === "Home" ? 280 : widthLimit());
        }
      }} />}

    <header className="browser-chrome">
      <div className="browser-tabs" role="tablist" aria-label="Вкладки браузера">{frame?.tabs.map(tab => <div className={`browser-tab${tab.active ? " active" : ""}`} key={tab.index}>
        <button role="tab" aria-selected={tab.active} disabled={locked} title={tab.title || "Новая вкладка"} onClick={() => input("select", { index: tab.index })}><Icon name="browser" size={14}/><span>{tab.title || "Новая вкладка"}</span></button>
        <button aria-label={`Закрыть вкладку ${tab.title || tab.index + 1}`} disabled={locked} onClick={() => input("close", { index: tab.index })}><Icon name="close" size={12}/></button>
      </div>)}{!frame?.tabs.length && <span className="browser-empty-tab">Браузер</span>}<button className="icon-btn" aria-label="Новая вкладка браузера" disabled={!local || locked} onClick={() => input("new")}><Icon name="plus" size={16}/></button></div>
      <div className="browser-window-actions"><button className="icon-btn" aria-label="Вынести браузер в окно наблюдения" title="Отдельное окно только для наблюдения" disabled={!local || detaching || resizing || changingMode || working || scrolling} onClick={() => void detach()}><Icon name="popout" size={16}/></button><button className="icon-btn" aria-label={expanded ? "Свернуть браузер" : "Развернуть браузер"} aria-pressed={expanded} onClick={() => setExpanded(!expanded)}><Icon name="expand" size={15}/></button><button className="icon-btn" aria-label="Закрыть панель браузера" onClick={() => { presentations.set(presentationKey(), "hidden"); store.setUi({ browserOpen: false }); }}><Icon name="panel" size={16}/></button></div>
    </header>
    {!local ? <p role="status">Браузер доступен только на этом компьютере, когда управление включено.</p> : <>
      <form className="browser-address" onSubmit={e => { e.preventDefault(); editingAddress.current = false; input("navigate", { url: address }); }}>
        <button type="button" aria-label="Назад в браузере" disabled={locked} onClick={() => input("back")}><Icon name="back" size={16}/></button>
        <button type="button" aria-label="Вперёд в браузере" disabled={locked} onClick={() => input("forward")}><Icon name="forward" size={16}/></button>
        <button type="button" aria-label="Обновить страницу" disabled={locked} onClick={() => input("reload")}><Icon name="refresh" size={16}/></button>
        <input aria-label="Адрес браузера" value={address} placeholder="https://…" spellCheck={false}
          onChange={e => { editingAddress.current = true; setAddress(e.target.value); }}
          onBlur={() => { editingAddress.current = false; }}
          onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); editingAddress.current = false; setAddress(frame?.url || ""); } }}/>
        <button className="browser-go" aria-label="Перейти по адресу" disabled={locked}><Icon name="forward" size={15}/></button>
        <button type="button" aria-label="Открыть в системном браузере" title="Открыть в обычном браузере; вход и cookies отдельные" disabled={!frame?.url || !/^https?:/.test(frame.url) || !safeExternalUrl(frame.url)} onClick={() => {
          const url = safeExternalUrl(frame?.url ?? null);
          if (url && /^https?:/.test(url)) void import("@tauri-apps/plugin-opener").then(({openUrl}) => openUrl(url)).catch(() => setError("Не удалось открыть системный браузер."));
        }}><Icon name="popout" size={15}/></button>
        <select className="browser-mode" aria-label="Режим работы браузера" title={mode === "human" ? "Полная эмуляция: клики мышью, ввод клавиатурой" : "Быстрый: структура страницы и точные действия"} value={mode} disabled={changingMode || frame?.busy} onChange={e => void changeMode(e.target.value as "fast" | "human")}><option value="fast">Быстрый</option><option value="human">Эмуляция</option></select>
      </form>
      {(error || frameError) && <p className="browser-error" role="alert">{error || frameError}</p>}
      <div ref={surface} className="browser-scroll"><div ref={screen} className={`browser-screen${(frameError || resizing || scrolling) ? " stale" : ""}`} tabIndex={0} role="application"
        aria-label="Страница браузера: клик, ввод и прокрутка. Shift+Tab — выйти из страницы." style={{ aspectRatio: `${frame?.width || 1280}/${frame?.height || 800}` }}
        onPointerDown={e => {
          if (e.button !== 0 || !image.current || frame?.busy || resizing || scrolling || frameError) return;
          const seen = displayed.current;
          const p = seen && browserPoint(e.clientX, e.clientY, image.current.getBoundingClientRect(), seen);
          if (!seen || !p) return;
          e.preventDefault(); e.currentTarget.focus();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          gesture.current = {...p, clientX:e.clientX, clientY:e.clientY, seen};
        }}
        onPointerUp={e => {
          const start = gesture.current; gesture.current = undefined;
          if (!start || !image.current) return;
          e.preventDefault();
          const p = browserPoint(e.clientX, e.clientY, image.current.getBoundingClientRect(), start.seen);
          if (!p) return;
          if (Math.hypot(e.clientX-start.clientX,e.clientY-start.clientY) > 3)
            input("drag", {x:start.x,y:start.y,endX:p.x,endY:p.y}, start.seen);
          else input("click", {x:start.x,y:start.y}, start.seen);
        }}
        onPointerCancel={() => { gesture.current = undefined; }}
        onLostPointerCapture={() => { gesture.current = undefined; }}
        onPaste={e => { e.preventDefault(); input("text", { text: e.clipboardData.getData("text/plain") }); }}
        onKeyDown={e => {
          // IME composition is not projected; half-composed keys must not reach the page.
          if (e.nativeEvent.isComposing) return;
          if (e.ctrlKey || e.metaKey) { if (e.key.toLowerCase() === "c") { e.preventDefault(); input("copy"); } else if (e.key.toLowerCase() === "a") { e.preventDefault(); input("key", { key: "ControlOrMeta+a" }); } return; }
          // Shift+Tab leaves the projection (no keyboard trap); a plain Tab moves focus inside the page.
          if (e.key === "Tab" && e.shiftKey) return;
          if (e.key.length === 1 && !e.altKey) { e.preventDefault(); input("text", { text: e.key }); }
          else if (NAV_KEYS.includes(e.key)) { e.preventDefault(); input("key", { key: e.key }); }
        }}>
        {frame?.image ? <img ref={image} src={`data:image/jpeg;base64,${frame.image}`} alt={frame.title || "Страница Chromium"} draggable={false} onLoad={() => { if (frame) decoded(frame); }}/> : <p>{app.ui.browserOpen ? "Запускаю встроенный браузер…" : "Откройте браузер кнопкой в верхней панели или задайте адрес страницы."}</p>}
        {cursor && frame?.width && frame?.height && <div className={`browser-agent-cursor ${cursor.owner}`} style={{ left: `${cursor.x / frame.width * 100}%`, top: `${cursor.y / frame.height * 100}%` }} aria-label={cursor.owner === "agent" ? "Курсор агента" : "Курсор пользователя"}><span>➤</span><small>{cursor.owner === "agent" ? "Агент" : "Вы"}</small></div>}
      </div></div>
      <footer><span className={`browser-status-dot${locked ? " busy" : ""}`}/><span role="status">{scrolling ? "Обновляю после прокрутки…" : resizing ? "Подстраиваю страницу…" : changingMode ? "Меняю режим…" : frame?.busy ? "Агент действует…" : working ? "Выполняю…" : mode === "human" ? "Эмуляция · мышь и клавиатура" : "Быстрый · точные действия"}</span><span className="browser-viewport">{frame?.width && `${frame.width} × ${frame.height}`}</span></footer>
    </>}
  </section>;
}
