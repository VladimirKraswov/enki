import type { Session } from "../api/types";
import type { ConnectionState } from "./types";

/** Background work needs the runtime-wide stream. The selected folder can
 * also confirm its own chats through its directory-scoped stream. A failed
 * status read remains unconfirmed; the icon then describes the connection. */
export function liveStatusConfirmed(connection: Pick<ConnectionState, "phase" | "streamState" | "globalStreamState" | "statusError">,
  directory: string, currentDirectory: string | null): boolean {
  return connection.phase === "connected" && !(directory === currentDirectory && connection.statusError)
    && (connection.globalStreamState === "open" || (directory === currentDirectory && connection.streamState === "open"));
}

/** Selecting another chat must not turn a running task into "unconfirmed".
 * Only a lasting stream outage or a failed status check may do that. */
export function sessionStatusConfirmed(connection: Pick<ConnectionState, "phase" | "statusError">,
  directory: string, currentDirectory: string | null, stalled: boolean): boolean {
  if (connection.phase !== "connected") return false;
  return !stalled && !(directory === currentDirectory && !!connection.statusError);
}

/** A tool waiting for its user still keeps the SDK busy. Attention wins. */
export function sessionWorkMark(pending: boolean, status: string | undefined, confirmed: boolean): "waiting" | "working" | "unconfirmed" | "none" {
  if (pending) return "waiting";
  if (status === "busy" || status === "retry" || status === "waiting") return confirmed ? "working" : "unconfirmed";
  return "none";
}

export interface SidebarList {
  sessions: Session[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  limit: number;
  hasMore: boolean;
}
export interface RecentList extends SidebarList {
  archived: boolean;
  cursor: number | null;
}
export const emptySidebarList = (): SidebarList => ({
  sessions: [], loading: false, loaded: false, error: null, limit: 50, hasMore: false,
});
export const emptyRecentList = (): RecentList => ({
  ...emptySidebarList(), archived: false, cursor: null,
});

export function sortSessionsByActivity(sessions: Session[], activityAt: (id: string) => number): Session[] {
  return [...sessions].sort((a, b) =>
    Math.max(b.time.updated, activityAt(b.id)) - Math.max(a.time.updated, activityAt(a.id))
    || a.id.localeCompare(b.id));
}

/** Replay changes received during a list request, including deletions. */
export function mergeSidebarSessions(
  snapshot: Session[], changes: Map<string, Session | null> = new Map(),
): Session[] {
  const index = new Map(snapshot.map((s) => [s.id, s]));
  for (const [id, session] of changes) {
    if (session) index.set(id, session);
    else index.delete(id);
  }
  return [...index.values()].filter((s) => !s.parentID)
    .sort((a, b) => b.time.updated - a.time.updated || a.id.localeCompare(b.id));
}

/** Sessions whose stored status still claims work: these are the only ones a
 * reconciliation must re-check. `waiting` counts — it also draws a spinner. */
export function activeStatusIds(statuses: Record<string, { type?: string } | undefined>,
  directoryOf: (id: string) => string | undefined, directory: string): string[] {
  return Object.entries(statuses)
    .filter(([id, status]) => directoryOf(id) === directory && (status?.type === "busy" || status?.type === "retry" || status?.type === "waiting"))
    .map(([id]) => id);
}
