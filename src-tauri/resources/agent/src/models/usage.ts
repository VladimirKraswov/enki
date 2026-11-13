// Kimi Code (subscription) exposes its quota at `<base>/v1/usages`:
//   { usages: { limit5h?, limit7d?, monthTotal?, monthCode? }, extraUsage? }
// each entry { usedRatio: 0..1, resetAt?: ISO }. This parser keeps only the
// documented fields, clamps ratios and drops anything malformed — a broken
// answer must not become an invented percentage.

export interface QuotaEntry {
  /** 0..1, rounded to four decimals of a percent. */
  usedRatio: number;
  /** ISO timestamp of the next reset, when the provider sent one. */
  resetAt: string | null;
}

export interface ExtraUsage {
  balanceCents: number;
  monthlyUsedCents: number;
  monthlyChargeLimitCents: number;
  monthlyChargeLimitEnabled: boolean;
  currency: string;
}

export interface BalanceEntry {
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
}
export interface ProviderBalance {
  available: boolean;
  entries: BalanceEntry[];
}

export interface ProviderUsage {
  limit5h: QuotaEntry | null;
  limit7d: QuotaEntry | null;
  monthTotal: QuotaEntry | null;
  monthCode: QuotaEntry | null;
  extraUsage: ExtraUsage | null;
  /** Official monetary balance (DeepSeek `/user/balance`), not a token quota. */
  balance: ProviderBalance | null;
}

const ratio = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0
  ? Math.min(1, Math.round(value * 10_000) / 10_000) : null;
const cents = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const stamp = (value: unknown): string | null => typeof value === "string" && value.length >= 10 && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? value : null;
const money = (value: unknown): number | null => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 9_007_199_254_740_991 ? Math.round(n * 100) / 100 : null;
};
function balance(value: unknown): ProviderBalance | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.is_available !== "boolean" || !Array.isArray(raw.balance_infos) || raw.balance_infos.length > 16) return null;
  const entries: BalanceEntry[] = [];
  for (const item of raw.balance_infos) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const total = money(row.total_balance), granted = money(row.granted_balance), topped = money(row.topped_up_balance);
    const currency = typeof row.currency === "string" && /^[A-Z]{2,8}$/.test(row.currency) ? row.currency : "";
    if (total === null || granted === null || topped === null || !currency) continue;
    entries.push({ currency, total, granted, toppedUp: topped });
  }
  return entries.length ? { available: raw.is_available, entries } : null;
}

/** DeepSeek publishes monetary balance only; token usage stays local/observed. */
export function parseDeepSeekBalance(value: unknown): ProviderUsage | null {
  const parsed = balance(value);
  if (!parsed) return null;
  return { limit5h: null, limit7d: null, monthTotal: null, monthCode: null, extraUsage: null, balance: parsed };
}

function entry(value: unknown): QuotaEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { usedRatio?: unknown; resetAt?: unknown };
  const used = ratio(raw.usedRatio);
  if (used === null) return null;
  return { usedRatio: used, resetAt: stamp(raw.resetAt) };
}

function extra(value: unknown): ExtraUsage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const balance = cents(raw.balanceCents), used = cents(raw.monthlyUsedCents), limit = cents(raw.monthlyChargeLimitCents);
  if (balance === null || used === null || limit === null) return null;
  const currency = typeof raw.currency === "string" && raw.currency.length <= 8 ? raw.currency : "CNY";
  return { balanceCents: balance, monthlyUsedCents: used, monthlyChargeLimitCents: limit,
    monthlyChargeLimitEnabled: raw.monthlyChargeLimitEnabled === true, currency };
}

export function parseProviderUsage(value: unknown): ProviderUsage | null {
  if (!value || typeof value !== "object") return null;
  const usages = (value as { usages?: unknown }).usages;
  if (!usages || typeof usages !== "object") return null;
  const raw = usages as Record<string, unknown>;
  const parsed: ProviderUsage = {
    limit5h: entry(raw.limit5h), limit7d: entry(raw.limit7d),
    monthTotal: entry(raw.monthTotal), monthCode: entry(raw.monthCode),
    extraUsage: extra((value as { extraUsage?: unknown }).extraUsage), balance: null,
  };
  // An answer with no usable quota entry is not a quota.
  return parsed.limit5h || parsed.limit7d || parsed.monthTotal || parsed.monthCode ? parsed : null;
}
