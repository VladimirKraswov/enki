import { useEffect, lazy, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import { UpdateRuntime } from "./updates/runtime";
import { MemoryRuntime } from "./memory/Runtime";
import { HubRuntime } from "./hub/Runtime";
import { ChatWorkspace } from "./components/ChatWorkspace";
import { ScheduleRuntime } from "./schedules/Runtime";
import { RemotePasteInbox } from "./components/RemotePasteInbox";
import { BrowserPresence } from "./components/BrowserPresence";
import { HostDialogs } from "./components/HostDialogs";
import { PermissionRuntime } from "./components/PermissionCenter";
import { RUNTIME_CAPABILITIES } from "./agent/runtime/backend";
import { store, useAppSelector, applyTheme } from "./state/store";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { ChatView } from "./components/ChatView";
import { Composer } from "./components/Composer";
import { ConnectionGate, DeleteConfirm, Toast } from "./components/Dialogs";
import { hasOverlayWindowControls, isNative, platform } from "./native/platform";
import { startResize } from "./util/resize";
import { COMPUTER_SERVER, setReservedServer } from "./capabilities/reserved";
import { invalidateCapabilities } from "./capabilities/integration";
import { isLocalComputer } from "./state/computer";
import { restoreComputerAfterUpdate } from "./computer/restore";

const HandoffDialog = lazy(() => import("./components/HandoffDialog").then(m => ({ default: m.HandoffDialog })));
const RemoteSendDialog = lazy(() => import("./components/RemoteSendDialog").then(m => ({ default: m.RemoteSendDialog })));
const PiDialog = lazy(() => import("./components/PiDialog").then(m => ({ default: m.PiDialog })));
const PluginUiBelowComposer = lazy(() => import("./components/PluginUiPanel").then(m => ({ default: m.PluginUiBelowComposer })));
const PluginUiPanel = lazy(() => import("./components/PluginUiPanel").then(m => ({ default: m.PluginUiPanel })));
const McpRecoveryNotice = lazy(() => import("./components/McpRecoveryNotice").then(m => ({ default: m.McpRecoveryNotice })));
const ContextPanel = lazy(() => import("./components/ContextPanel").then(m => ({ default: m.ContextPanel })));
const RightPanel = lazy(() => import("./components/RightPanel").then(m => ({ default: m.RightPanel })));
const TerminalPanel = lazy(() => import("./components/TerminalPanel").then(m => ({ default: m.TerminalPanel })));
const Palette = lazy(() => import("./components/Palette").then(m => ({ default: m.Palette })));
const SettingsScreen = lazy(() => import("./components/SettingsScreen").then(m => ({default:m.SettingsScreen})));
const BrowserPanel = lazy(() => import("./components/BrowserPanel").then(m => ({ default: m.BrowserPanel })));


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
    if (s.connection.phase === "connected") void store.ensureHubModels?.().catch(() => {});
  }, [s.connection.phase, s.prefs.hubModels?.mode]);

  // An update replaces the bundle and its runtime artifact. The owner's computer
  // access must survive that: re-apply the remembered decision once per version.
  useEffect(() => {
    if (s.connection.phase !== "connected") return;
    let cancelled = false;
    void (async () => {
      // Any unavailable piece (a host without the desktop store, a hidden setting)
      // must stay a no-op: startup never fails because of this repair.
      try {
        if (cancelled) return;
        await restoreComputerAfterUpdate({
          native: isNative(),
          local: isLocalComputer(store.state.prefs.endpoint, !!store.currentHost?.()),
          accessMode: () => store.getAccessMode(),
          ownedByOwner: () => !!store.state.prefs.computerEnabledByOwner,
          checkedVersion: () => store.state.prefs.computerCheckedVersion,
          markChecked: (version) => store.markComputerChecked(version),
          status: () => invoke("computer_status"),
          setPolicy: (fullAccess) => invoke("computer_set_policy", { fullAccess }),
          repairBridge: () => invoke("shared_install", { nodeProgram: store.state.prefs.pi?.nodeProgram ?? store.state.prefs.browser?.nodeProgram ?? null }),
          enableEntry: () => setReservedServer(COMPUTER_SERVER, true),
          refreshCapabilities: async () => { invalidateCapabilities(); await store.capabilitiesCommitted(null); },
          report: (message) => store.setUi({ toast: message }),
        });
      } catch { /* never blocks startup */ }
    })();
    return () => { cancelled = true; };
  }, [s.connection.phase]);

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
        <HubRuntime /><MemoryRuntime /><UpdateRuntime /><PermissionRuntime />
        <div
          className="resizer-v"
          style={{ display: layout.sidebarOpen ? undefined : "none" }}
          role="separator"
          aria-orientation="vertical"
          aria-label="Изменить ширину боковой панели"
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
            <ChatWorkspace open={s.ui.contextOpen} panel={<Suspense fallback={null}><ContextPanel active={s.ui.contextOpen} /></Suspense>}>
              {s.connection.phase === "connected" ||
              s.connection.phase === "connecting" ? (
                <>
                  <ChatView />
                  {/* Sibling keys must be distinct: duplicate keys retain orphaned notices when the chat changes. */}
                  {pluginChat && <Suspense fallback={null}><McpRecoveryNotice key={`mcp:${JSON.stringify(pluginChat)}`} {...pluginChat} /></Suspense>}
                  {pluginChat && <Suspense fallback={null}><PluginUiPanel key={`ui:${JSON.stringify(pluginChat)}`} {...pluginChat} /></Suspense>}
                  <Composer />
                  {pluginChat && <Suspense fallback={null}><PluginUiBelowComposer /></Suspense>}
                </>
              ) : (
                <ConnectionGate />
              )}
            </ChatWorkspace>
            {s.ui.browserOpen && s.activeSessionId && <BrowserPanel key={JSON.stringify([s.prefs.workspaceKey ?? s.prefs.endpoint, s.directory, store.engineIdFor(), s.activeSessionId])} />}
            {!s.ui.browserOpen && layout.rightOpen && store.workspaceToolsAvailable() && (
              <>
                <div
                  className="resizer-v"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Изменить ширину панели изменений"
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
                <Suspense fallback={null}><RightPanel /></Suspense>
              </>
            )}
          </div>
          {layout.bottomOpen && store.workspaceToolsAvailable() && (
            <>
              <div
                className="resizer-h"
                role="separator"
                aria-orientation="horizontal"
                aria-label="Изменить высоту терминала"
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
              <Suspense fallback={null}><TerminalPanel /></Suspense>
              </div>
            </>
          )}
        </div>
      </div>
      {s.ui.paletteOpen && <Suspense fallback={null}><Palette /></Suspense>}
      {s.ui.settingsOpen && <Suspense fallback={<div role="status">Загрузка настроек…</div>}><SettingsScreen /></Suspense>}
      <HostDialogs />
      {capabilities.fork && <Suspense fallback={null}><HandoffDialog /></Suspense>}
      {s.ui.remoteSend && <Suspense fallback={null}><RemoteSendDialog /></Suspense>}
      <RemotePasteInbox />
      {s.ui.agentDialog && <Suspense fallback={null}><PiDialog /></Suspense>}
      <DeleteConfirm />
      <Toast />
    </div>
  );
}
