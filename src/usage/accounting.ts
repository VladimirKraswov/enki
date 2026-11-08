// IO layer over the incremental usage cache, the closed-day money ledger and
// the price/rate snapshot. Native files are CAS-guarded (sha256); in the plain
// browser (no Tauri) we fall back to the direct scan without any money panel.

import { isNative } from "../native/platform";
import {
  CACHE_FILE,
  LEDGER_FILE,
  emptyCache,
  refreshUsageCache,
  reportFromCache,
  type UsageCache,
} from "./cache";
import {
  emptyLedger,
  moneyTotals,
  modelMoney,
  settleLedger,
  type DayModelMoney,
  type LedgerDoc,
  type MoneySnapshot,
  type PriceBook,
} from "./money";
import { periodStart, type UsageSource, type UsagePeriod, type UsageReport } from "./metrics";
import { usageSources } from "./sources";

export const DAY_MS = 24 * 3600 * 1000;

interface StoredFileDto {
  content: string;
  sha: string;
}

interface Stored<T> {
  value: T;
  sha: string;
}

async function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isNative()) throw new Error("Доступно только в установленном приложении.");
  return (await import("@tauri-apps/api/core")).invoke<T>(command, args);
}

async function readStored<T>(name: string): Promise<Stored<T | null> | null> {
  const stored = await native<StoredFileDto | null>("read_usage_file", { name });
  if (!stored) return null;
  try {
    return { value: JSON.parse(stored.content) as T, sha: stored.sha };
  } catch {
    // Keep the sha of the unreadable file so the next write can replace it
    // instead of being permanently blocked by the CAS guard.
    return { value: null, sha: stored.sha };
  }
}

async function writeStored<T>(name: string, value: T, expectedSha: string | null): Promise<boolean> {
  try {
    await native<StoredFileDto>("write_usage_file", {
      name,
      content: JSON.stringify(value),
      expectedSha,
    });
    return true;
  } catch {
    // A concurrent writer won the race; the fresh in-memory data is still shown.
    return false;
  }
}

export interface MoneyView {
  snapshot: MoneySnapshot;
  spentRub: number;
  savedRub: number;
  today: { spentRub: number; savedRub: number };
  perModel: Record<string, DayModelMoney>;
}

export interface UsageComputation {
  report: UsageReport;
  money: MoneyView | null;
  notes: string[];
  /** In-memory state to keep so period switching costs nothing. */
  cache: UsageCache;
  ledger: LedgerDoc;
  snapshot: MoneySnapshot | null;
}

/** Refreshes cache + prices + ledger, then reports the period from the cache. */
export async function computeUsage(
  sources: UsageSource[],
  period: UsagePeriod,
  signal: AbortSignal,
  options: { refreshPrices?: boolean; onProgress?: (done: number, found: number) => void } = {},
): Promise<UsageComputation> {
  const now = Date.now();
  if (!isNative()) {
    // No persistent storage in the plain browser: build the same in-memory cache
    // so period switching stays a filter there too.
    const refresh = await refreshUsageCache(sources, emptyCache(), signal, options.onProgress);
    const report = reportFromCache(refresh.cache, period, now, refresh.failures);
    return { report, money: null, notes: ["Денежная оценка доступна в установленном приложении."], cache: refresh.cache, ledger: emptyLedger(), snapshot: null };
  }
  const storedCache = await readStored<UsageCache>(CACHE_FILE);
  const cache = storedCache?.value?.schema === 1 ? storedCache.value : emptyCache();
  const refresh = await refreshUsageCache(sources, cache, signal, options.onProgress);
  if (refresh.changed)
    await writeStored(CACHE_FILE, refresh.cache, storedCache?.sha ?? null);

  const storedLedger = await readStored<LedgerDoc>(LEDGER_FILE);
  const ledger = storedLedger?.value?.schema === 1 ? storedLedger.value : emptyLedger();
  const notes: string[] = [...refresh.failures.map(f => `${f} — часть ответов могла не попасть в расчёт`)];
  let snapshot = ledger.prices ?? null;
  const stale = !snapshot || now - snapshot.rate.checkedAt >= DAY_MS;
  if (stale || options.refreshPrices) {
    const fresh = await refreshSnapshot(snapshot, options.refreshPrices ? "принудительно" : "по расписанию 24 ч");
    if (fresh.snapshot) snapshot = fresh.snapshot;
    notes.push(...fresh.notes);
  }
  let settledLedger = ledger;
  let storageSaved = true;
  if (snapshot) {
    const settle = settleLedger(refresh.cache, snapshot, ledger, now);
    if (settle.changed) {
      settledLedger = settle.ledger;
      storageSaved = await writeStored(LEDGER_FILE, settledLedger, storedLedger?.sha ?? null);
    }
  }
  const report = reportFromCache(refresh.cache, period, now, refresh.failures);
  let money: MoneyView | null = null;
  if (snapshot) {
    const totals = moneyTotals(refresh.cache, snapshot, settledLedger, now);
    money = {
      snapshot,
      spentRub: totals.spentRub,
      savedRub: totals.savedRub,
      today: totals.today,
      perModel: modelMoney(refresh.cache, snapshot, periodStart(period, now), now + DAY_MS),
    };
  } else {
    notes.push("Курс доллара недоступен — денежные суммы скрыты до следующей проверки.");
  }
  if (!storageSaved) notes.push("Файл данных использования обновлялся параллельно; показаны свежие данные из этой сессии.");
  return { report, money, notes, cache: refresh.cache, ledger: settledLedger, snapshot };
}

/** Facts only: no price book or exchange-rate refresh. Used by the context
 * meter's monthly consumption, which must not wait on pricing. */
export async function loadUsageCache(signal: AbortSignal): Promise<{ cache: UsageCache; failures: string[] }> {
  const stored = isNative() ? await readStored<UsageCache>(CACHE_FILE) : null;
  const cache = stored?.value?.schema === 1 ? stored.value : emptyCache();
  const refresh = await refreshUsageCache(usageSources(), cache, signal);
  return { cache: refresh.cache, failures: refresh.failures };
}

/** Reads the DeepSeek price book and the USD→RUB rate, keeping old values on
 * partial failure so closed-day accounting never depends on a live network.
 * Always returns the notes: when no snapshot can be built they explain why the
 * money panel is hidden instead of discarding the cause. */
export async function refreshSnapshot(
  previous: MoneySnapshot | null,
  reason: string,
): Promise<{ snapshot: MoneySnapshot | null; notes: string[] }> {
  const notes: string[] = [];
  let book: PriceBook | null = previous?.book ?? null;
  try {
    book = await native<PriceBook>("fetch_price_book");
    if (book.warning) notes.push(`Прайс DeepSeek: ${book.warning}.`);
  } catch (error) {
    notes.push(`Прайс DeepSeek не обновился (${reason}): ${String(error)}.`);
  }
  let rate = previous?.rate ?? null;
  try {
    rate = await native<{ source: string; checkedAt: number; rate: number }>("fetch_usd_rate");
  } catch (error) {
    if (!rate) notes.push(`Курс доллара недоступен (${reason}): ${String(error)}.`);
    else notes.push(`Курс доллара не обновился (${reason}); используется прежний ${rate.rate.toFixed(2)} ₽.`);
  }
  return { snapshot: book && rate ? { book, rate, notes } : null, notes };
}
