import type { MessageResponse, Session } from "../api/types";
import type { UsageSource } from "./metrics";
import { dayKeyOf, finite, periodStart, type UsageEngine, type UsagePeriod, type UsageReport } from "./metrics";

/**
 * Incremental usage cache. The expensive part of the usage view is pulling every
 * message of every session; we instead persist one compact fact per assistant
 * reply and, on refresh, re-read only sessions the engine reports as newer.
 * Period switching then filters the cached facts in memory.
 */

export interface UsageFact {
  /** Completion time of the reply, ms epoch. */
  t: number;
  /** Model key: engine\0provider\0model. */
  sk: string;
  /** Session id — kept so per-model session counts survive rebuilds. */
  sid: string;
  /** [total, input, output, cacheRead, cacheWrite, other, reasoning] */
  c: number[];
}

export interface UsageCache {
  schema: 1;
  /** `${engine}|${sessionID}` → last ingested session.update time. */
  sessions: Record<string, { updated: number }>;
  /** `${engine}|${sessionID}|${messageID}` → fact. */
  messages: Record<string, UsageFact>;
}

export const CACHE_FILE = "usage-cache.json";
export const LEDGER_FILE = "usage-ledger.json";

export const emptyCache = (): UsageCache => ({ schema: 1, sessions: {}, messages: {} });

export function factOf(message: MessageResponse, sessionID: string, engine: UsageEngine): UsageFact | null {
  const info = message.info;
  if (info.role !== "assistant" || !info.tokens) return null;
  const tokens = info.tokens;
  const input = finite(tokens.input), output = finite(tokens.output);
  const cacheRead = finite(tokens.cache?.read), cacheWrite = finite(tokens.cache?.write);
  const classified = input + output + cacheRead + cacheWrite;
  const total = Math.max(finite(tokens.total), classified);
  if (!total) return null;
  const t = info.time.completed ?? info.time.created;
  if (!t) return null; // a reply without a usable timestamp cannot be bucketed
  return {
    t,
    sk: `${engine}\u0000${info.providerID || "Неизвестный провайдер"}\u0000${info.modelID || "Неизвестная модель"}`,
    sid: sessionID,
    c: [total, input, output, cacheRead, cacheWrite, total - classified, Math.min(output, finite(tokens.reasoning))],
  };
}

export interface RefreshOutcome {
  cache: UsageCache;
  changed: boolean;
  refreshedSessions: number;
  failures: string[];
}

/**
 * Reads only the sessions that are new or report a newer update time, and drops
 * facts of sessions the engine no longer lists. The scan of one session replaces
 * all of its previous facts, so regenerated replies stay consistent.
 */
export async function refreshUsageCache(
  sources: UsageSource[],
  cache: UsageCache,
  signal: AbortSignal,
  onProgress?: (done: number, found: number) => void,
): Promise<RefreshOutcome> {
  const next: UsageCache = { schema: 1, sessions: { ...cache.sessions }, messages: { ...cache.messages } };
  const failures: string[] = [];
  let changed = false;
  let refreshed = 0;
  for (const source of sources) {
    signal.throwIfAborted();
    let sessions: Session[];
    try {
      sessions = await source.sessions(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(`${source.engine}: список сессий недоступен`);
      continue;
    }
    const alive = new Set<string>();
    const pending = sessions.filter(session => {
      const key = `${source.engine}|${session.id}`;
      alive.add(key);
      const seen = next.sessions[key];
      return !seen || session.time.updated > seen.updated;
    });
    onProgress?.(0, pending.length);
    let done = 0;
    for (const session of pending) {
      signal.throwIfAborted();
      const key = `${source.engine}|${session.id}`;
      try {
        const facts = new Map<string, UsageFact>();
        let before: string | undefined;
        const cursors = new Set<string>();
        do {
          signal.throwIfAborted();
          const page = await source.messages(session, before, signal);
          signal.throwIfAborted();
          for (const message of page.messages) {
            const fact = factOf(message, session.id, source.engine);
            if (fact) facts.set(`${key}|${message.info.id}`, fact);
          }
          before = page.before;
          if (!before || cursors.has(before)) break;
          cursors.add(before);
        } while (true);
        const prefix = `${key}|`;
        for (const messageKey of Object.keys(next.messages)) {
          if (messageKey.startsWith(prefix)) delete next.messages[messageKey];
        }
        for (const [messageKey, fact] of facts) next.messages[messageKey] = fact;
        next.sessions[key] = { updated: session.time.updated };
        changed = true;
      } catch (error) {
        if (signal.aborted) throw error;
        failures.push(`${source.engine}: не прочитана сессия ${session.id}`);
      }
      done++;
      refreshed++;
      onProgress?.(done, pending.length);
    }
    for (const cachedKey of Object.keys(next.sessions)) {
      if (cachedKey.startsWith(`${source.engine}|`) && !alive.has(cachedKey)) {
        delete next.sessions[cachedKey];
        const prefix = `${cachedKey}|`;
        for (const messageKey of Object.keys(next.messages)) {
          if (messageKey.startsWith(prefix)) delete next.messages[messageKey];
        }
        changed = true;
      }
    }
  }
  return { cache: next, changed, refreshedSessions: refreshed, failures };
}

const emptyRow = () => ({
  total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, other: 0, reasoning: 0, replies: 0,
});

/** Aggregates cached facts for the requested window; no engine reads involved. */
export function reportFromCache(
  cache: UsageCache,
  period: UsagePeriod,
  now = Date.now(),
  failures: string[] = [],
): UsageReport {
  const start = periodStart(period, now);
  const totals = emptyRow();
  const models = new Map<string, { engine: UsageEngine; provider: string; model: string; sessions: Set<string>; row: ReturnType<typeof emptyRow> }>();
  const days = new Map<string, number>();
  const sessionsInWindow = new Set<string>();
  for (const fact of Object.values(cache.messages)) {
    if (fact.t < start) continue;
    const [, provider, model] = fact.sk.split("\u0000");
    const [total, input, output, cacheRead, cacheWrite, other, reasoning] = fact.c;
    totals.total += total;
    totals.input += input;
    totals.output += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
    totals.other += other;
    totals.reasoning += reasoning;
    totals.replies++;
    let entry = models.get(fact.sk);
    if (!entry) {
      const engine: UsageEngine = fact.sk.startsWith("Pi\u0000") ? "Pi" : "OpenCode";
      entry = { engine, provider, model, sessions: new Set<string>(), row: emptyRow() };
      models.set(fact.sk, entry);
    }
    entry.row.total += total;
    entry.row.input += input;
    entry.row.output += output;
    entry.row.cacheRead += cacheRead;
    entry.row.cacheWrite += cacheWrite;
    entry.row.other += other;
    entry.row.reasoning += reasoning;
    entry.row.replies++;
    entry.sessions.add(fact.sid);
    sessionsInWindow.add(fact.sid);
    days.set(dayKeyOf(fact.t), (days.get(dayKeyOf(fact.t)) ?? 0) + total);
  }
  const foundSessions = Object.keys(cache.sessions).length;
  return {
    totals: { ...totals },
    models: [...models.entries()]
      .filter(([, entry]) => entry.row.total > 0)
      .map(([key, entry]) => ({
        key,
        engine: entry.engine,
        provider: entry.provider,
        model: entry.model,
        sessions: entry.sessions.size,
        ...entry.row,
      }))
      .sort((a, b) => b.total - a.total),
    days: [...days.entries()].map(([day, total]) => ({ day, total })).sort((a, b) => a.day.localeCompare(b.day)),
    sessionsScanned: sessionsInWindow.size,
    sessionsFound: foundSessions,
    failures,
    generatedAt: now,
  };
}
