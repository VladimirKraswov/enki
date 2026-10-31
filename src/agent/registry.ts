// The single agent backend: the bundled Enki Runtime (Pi SDK).
//
// There is no engine catalogue any more. A workspace is either the runtime on
// this computer or the runtime installed on an SSH host; both are reached through
// `RuntimeBackend`. A remote target never falls back to the local runtime: the
// caller gets the remote failure and decides what to show.

import { remoteKey, type RemoteHost } from "../native/hosts";
import { RuntimeBackend } from "./runtime/backend";
import type { RuntimeConnection } from "./runtime/client";
import { localConnection, remoteConnection } from "./runtime/connection";
import { LOCAL_WORKSPACE, RUNTIME_AGENT_ID } from "./runtime/ids";

export type RuntimeTarget =
  | { kind: "local" }
  | { kind: "remote"; host: RemoteHost };

/** Stable workspace identity used for preference scoping and request guards. */
export function workspaceKey(target: RuntimeTarget): string {
  return target.kind === "local" ? LOCAL_WORKSPACE : remoteKey(target.host);
}

function connector(target: RuntimeTarget): () => Promise<RuntimeConnection> {
  if (target.kind === "local") return localConnection;
  const host = target.host;
  return () => remoteConnection(host);
}

/**
 * Connects to the runtime of `target`. The same connector refreshes a rotated
 * token or a restarted runtime, so a remote backend only ever re-resolves the
 * same remote host.
 */
export async function connectRuntime(target: RuntimeTarget): Promise<RuntimeBackend> {
  const connect = connector(target);
  return new RuntimeBackend(await connect(), connect, workspaceKey(target));
}

/** Exact lookup kept for persisted ids: only the runtime id is known. */
export function isKnownBackend(id?: string | null): boolean {
  return id === RUNTIME_AGENT_ID;
}
