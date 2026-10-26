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
