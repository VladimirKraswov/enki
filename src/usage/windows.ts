// Honest rolling/monthly consumption computed from Enki's own recorded replies.
// The provider's plan quota is NOT published by its API (checked: no usage
// endpoint, no rate-limit headers), so these numbers describe THIS device's
// consumption, not the provider's remaining balance. A percentage appears only
// when the owner has configured a limit; otherwise nothing is invented.

import type { UsageCache, UsageFact } from "./cache";
import { loadUsageCache } from "./accounting";

export interface MonthlyUsage {
  provider: string;
  tokens: number;
  replies: number;
  /** Local start of the next calendar month, ms epoch. */
  resetAt: number;
}

export function nextMonthStart(now: number): number {
  const d = new Date(now);
  d.setMonth(d.getMonth() + 1, 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Facts are keyed `${engine}\0${provider}\0${model}`. The plan quota is shared
 * by all models of the provider, so the monthly total is provider-scoped. */
export function monthlyProviderUsage(facts: Iterable<UsageFact>, provider: string, now: number): MonthlyUsage {
  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const since = monthStart.getTime();
  let tokens = 0, replies = 0;
  for (const fact of facts) {
    if (fact.t < since || fact.t > now) continue;
    if (fact.sk.split("\0")[1] !== provider) continue;
    tokens += fact.c[0] ?? 0;
    replies += 1;
  }
  return { provider, tokens, replies, resetAt: nextMonthStart(now) };
}

/** Only a positive, finite owner-configured limit produces a percentage. */
export function limitPercent(tokens: number, limit: number | undefined | null): number | null {
  if (limit === undefined || limit === null || !Number.isFinite(limit) || limit <= 0) return null;
  return Math.min(100, Math.round((tokens / limit) * 100));
}

/** One cache load per minute; concurrent opens share it. Failures are reported
 * so the popover can say why data is missing instead of pretending a zero. */
let cached: { at: number; cache: UsageCache; failures: string[] } | null = null;
export async function loadMonthlyUsage(provider: string, now = Date.now()): Promise<{ usage: MonthlyUsage; failures: string[] }> {
  if (!cached || now - cached.at > 60_000) {
    const result = await loadUsageCache(new AbortController().signal);
    cached = { at: now, cache: result.cache, failures: result.failures };
  }
  const usage = monthlyProviderUsage(Object.values(cached.cache.messages), provider, now);
  return { usage, failures: cached.failures };
}