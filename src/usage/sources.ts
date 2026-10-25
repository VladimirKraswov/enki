import type { Session } from "../api/types";
import type { RuntimeBackend } from "../agent/runtime/backend";
import { store } from "../state/store";
import type { UsageSource } from "./metrics";

/** Every chat of the runtime catalogue (active and archived), paged by the runtime cursor. */
async function runtimeSessions(backend: RuntimeBackend, signal: AbortSignal): Promise<Session[]> {
  const sessions = new Map<string, Session>();
  for (const archived of [false, true]) {
    let cursor: number | undefined;
    const cursors = new Set<number>();
    do {
      signal.throwIfAborted();
      const page = await backend.recentSessions(archived, cursor);
      for (const session of page.sessions) sessions.set(session.id, session);
      if (page.cursor === null || cursors.has(page.cursor)) break;
      cursor = page.cursor;
      cursors.add(cursor);
    } while (true);
  }
  return [...sessions.values()];
}

/**
 * One runtime serves both: chats executed by the bundled agent ("Pi") and
 * read-only imported OpenCode archives ("OpenCode"), whose recorded usage stays
 * attributed to the engine that produced it.
 */
export function usageSources(): UsageSource[] {
  const backend = store.state.connection.phase === "connected" ? store.maybeBackend() : null;
  if (!backend) return [];
  let all: Promise<Session[]> | null = null;
  const sessions = (signal: AbortSignal) => (all ??= runtimeSessions(backend, signal).catch(error => { all = null; throw error; }));
  const messages: UsageSource["messages"] = (session, before, signal) =>
    backend.messages(session.id, { directory: session.directory, before, limit: 200, signal });
  return [
    { engine: "Pi", sessions: async signal => (await sessions(signal)).filter(s => s.origin?.kind !== "opencode"), messages },
    { engine: "OpenCode", sessions: async signal => (await sessions(signal)).filter(s => s.origin?.kind === "opencode"), messages },
  ];
}
