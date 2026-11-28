import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { browserNative } from "../browser/integration";
import { browserEnabled } from "../browser/preferences";
import { isNative } from "../native/platform";
import { isLocalComputer } from "../state/computer";
import { store, useAppState } from "../state/store";
import { presentations } from "./browserPresentationState";

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
    void listen<{mode:string;scope?:{engine:string;sessionID:string}}>("browser-monitor://presentation", event => {
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
    }).then(unlisten => { if (cancelled) unlisten(); else stop = unlisten; }).catch(() => {});
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

