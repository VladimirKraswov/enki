import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { authorizeNativeUi } from "../agent/runtime/connection";
import type { PluginUiSession } from "../agent/runtime/pluginUi/session";
import { PluginSurfaceController, type SurfaceState } from "../agent/runtime/pluginUi/surfaceController";
import type { NativeUiScope, UiScope } from "../agent/runtime/pluginUi/types";
import { createXterm, terminalTheme } from "./xtermHost";

const initial: SurfaceState = { status: "connecting", detail: "Подключаю интерфейс расширения…", canInput: false, cols: null, rows: null };

/**
 * The actual SDK TUI (custom components, overlays, expanded editor) running in
 * the runtime worker, rendered by the app's xterm host. It never evaluates
 * remote code and never creates a shell. Focus is granted only by the user.
 */
export function PluginTerminalSurface({ session, scope, generation, nativeScope, themeKey }: {
  session: PluginUiSession; scope: UiScope; generation: number; nativeScope: NativeUiScope | null; themeKey: string;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<PluginSurfaceController | null>(null);
  const focusRef = useRef<() => void>(() => {});
  const termRef = useRef<Terminal | null>(null);
  const nativeRef = useRef(nativeScope);
  nativeRef.current = nativeScope;
  const gestureRef = useRef<Promise<void>>(Promise.resolve());
  const [state, setState] = useState<SurfaceState>(initial);

  /** Trusted gesture in the active surface → exact-scope native grant BEFORE the input it precedes. */
  const gesture = () => {
    const scoped = nativeRef.current;
    if (!scoped || !controllerRef.current?.controls) return;
    gestureRef.current = authorizeNativeUi(scoped, ["clipboard.read", "clipboard.write", "open-url"]).catch(() => undefined);
  };

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let alive = true, fitFrame: number | null = null, current: SurfaceState = initial;
    const xterm = createXterm(host, { disableStdin: true, cursorBlink: false, scrollback: 2000, screenReaderMode: true });
    const { term } = xterm;
    termRef.current = term;
    focusRef.current = () => term.focus();
    const controller = new PluginSurfaceController(scope, session, {
      reset: () => term.reset(),
      resize: (cols, rows) => term.resize(cols, rows),
      write: (data, complete) => term.write(data, complete),
    }, next => {
      if (!alive) return;
      current = next;
      term.options.disableStdin = !next.canInput;
      setState(next);
      if (next.canInput) scheduleFit();
    });
    controllerRef.current = controller;
    function scheduleFit(): void {
      if (!alive || fitFrame !== null) return;
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = null;
        // A viewer keeps the controller's cell grid; only the controller resizes the shared UI.
        if (!alive || !current.canInput) return;
        const proposed = xterm.fit.proposeDimensions();
        if (!proposed || proposed.cols < 1 || proposed.rows < 1 || proposed.cols > 1000 || proposed.rows > 1000) return;
        if (xterm.refit()) controller.resize(term.cols, term.rows);
      });
    }
    // Keys stay ordered: every input waits for the latest gesture grant, then queues in sequence.
    let chain: Promise<void> = Promise.resolve();
    const send = (data: string) => { chain = chain.then(() => gestureRef.current).then(() => { controller.input(data); }); };
    const data = term.onData(send);
    const binary = term.onBinary(send);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleFit);
    observer?.observe(host);
    void controller.connect();
    return () => {
      alive = false;
      observer?.disconnect();
      if (fitFrame !== null) window.cancelAnimationFrame(fitFrame);
      data.dispose(); binary.dispose();
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
      focusRef.current = () => {};
      if (termRef.current === term) termRef.current = null;
      xterm.dispose();
    };
  }, [session, scope.hostId, scope.sessionId, scope.sessionEpoch, scope.surfaceId, generation]);

  useEffect(() => {
    // applyTheme runs in the store; read CSS variables after it settles.
    const timer = setTimeout(() => { if (termRef.current) termRef.current.options.theme = terminalTheme(); }, 0);
    return () => clearTimeout(timer);
  }, [themeKey]);

  const failed = state.status === "error" || state.status === "closed";
  return <section className="plugin-surface" aria-label="Интерфейс расширения" data-state={state.status}
    onKeyDownCapture={event => { if (state.canInput) { gesture(); event.stopPropagation(); } }}
    onMouseDownCapture={() => { if (state.canInput) gesture(); }}>
    <div className="plugin-surface-toolbar">
      <span className="plugin-surface-status" role={failed ? "alert" : "status"} aria-live="polite">{state.detail}</span>
      {state.status === "readonly" && <button type="button" className="btn small" onClick={() => void controllerRef.current?.takeControl()}>Управлять</button>}
      {state.canInput && <button type="button" className="btn small" onClick={() => focusRef.current()}>Ввести в интерфейс</button>}
      {state.canInput && <button type="button" className="btn small ghost" onClick={() => void controllerRef.current?.releaseControl()}>Отпустить</button>}
      {failed && <button type="button" className="btn small" onClick={() => void controllerRef.current?.connect()}>Подключиться снова</button>}
    </div>
    <div className="plugin-surface-viewport" ref={container} aria-label="Экран расширения" />
  </section>;
}
