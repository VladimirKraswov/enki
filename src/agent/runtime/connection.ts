// How the WebView reaches an Enki Runtime. Never a URL token, never a fallback:
// - this computer: the native supervisor starts (or reuses) the bundled runtime
//   and returns its loopback endpoint and current bearer (`runtime_connection`);
// - an SSH host: the native side runs the installed remote runtime's `ensure`
//   over strict-key SSH and forwards its loopback port (`connect_remote_runtime`).
// A remote failure is reported as such; it never silently switches to local.
import { isNative } from "../../native/platform";
import type { RemoteHost } from "../../native/hosts";
import { validRemote } from "../../native/hosts";
import type { RuntimeConnection } from "./client";
import type { NativeUiScope } from "./pluginUi/types";

export const CONTRACT = 1;

function checked(connection: RuntimeConnection): RuntimeConnection {
  if (connection.contract !== CONTRACT)
    throw new Error(`Среда выполнения Enki (контракт ${connection.contract}) несовместима с этим интерфейсом (контракт ${CONTRACT}). Перезапустите Enki после обновления.`);
  return connection;
}

export async function localConnection(): Promise<RuntimeConnection> {
  if (!isNative()) throw new Error("Среда выполнения Enki доступна в установленном приложении.");
  const { invoke } = await import("@tauri-apps/api/core");
  return checked(await invoke<RuntimeConnection>("runtime_connection"));
}

export async function remoteConnection(host: RemoteHost): Promise<RuntimeConnection> {
  if (!validRemote(host)) throw new Error("Укажите SSH-алиас или user@host.");
  if (!isNative()) throw new Error("SSH-подключения доступны в установленном Enki.");
  const { invoke } = await import("@tauri-apps/api/core");
  const remote = await invoke<RuntimeConnection & { target: string }>("connect_remote_runtime", { target: host.target });
  return checked({ endpoint: remote.endpoint, token: remote.token, instance: remote.instance, version: "remote", contract: remote.contract });
}

/** Rotated bearer tokens are announced natively; the client refreshes lazily on 401 too. */
export async function onTokenRotated(listener: () => void): Promise<() => void> {
  if (!isNative()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen("enki-runtime://token", () => listener());
}

export type NativeUiAction = "clipboard.read" | "clipboard.write" | "open-url";

/**
 * One trusted user gesture in the active plugin surface → a short-lived (1.5 s),
 * exact-scope, one-use-per-action native grant. Must run BEFORE the input that
 * may make the extension copy, paste or open a link. No shell/OSC fallback.
 */
export async function authorizeNativeUi(scope: NativeUiScope, actions: readonly NativeUiAction[]): Promise<void> {
  if (!isNative() || !actions.length) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("runtime_ui_authorize", {
    scope: { hostId: scope.hostId, sessionId: scope.sessionId, sessionEpoch: scope.sessionEpoch, surfaceId: scope.surfaceId, directory: scope.directory, principal: scope.principal },
    actions: [...actions],
  });
}

/** Remote runtimes ask the attached desktop for Hub operations (never for local secrets). */
export async function relayBroker(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (!isNative()) throw new Error("Hub доступен в установленном Enki.");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("runtime_broker_relay", { method, params });
}
