import { useSyncExternalStore } from "react";
import { isNative } from "../native/platform";
import { browserEnabled, browserNodeProgram } from "./preferences";

import { browserEnvironment, type BrowserEnvironment } from "./environment";

export const BROWSER_MCP = "desktop_browser";
export interface BrowserPreferences { enabled?: boolean; nodeProgram?: string; mode?: "fast" | "human"; taskEffort?: "low" | "medium"; environment?: Partial<BrowserEnvironment> }
export interface BrowserStatus {
  supported: boolean; installed: boolean; running: boolean; browserOpen?: boolean;
  command: string; nodeProgram: string | null; skillPath: string; runtimePath: string;
  profilePath: string; version: string | null; error?: string | null;
}
export interface BrowserSetup {
  phase: "idle" | "checking" | "installing" | "configuring" | "ready" | "disabled" | "error";
  status?: BrowserStatus;
  /** How the agent runtime sees the browser tools (loaded per new session). */
  agent: string;
  error?: string;
}
/** Phases during which a background setup job owns the state. */
const IN_PROGRESS: readonly BrowserSetup["phase"][] = ["checking", "installing", "configuring"];
const INITIAL: BrowserSetup = { phase: "idle", agent: "Не проверено" };
let state = INITIAL;
const listeners = new Set<() => void>();
function publish(patch: Partial<BrowserSetup>) {
  state = { ...state, ...patch }; listeners.forEach(listener => listener());
}
export function useBrowserSetup() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state);
}
export function browserSetupSnapshot() { return state; }
export async function browserNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isNative()) throw new Error("Управляемый браузер доступен в установленном приложении.");
  return (await import("@tauri-apps/api/core")).invoke<T>(command, args);
}
export async function openSessionBrowser(selection: { directory: string | null; engine: string; sessionId: string | null },
  current: () => boolean, url: string | null, nodeProgram?: string | null, invoke = browserNative): Promise<BrowserStatus> {
  if (!selection.directory || !selection.sessionId) throw new Error("Выберите чат для браузера.");
  await invoke("browser_start", { nodeProgram });
  if (!current()) throw new Error("Выбран другой чат; браузер не открыт.");
  const selected = await invoke<{result:{scopeKey:string;scope:{engine:string;sessionID:string}}}>("browser_session", selection);
  if (!current()) throw new Error("Выбран другой чат; браузер не открыт.");
  if (selected.result.scope?.engine !== selection.engine || selected.result.scope?.sessionID !== selection.sessionId)
    throw new Error("Браузер уже выбран для другого чата.");
  return invoke("browser_open", { url, nodeProgram, scopeKey: selected.result.scopeKey });
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export interface SetupOptions {
  /** The runtime runs on this computer; the managed browser never serves a remote host. */
  local: boolean;
  preferences?: BrowserPreferences;
  current: () => boolean;
  /**
   * Tell the runtime whether to attach its browser tools to new sessions.
   * Sessions that are already open keep the tools they started with.
   */
  syncRuntime: (enabled: boolean) => Promise<void>;
}
type Invoke = typeof browserNative;
let flight: Promise<BrowserStatus | undefined> | null = null;
let flightKey = "";
/** Identifies the newest setup job; only it may settle a stale in-progress phase. */
let flightSerial = 0;
let setupRevision = 0;

/** Start setup over on the next request (preference change, explicit check, reconnect). */
export function invalidateBrowserSetup(_options: { keepAttachments?: boolean } = {}) {
  setupRevision++; flightKey = "";
}
function current(o: SetupOptions, revision: number) { return o.current() && revision === setupRevision; }

/**
 * A detached job: install (first time) and start the managed browser daemon,
 * apply the user's browser preferences and tell the agent runtime to load its
 * browser tools. Downloads never block connecting or changing project. No
 * external agent configuration is read or written. Identical concurrent
 * requests receive the very same in-flight promise (not an async wrapper).
 */
export function configureLocalBrowser(o: SetupOptions, invoke: Invoke = browserNative): Promise<BrowserStatus | undefined> {
  if (!o.local || (invoke === browserNative && !isNative())) return Promise.resolve(undefined);
  const revision = setupRevision;
  const key = JSON.stringify([o.preferences]);
  if (flight && flightKey === key) return flight;
  flightKey = key;
  const serial = ++flightSerial;
  const superseded = () => {
    if (current(o, revision)) return false;
    if (serial === flightSerial && IN_PROGRESS.includes(state.phase)) publish({ phase: "idle", error: undefined });
    return true;
  };
  flight = (async () => {
    publish({ phase: "checking", error: undefined });
    const enabled = browserEnabled({ browser: o.preferences });
    const nodeProgram = browserNodeProgram({ browser: o.preferences });
    let status = await invoke<BrowserStatus>("browser_status", { nodeProgram });
    if (superseded()) return;
    if (!enabled) {
      // Stop first: a configuration problem must never keep the browser running.
      await invoke("browser_stop");
      await o.syncRuntime(false).catch(() => {});
      if (superseded()) return;
      publish({ phase: "disabled", status: { ...status, running: false, browserOpen: false }, agent: "Выключен" });
      return;
    }
    if (!status.supported) throw new Error(status.error || "Браузер недоступен на этой платформе.");
    if (!status.installed) {
      publish({ phase: "installing", status });
      status = await invoke<BrowserStatus>("browser_install", { nodeProgram });
    }
    if (superseded()) return;
    if (!status.installed) throw new Error(status.error || "Инструментарий браузера не установлен.");
    status = await invoke<BrowserStatus>("browser_start", { nodeProgram });
    if (superseded()) return;
    if (!status.running) throw new Error(status.error || "Сервис браузера не запущен.");
    await invoke("browser_input", { action: "preferences", args: { environment: browserEnvironment(o.preferences?.environment) } });
    if (superseded()) return;
    await invoke("browser_input", { action: "mode", args: { mode: o.preferences?.mode === "human" ? "human" : "fast" } });
    if (superseded()) return;
    publish({ phase: "configuring", status });
    await o.syncRuntime(true);
    if (superseded()) return;
    publish({ phase: "ready", status, agent: "Подключается к новым сессиям агента" });
    return status;
  })().catch(error => {
    if (!superseded()) publish({ phase: "error", error: message(error) });
    return undefined;
  });
  return flight;
}
