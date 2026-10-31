import type { MessageResponse, Session } from "../api/types";

export type UsagePeriod = "7d" | "30d" | "all";
export type UsageEngine = "OpenCode" | "Pi";

export interface UsageCounters {
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  other: number;
  reasoning: number; // Included in output by the engine; never added to total.
  replies: number;
}

export interface ModelUsage extends UsageCounters {
  key: string;
  engine: UsageEngine;
  provider: string;
  model: string;
  sessions: number;
}

export interface UsageReport {
  totals: UsageCounters;
  models: ModelUsage[];
  days: Array<{ day: string; total: number }>;
  sessionsScanned: number;
  sessionsFound: number;
  failures: string[];
  generatedAt: number;
}

export interface UsageSource {
  engine: UsageEngine;
  sessions(signal: AbortSignal): Promise<Session[]>;
  messages(session: Session, before: string | undefined, signal: AbortSignal): Promise<{
    messages: MessageResponse[];
    before?: string;
  }>;
}

export function periodStart(period: UsagePeriod, now: number): number {
  if (period === "all") return 0;
  const days = period === "7d" ? 7 : 30;
  const localMidnight = new Date(now);
  localMidnight.setHours(0, 0, 0, 0);
  localMidnight.setDate(localMidnight.getDate() - days + 1);
  return localMidnight.getTime();
}

/** A billable token count: a finite positive number, otherwise zero. */
export const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const empty = (): UsageCounters => ({ total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, other: 0, reasoning: 0, replies: 0 });
/** Local calendar day key; the same format is persisted in the usage cache and the money ledger. */
export function dayKeyOf(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The model belongs to the assistant response, not the session's current selection. */
export function addMessageUsage(target: UsageCounters, message: MessageResponse): number {
  if (message.info.role !== "assistant" || !message.info.tokens) return 0;
  const tokens = message.info.tokens;
  const input = finite(tokens.input), output = finite(tokens.output);
  const cacheRead = finite(tokens.cache?.read), cacheWrite = finite(tokens.cache?.write);
  const classified = input + output + cacheRead + cacheWrite;
  const total = Math.max(finite(tokens.total), classified);
  if (!total) return 0;
  target.total += total;
  target.input += input;
  target.output += output;
  target.cacheRead += cacheRead;
  target.cacheWrite += cacheWrite;
  target.other += total - classified;
  target.reasoning += Math.min(output, finite(tokens.reasoning));
  target.replies++;
  return total;
}

export async function scanUsage(
  sources: UsageSource[],
  period: UsagePeriod,
  signal: AbortSignal,
  onProgress?: (done: number, found: number) => void,
  now = Date.now(),
): Promise<UsageReport> {
  const start = periodStart(period, now);
  const totals = empty();
  const models = new Map<string, ModelUsage>();
  const days = new Map<string, number>();
  const failures: string[] = [];
  let sessionsScanned = 0, sessionsFound = 0;
  for (const source of sources) {
    signal.throwIfAborted();
    let sessions: Session[];
    try { sessions = await source.sessions(signal); }
    catch (error) {
      if (signal.aborted) throw error;
      failures.push(`${source.engine}: список сессий недоступен`);
      continue;
    }
    const seenSessions = new Set<string>();
    const candidates = sessions.filter(session => {
      if (seenSessions.has(session.id) || session.time.updated < start) return false;
      seenSessions.add(session.id);
      return true;
    });
    sessionsFound += candidates.length;
    onProgress?.(sessionsScanned, sessionsFound);
    for (const session of candidates) {
      signal.throwIfAborted();
      let before: string | undefined;
      const cursors = new Set<string>();
      const seenMessages = new Set<string>();
      const sessionModels = new Set<string>();
      try {
        do {
          signal.throwIfAborted();
          const page = await source.messages(session, before, signal);
          signal.throwIfAborted();
          let older = false;
          for (const message of page.messages) {
            const info = message.info;
            if (seenMessages.has(info.id)) continue;
            seenMessages.add(info.id);
            const time = info.time.completed ?? info.time.created;
            if (time < start) { older = true; continue; }
            if (info.role !== "assistant") continue;
            const provider = info.providerID || "Неизвестный провайдер";
            const model = info.modelID || "Неизвестная модель";
            const key = `${source.engine}\u0000${provider}\u0000${model}`;
            let row = models.get(key);
            if (!row) {
              row = { ...empty(), key, engine: source.engine, provider, model, sessions: 0 };
              models.set(key, row);
            }
            const amount = addMessageUsage(row, message);
            if (!amount) continue;
            addMessageUsage(totals, message);
            days.set(dayKeyOf(time), (days.get(dayKeyOf(time)) ?? 0) + amount);
            sessionModels.add(key);
          }
          before = page.before;
          if (older || !before || cursors.has(before)) break;
          cursors.add(before);
        } while (true);
      } catch (error) {
        if (signal.aborted) throw error;
        failures.push(`${source.engine}: не прочитана сессия ${session.id}`);
      }
      for (const key of sessionModels) models.get(key)!.sessions++;
      sessionsScanned++;
      onProgress?.(sessionsScanned, sessionsFound);
    }
  }
  return {
    totals,
    models: [...models.values()].filter(row => row.total).sort((a, b) => b.total - a.total),
    days: [...days.entries()].map(([day, total]) => ({ day, total })).sort((a, b) => a.day.localeCompare(b.day)),
    sessionsScanned, sessionsFound, failures, generatedAt: now,
  };
}
