import type { UsageCache, UsageFact } from "./cache";
import { dayKeyOf } from "./metrics";

export { dayKeyOf };

/**
 * Money accounting on top of the usage cache. Paid DeepSeek replies are priced
 * from the DeepSeek price book (peak/off-peak schedule, USD per 1M tokens);
 * free local replies are valued at the DeepSeek flash rates to show a relative
 * saving. Completed local days are settled once with the book/rate of that
 * moment and never repriced afterwards — later price changes only affect
 * unsettled days and the live view of today.
 */

export interface PricePair {
  peak: number;
  offPeak: number;
}

export interface PriceTable {
  input: PricePair;
  inputCacheHit: PricePair;
  output: PricePair;
}

export interface PriceBook {
  schema: number;
  source: string;
  checkedAt: number;
  offPeakFactor: number;
  peakDays: number[];
  peakWindows: Array<{ startHour: number; endHour: number }>;
  models: { flash: PriceTable; pro: PriceTable };
  warning?: string;
}

export interface RateSnapshot {
  source: string;
  checkedAt: number;
  rate: number;
}

export interface MoneySnapshot {
  book: PriceBook;
  rate: RateSnapshot;
  /** Why the numbers are approximated (fetch problems, missing history…). */
  notes: string[];
}

/** null = free/unknown model; 'flash'/'pro' = priced through the DeepSeek book. */
export function deepseekPriceKey(providerID: string, modelID: string): "flash" | "pro" | null {
  if (providerID !== "deepseek") return null;
  return /pro|reasoner/i.test(modelID) ? "pro" : "flash";
}

/** Peak windows are UTC hours [start,end) on the listed ISO weekdays (1=Mon). */
export function isPeakHour(book: PriceBook, timeMs: number): boolean {
  const date = new Date(timeMs);
  const isoDay = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  if (!book.peakDays.includes(isoDay)) return false;
  const hour = date.getUTCHours();
  return book.peakWindows.some(w => hour >= w.startHour && hour < w.endHour);
}

/** USD for one bucket of tokens at the given rates (cacheWrite is not billed). */
export function usdForTokens(
  tokens: { input: number; cacheRead: number; output: number },
  table: PriceTable,
  peak: boolean,
): number {
  const pick = (p: PricePair) => (peak ? p.peak : p.offPeak);
  return (
    (tokens.input * pick(table.input) +
      tokens.cacheRead * pick(table.inputCacheHit) +
      tokens.output * pick(table.output)) /
    1_000_000
  );
}

export interface DayModelMoney {
  /** ₽ spent (paid models) or ₽ saved (free models valued at flash rates). */
  spentRub: number;
  savedRub: number;
}

export interface DayLedger {
  settledAt: number;
  priceSource: string;
  rate: number;
  spentRub: number;
  savedRub: number;
  models: Record<string, DayModelMoney>;
}

export interface LedgerDoc {
  schema: 1;
  updatedAt: number;
  /** The book/rate pair used for the most recent settlement. */
  prices?: MoneySnapshot;
  days: Record<string, DayLedger>;
}

export const emptyLedger = (): LedgerDoc => ({ schema: 1, updatedAt: 0, days: {} });

const round2 = (value: number) => Math.round(value * 100) / 100;

interface Bucket {
  input: number;
  cacheRead: number;
  output: number;
}

interface Aggregated {
  paid: Map<string, { peak: Bucket; offPeak: Bucket; pro: boolean }>;
  free: Map<string, { peak: Bucket; offPeak: Bucket }>;
}

function addFact(agg: Aggregated, fact: UsageFact, peak: boolean) {
  const [, provider, model] = fact.sk.split("\u0000");
  const [, input, output, cacheRead] = fact.c;
  const priceKey = deepseekPriceKey(provider, model);
  const bucketKey = `${fact.sk}`;
  if (priceKey) {
    let entry = agg.paid.get(bucketKey);
    if (!entry) {
      entry = { peak: emptyBucket(), offPeak: emptyBucket(), pro: priceKey === "pro" };
      agg.paid.set(bucketKey, entry);
    }
    addTo(entry[peak ? "peak" : "offPeak"], input, cacheRead, output);
  } else {
    let entry = agg.free.get(bucketKey);
    if (!entry) {
      entry = { peak: emptyBucket(), offPeak: emptyBucket() };
      agg.free.set(bucketKey, entry);
    }
    addTo(entry[peak ? "peak" : "offPeak"], input, cacheRead, output);
  }
}

const emptyBucket = (): Bucket => ({ input: 0, cacheRead: 0, output: 0 });
const addTo = (bucket: Bucket, input: number, cacheRead: number, output: number) => {
  bucket.input += input;
  bucket.cacheRead += cacheRead;
  bucket.output += output;
};

export function aggregateFacts(cache: UsageCache, book: PriceBook, fromMs = 0, toMs = Infinity): Aggregated {
  const agg: Aggregated = { paid: new Map(), free: new Map() };
  for (const fact of Object.values(cache.messages)) {
    if (fact.t < fromMs || fact.t >= toMs) continue;
    addFact(agg, fact, isPeakHour(book, fact.t));
  }
  return agg;
}

function moneyOf(agg: Aggregated, snapshot: MoneySnapshot): {
  models: Record<string, DayModelMoney>;
  spentRub: number;
  savedRub: number;
} {
  const rate = snapshot.rate.rate;
  const models: Record<string, DayModelMoney> = {};
  let spent = 0;
  let saved = 0;
  for (const [key, entry] of agg.paid) {
    const table = snapshot.book.models[entry.pro ? "pro" : "flash"];
    const usd = usdForTokens(entry.peak, table, true) + usdForTokens(entry.offPeak, table, false);
    const value = round2(usd * rate);
    models[key] = { spentRub: value, savedRub: 0 };
    spent += value;
  }
  for (const [key, entry] of agg.free) {
    const usd =
      usdForTokens(entry.peak, snapshot.book.models.flash, true) +
      usdForTokens(entry.offPeak, snapshot.book.models.flash, false);
    const value = round2(usd * rate);
    models[key] = { ...(models[key] ?? { spentRub: 0, savedRub: 0 }), savedRub: value };
    saved += value;
  }
  return { models, spentRub: round2(spent), savedRub: round2(saved) };
}

/**
 * Settles every completed local day (strictly before the current local day)
 * that is not in the ledger yet, using the provided snapshot. Existing days are
 * returned untouched — that is the whole point: yesterday's money is history.
 */
export function settleLedger(
  cache: UsageCache,
  snapshot: MoneySnapshot,
  ledger: LedgerDoc,
  now = Date.now(),
): { ledger: LedgerDoc; changed: boolean } {
  const today = dayKeyOf(now);
  const days = new Set<string>();
  for (const fact of Object.values(cache.messages)) {
    const day = dayKeyOf(fact.t);
    if (day < today && !ledger.days[day]) days.add(day);
  }
  if (days.size === 0 && samePrices(ledger.prices, snapshot)) return { ledger, changed: false };
  const nextDays = { ...ledger.days };
  const startOfDay = (day: string) => new Date(`${day}T00:00:00`).getTime();
  for (const day of [...days].sort()) {
    const start = startOfDay(day);
    const agg = aggregateFacts(cache, snapshot.book, start, start + 24 * 3600 * 1000);
    const money = moneyOf(agg, snapshot);
    nextDays[day] = {
      settledAt: now,
      priceSource: `${snapshot.book.source}/${snapshot.rate.source}`,
      rate: snapshot.rate.rate,
      spentRub: money.spentRub,
      savedRub: money.savedRub,
      models: money.models,
    };
  }
  return {
    ledger: { schema: 1, updatedAt: now, prices: snapshot, days: nextDays },
    changed: days.size > 0 || !samePrices(ledger.prices, snapshot),
  };
}

function samePrices(a: MoneySnapshot | undefined, b: MoneySnapshot): boolean {
  if (!a) return false;
  return (
    a.rate.rate === b.rate.rate &&
    a.rate.checkedAt === b.rate.checkedAt &&
    JSON.stringify(a.book) === JSON.stringify(b.book)
  );
}

export interface MoneyTotals {
  spentRub: number;
  savedRub: number;
  /** Extra totals for the currently visible day, for period-aware hints. */
  today: { spentRub: number; savedRub: number };
}

/** All-time display totals: every settled day plus the live current day. */
export function moneyTotals(
  cache: UsageCache,
  snapshot: MoneySnapshot,
  ledger: LedgerDoc,
  now = Date.now(),
): MoneyTotals {
  let spent = 0;
  let saved = 0;
  for (const day of Object.values(ledger.days)) {
    spent += day.spentRub;
    saved += day.savedRub;
  }
  const today = liveDay(cache, snapshot, dayKeyOf(now), now);
  return {
    spentRub: round2(spent + today.spentRub),
    savedRub: round2(saved + today.savedRub),
    today,
  };
}

function liveDay(cache: UsageCache, snapshot: MoneySnapshot, day: string, now: number) {
  const start = new Date(`${day}T00:00:00`).getTime();
  const agg = aggregateFacts(cache, snapshot.book, start, now);
  const money = moneyOf(agg, snapshot);
  return { spentRub: money.spentRub, savedRub: money.savedRub };
}

/** Per-model ₽ for the facts of a period (live view; settled days are summed too). */
export function modelMoney(
  cache: UsageCache,
  snapshot: MoneySnapshot,
  fromMs: number,
  toMs: number,
): Record<string, DayModelMoney> {
  return moneyOf(aggregateFacts(cache, snapshot.book, fromMs, toMs), snapshot).models;
}

export const priceLabel = (pair: PricePair) =>
  `$${pair.peak.toFixed(pair.peak < 0.01 ? 3 : 2)} / $${pair.offPeak.toFixed(pair.offPeak < 0.01 ? 3 : 2)}`;

