// Saved SSH hosts. The bundled Enki Runtime installed on the host is reached by
// the native side only (`connect_remote_runtime`: strict known-host SSH, runtime
// `ensure`, forwarded loopback port); see src/agent/runtime/connection.ts.
export interface RemoteHost {
  id: string;
  name: string;
  target: string;
  /**
   * Identity only. Part of the saved workspace key (`ssh:<target>:<port>`) that
   * scopes drafts, queues, timers and history of this host; the runtime chooses
   * its own loopback port on the host, so this value is never dialled.
   */
  port: number;
}
/** Identity port of hosts added since the external engine was retired (old default). */
export const DEFAULT_REMOTE_IDENTITY_PORT = 4096;
export function remoteKey(host: RemoteHost): string {
  return `ssh:${host.target}:${host.port}`;
}
export function validRemote(
  host: Pick<RemoteHost, "target" | "port">,
): boolean {
  return (
    /^[a-zA-Z0-9_][a-zA-Z0-9_.@:%\[\]-]{0,252}$/.test(host.target) &&
    Number.isInteger(host.port) &&
    host.port > 0 &&
    host.port <= 65535
  );
}
export async function sshAliases(): Promise<string[]> {
  if (!("__TAURI_INTERNALS__" in window)) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("ssh_aliases");
}
