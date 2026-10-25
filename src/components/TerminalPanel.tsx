import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { SseDecoder } from "../api/sse";
import type { PtyClosingDTO, PtyDTO, RuntimeClient } from "../agent/runtime/client";
import { store, useAppState, errText } from "../state/store";
import { createXterm, terminalTheme } from "./xtermHost";

type Status = "idle" | "connecting" | "open" | "closed" | "exited" | "error";

/** macOS resolves /tmp and similar symlinks; compare real paths. */
function samePath(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const norm = (p: string) => p.replace(/^\/private(?=\/)/, "").replace(/\/+$/, "");
  return norm(a) === norm(b);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * A shell owned by the Enki Runtime (`/pty`), streamed over authenticated SSE
 * with a resumable character cursor. Detaching (tab switch, reload) keeps the
 * shell running; only "Завершить" kills it. A running shell blocks updates
 * until it is closed — quiet output is never treated as idle.
 */
export function TerminalPanel() {
  const s = useAppState();
  const dir = s.directory;
  const client: RuntimeClient | null = s.connection.phase === "connected" ? store.client : null;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const refitRef = useRef<() => boolean>(() => false);
  const ptyRef = useRef<PtyDTO | null>(null);
  const streamRef = useRef<AbortController | null>(null);
  const cursorRef = useRef(0);
  const inputRef = useRef<Promise<void>>(Promise.resolve());
  const genRef = useRef(0);
  const resizeTimer = useRef<number | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("Терминал");

  const detach = () => { streamRef.current?.abort(); streamRef.current = null; };

  const pushSize = () => {
    const term = termRef.current, pty = ptyRef.current;
    if (!term || !pty || !dir || !client) return;
    if (resizeTimer.current) window.clearTimeout(resizeTimer.current);
    resizeTimer.current = window.setTimeout(() => {
      void client.ptyUpdate(pty.id, dir, { size: { rows: term.rows, cols: term.cols } }).catch(() => undefined);
    }, 150);
  };

  const follow = async (pty: PtyDTO, gen: number) => {
    if (!client || !dir) return;
    detach();
    const abort = new AbortController();
    streamRef.current = abort;
    setStatus("connecting");
    const open = () => fetch(client.ptyStreamUrl(pty.id, dir, cursorRef.current), { headers: { ...client.authorization(), Accept: "text/event-stream" }, signal: abort.signal, cache: "no-store" });
    try {
      let response = await open();
      if (response.status === 401) { await response.body?.cancel(); await client.reconnect(); response = await open(); }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Среда выполнения отклонила поток терминала (HTTP ${response.status}).`); }
      if (gen !== genRef.current) { abort.abort(); return; }
      setStatus("open");
      pushSize();
      const reader = response.body.getReader(), decoder = new TextDecoder(), frames = new SseDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || gen !== genRef.current) break;
        frames.push(decoder.decode(value, { stream: true }), data => {
          const term = termRef.current;
          let message: { type?: unknown; cursor?: unknown; reset?: unknown; data?: unknown };
          try { message = JSON.parse(data) as typeof message; } catch { return true; }
          if (message.type === "exit") { setStatus("exited"); return false; }
          if (message.type !== "data" || typeof message.data !== "string" || !term) return true;
          if (message.reset === true) term.reset();
          term.write(decodeBase64(message.data));
          if (typeof message.cursor === "number") cursorRef.current = message.cursor;
          return gen === genRef.current;
        });
      }
      if (gen === genRef.current) setStatus(previous => previous === "exited" ? "exited" : "closed");
    } catch (e) {
      if (abort.signal.aborted || gen !== genRef.current) return;
      setStatus("error");
      setError(errText(e));
    } finally {
      if (streamRef.current === abort) streamRef.current = null;
    }
  };

  const start = async (createNew: boolean) => {
    const gen = ++genRef.current;
    detach();
    setError(null);
    if (!dir || !client) {
      setStatus("error");
      setError(dir ? "Нет связи со средой выполнения Enki." : "Начните чат или откройте терминал снова для подготовки рабочей папки.");
      return;
    }
    const term = termRef.current;
    if (!term) return;
    setStatus("connecting");
    try {
      refitRef.current();
      let pty: PtyDTO | null = null;
      // Ownership: only reuse a shell this app created for this project.
      const ownedId = store.state.prefs.ptyIds[dir];
      if (!createNew && ownedId) {
        try {
          const info = await client.ptyGet(ownedId, dir);
          if (info.status === "running" && samePath(info.cwd, dir)) pty = info;
          else store.setPtyId(dir, null);
        } catch { store.setPtyId(dir, null); }
        if (gen !== genRef.current) return;
      }
      if (!pty) {
        term.reset();
        cursorRef.current = 0;
        pty = await client.ptyCreate(dir, "Enki", { cols: term.cols, rows: term.rows });
        if (gen !== genRef.current) { await client.ptyKill(pty.id, dir); return; }
        store.setPtyId(dir, pty.id);
      } else if (ptyRef.current?.id !== pty.id) { term.reset(); cursorRef.current = 0; }
      ptyRef.current = pty;
      setTitle(pty.title || "Терминал");
      await follow(pty, gen);
    } catch (e) {
      if (gen !== genRef.current) return;
      setStatus("error");
      setError(errText(e));
    }
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const xterm = createXterm(el);
    termRef.current = xterm.term;
    refitRef.current = xterm.refit;
    // Keystrokes are delivered in order; a failed write is shown, never replayed.
    const data = xterm.term.onData(value => {
      const pty = ptyRef.current;
      if (!pty || !dir || !client || streamRef.current === null) {
        xterm.term.write("\r\n\x1b[31m[терминал отключён — нажмите «Переподключить»]\x1b[0m\r\n");
        return;
      }
      inputRef.current = inputRef.current.then(() => client.ptyInput(pty.id, dir, value))
        .catch(e => { xterm.term.write(`\r\n\x1b[31m[ввод не доставлен: ${errText(e)}]\x1b[0m\r\n`); });
    });
    const resized = xterm.term.onResize(pushSize);
    const observer = new ResizeObserver(() => { xterm.refit(); });
    observer.observe(el);
    void start(false);
    return () => {
      genRef.current++;
      observer.disconnect();
      data.dispose(); resized.dispose();
      detach();
      if (resizeTimer.current) window.clearTimeout(resizeTimer.current);
      xterm.dispose();
      termRef.current = null;
      refitRef.current = () => false;
      ptyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, client]);

  // keep terminal colors in sync with theme switches (CSS variables update one frame later)
  useEffect(() => {
    const timer = setTimeout(() => { if (termRef.current) termRef.current.options.theme = terminalTheme(); }, 0);
    return () => clearTimeout(timer);
  }, [s.prefs.theme]);

  const kill = async () => {
    const pty = ptyRef.current;
    if (!pty || !dir || !client) return;
    genRef.current++;
    detach();
    const gen = genRef.current;
    try {
      // Returns at once: the runtime sends one signal and tracks a bounded close.
      await client.ptyKill(pty.id, dir);
      if (gen !== genRef.current || client !== store.client) return;
      store.setPtyId(dir, null);
      ptyRef.current = null;
      setStatus("closed");
      termRef.current?.write("\r\n[сигнал завершения отправлен]\r\n");
      void refreshClosing();
    } catch (e) {
      store.setUi({ toast: `Не удалось закрыть терминал: ${errText(e)}` });
    }
  };

  // Closed shells whose cleanup the runtime cannot confirm (descendants may
  // survive SIGHUP). Shown with an explicit detach; never reported as idle.
  const [closing, setClosing] = useState<PtyClosingDTO[]>([]);
  const refreshClosing = async () => {
    if (!dir || !client) { setClosing([]); return; }
    for (let attempt = 0; attempt < 8; attempt++) {
      const list = await client.ptyClosing(dir).catch(() => null);
      if (!list || dir !== store.state.directory) return;
      setClosing(list);
      if (!list.some(item => item.state === "closing")) return;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  };
  useEffect(() => { void refreshClosing(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [dir, client]);
  const detachClosed = async (id: string) => {
    if (!dir || !client) return;
    try {
      await client.ptyDetach(id, dir);
      store.setUi({ toast: "Оболочка отсоединена. Enki больше её не отслеживает; очистка фоновых процессов не подтверждена." });
    } catch (e) { store.setUi({ toast: `Не удалось отсоединить: ${errText(e)}` }); }
    void refreshClosing();
  };

  const label = { open: "подключён", connecting: "подключение…", closed: "отключён", exited: "оболочка завершилась", error: "ошибка", idle: "ожидание" }[status];
  return (
    <div className="term-wrap">
      <div className="term-toolbar">
        <span className="term-title" title={dir ?? ""}>{title}</span>
        <span className={`status-dot ${status === "open" ? "ok" : status === "connecting" ? "warn" : status === "idle" ? "" : "bad"}`} aria-label={`Терминал: ${label}`} />
        <span className="term-status">{label}</span>
        <span style={{ flex: 1 }} />
        {status !== "open" && status !== "connecting" && (
          <button className="btn small" onClick={() => void start(status === "exited")} aria-label="Переподключить терминал">
            {status === "exited" ? "Новая оболочка" : "Переподключить"}
          </button>
        )}
        <button className="btn small ghost" onClick={() => void kill()} aria-label="Завершить оболочку"
          title="Завершить процесс оболочки. Пока оболочка запущена, обновление Enki ожидает её закрытия.">
          Завершить
        </button>
        <button className="btn small ghost" onClick={() => store.setLayout({ bottomOpen: false })} aria-label="Скрыть панель терминала"
          title="Скрыть панель. Оболочка продолжит работать.">
          ✕
        </button>
      </div>
      {status === "error" && error && <div className="panel-note" role="alert">{error}</div>}
      {closing.map(item => (
        <div key={item.id} className="panel-note" role="status">
          {item.state === "closing" ? "Терминал закрывается…" : item.detail}
          {item.state === "cleanup-unknown" && (
            <button className="btn small ghost" onClick={() => void detachClosed(item.id)}
              title="Enki перестанет отслеживать эту оболочку. Процессы не завершаются и их очистка не подтверждается.">
              Отсоединить
            </button>
          )}
        </div>
      ))}
      <div ref={containerRef} className="term-host" />
    </div>
  );
}
