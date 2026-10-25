import { UpdateRuntime } from "./updates/runtime";
import { MemoryRuntime } from "./memory/Runtime";
import { HubRuntime } from "./hub/Runtime";
import { ContextPanel } from "./components/ContextPanel";
import { ScheduleRuntime } from "./schedules/Runtime";
import { HandoffDialog } from "./components/HandoffDialog";
import { BrowserPanel, BrowserPresence } from "./components/BrowserPanel";
import { PiDialog } from "./components/PiDialog";
import { HostDialogs } from "./components/HostDialogs";
import { PluginUiBelowComposer, PluginUiPanel } from "./components/PluginUiPanel";
import { RUNTIME_CAPABILITIES } from "./agent/runtime/backend";
import { store, useAppSelector, applyTheme } from "./state/store";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { ChatView } from "./components/ChatView";
import { Composer } from "./components/Composer";
import { RightPanel } from "./components/RightPanel";
import {
  ConnectionGate,
  DeleteConfirm,
  Toast,
} from "./components/Dialogs";
import { TerminalPanel } from "./components/TerminalPanel";
import { Palette } from "./components/Palette";
const SettingsScreen = lazy(() => import("./components/SettingsScreen").then(m => ({default:m.SettingsScreen})));
import { useEffect, lazy, Suspense } from "react";
import { hasOverlayWindowControls, isNative, platform } from "./native/platform";
import { startResize } from "./util/resize";


const shellSnapshot = (s: import('./state/types').AppState) => ({
  prefs:s.prefs, ui:s.ui, activeSessionId:s.activeSessionId, directory:s.directory,
  connection:s.connection,
});
export default function App() {
  const s = useAppSelector(shellSnapshot);

  useEffect(() => {
    // Sequential startup: connect() only touches projects after health succeeded.
    // connect() is idempotent, so a StrictMode double-invoke shares one attempt.
    applyTheme(store.state.prefs.theme);
    void store.connect().catch(() => {}).finally(() => store.restorePiRuntime()).catch(() => {});
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void store.refreshPiActivity(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const markRead = () => store.markReadIfViewing();
    window.addEventListener("focus", markRead);
    document.addEventListener("visibilitychange", markRead);
    return () => {
      window.removeEventListener("focus", markRead);
      document.removeEventListener("visibilitychange", markRead);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === ",") {
        e.preventDefault();
        store.setUi({ settingsOpen: true, paletteOpen: false });
        return;
      }
      if (store.state.ui.settingsOpen) return;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        store.setUi({ paletteOpen: !store.state.ui.paletteOpen });
      } else if (mod && e.key.toLowerCase() === "n" && !e.shiftKey) {
        e.preventDefault();
        void store.newSession();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        store.setLayout({ rightOpen: !store.state.prefs.layout.rightOpen });
      } else if (e.key === "`" && (e.ctrlKey || (mod && e.shiftKey))) {
        e.preventDefault();
        void store.toggleTerminal();
      } else if (e.key === "Escape") {
        if (store.state.ui.contextOpen) store.setUi({ contextOpen: false });
        if (store.state.ui.paletteOpen) store.setUi({ paletteOpen: false });
        if (store.state.ui.hostDialogOpen || store.state.ui.remoteFolderOpen) return;
        if (store.state.ui.confirmDelete) store.setUi({ confirmDelete: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const layout = s.prefs.layout;
  // Static runtime capabilities: `store.backend` throws before the first connection.
  const capabilities = RUNTIME_CAPABILITIES;
  // Read-only OpenCode archives have no SDK worker and therefore no plugin UI.
  const pluginChat = s.activeSessionId && s.directory && !store.isLegacySession(s.activeSessionId)
    ? { sessionId: s.activeSessionId, directory: s.directory } : null;

  return (
    <div
      className={`app-shell platform-${platform()}${isNative() ? " native" : ""}${hasOverlayWindowControls() ? " mac-chrome" : ""}${s.activeSessionId ? "" : " new-task"}${layout.sidebarOpen ? "" : " sidebar-hidden"}`}
    >
      <div className="app-body" inert={s.ui.settingsOpen} aria-hidden={s.ui.settingsOpen || undefined} style={s.ui.settingsOpen ? { visibility: "hidden" } : undefined}>
        {layout.sidebarOpen && <Sidebar />}
        <BrowserPresence />
        <ScheduleRuntime />
        <HubRuntime /><MemoryRuntime /><UpdateRuntime />
        <div
          className="resizer-v"
          style={{ display: layout.sidebarOpen ? undefined : "none" }}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            startResize({
              initial: layout.sidebarWidth,
              min: 180,
              max: 420,
              apply: (px) => store.setLayout({ sidebarWidth: px }),
            });
          }}
        />
        <div className="center-col">
          <TopBar />
          <div className="center-main">
            <div className="chat-col">
              {/* Anchored to the chat column so it never covers the browser or review pane. */}
              {s.ui.contextOpen && <ContextPanel />}
              {s.connection.phase === "connected" ||
              s.connection.phase === "connecting" ? (
                <>
                  <ChatView />
                  {pluginChat && <PluginUiPanel key={`${pluginChat.directory}\n${pluginChat.sessionId}`} {...pluginChat} />}
                  <Composer />
                  {pluginChat && <PluginUiBelowComposer />}
                </>
              ) : (
                <ConnectionGate />
              )}
            </div>
            {s.ui.browserOpen && s.activeSessionId && <BrowserPanel key={JSON.stringify([s.prefs.workspaceKey ?? s.prefs.endpoint, s.directory, store.engineIdFor(), s.activeSessionId])} />}
            {!s.ui.browserOpen && layout.rightOpen && store.workspaceToolsAvailable() && (
              <>
                <div
                  className="resizer-v"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize review panel"
                  onPointerDown={(e) => {
                    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                    startResize({
                      initial: layout.rightWidth,
                      min: 240,
                      max: 720,
                      direction: -1,
                      apply: (px) =>
                        store.setLayout({
                          rightWidth: px,
                        }),
                    });
                  }}
                />
                <RightPanel />
              </>
            )}
          </div>
          {layout.bottomOpen && store.workspaceToolsAvailable() && (
            <>
              <div
                className="resizer-h"
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize terminal panel"
                onPointerDown={(e) => {
                  (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                  startResize({
                    initial: layout.bottomHeight,
                    min: 90,
                    max: 600,
                    direction: -1,
                    axis: "y",
                    apply: (px) => store.setLayout({ bottomHeight: px }),
                  });
                }}
              />
              <div
                className="bottom-panel"
                style={{ height: layout.bottomHeight }}
              >
                <TerminalPanel />
              </div>
            </>
          )}
        </div>
      </div>
      {s.ui.paletteOpen && <Palette />}
      {s.ui.settingsOpen && <Suspense fallback={<div role="status">Загрузка настроек…</div>}><SettingsScreen /></Suspense>}
      <HostDialogs />
      {capabilities.fork && <HandoffDialog />}
      <PiDialog />
      <DeleteConfirm />
      <Toast />
    </div>
  );
}
