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

export interface ProviderUsage {
  limit5h: QuotaEntry | null;
  limit7d: QuotaEntry | null;
  monthTotal: QuotaEntry | null;
  monthCode: QuotaEntry | null;
  extraUsage: ExtraUsage | null;
}

const ratio = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0
  ? Math.min(1, Math.round(value * 10_000) / 10_000) : null;
const cents = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const stamp = (value: unknown): string | null => typeof value === "string" && value.length >= 10 && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? value : null;

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
    extraUsage: extra((value as { extraUsage?: unknown }).extraUsage),
  };
  // An answer with no usable quota entry is not a quota.
  return parsed.limit5h || parsed.limit7d || parsed.monthTotal || parsed.monthCode ? parsed : null;
}
