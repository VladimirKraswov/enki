import { expect, it } from "vitest";
import { parseDeepSeekBalance, parseProviderUsage } from "../src/models/usage.ts";
import { deepSeekBalanceEndpoint, usageEndpoint } from "../src/models/probe-usage.ts";

// The shape Kimi Code publishes at `<api base>/v1/usages`.
const payload = {
  usages: {
    limit5h: { usedRatio: 1, resetAt: "2026-11-09T14:51:00.000Z" },
    monthTotal: { usedRatio: 0.1341, resetAt: "2026-12-08T17:03:00.000Z" },
    monthCode: { usedRatio: 0.05, resetAt: "2026-12-08T17:03:00.000Z" },
  },
  extraUsage: { balanceCents: 2500, monthlyUsedCents: 0, monthlyChargeLimitCents: 0, monthlyChargeLimitEnabled: false, currency: "CNY" },
};

it("reads the documented 5-hour, weekly and monthly ratios with their reset times", () => {
  const usage = parseProviderUsage(payload)!;
  expect(usage.limit5h).toEqual({ usedRatio: 1, resetAt: "2026-11-09T14:51:00.000Z" });
  expect(usage.limit7d).toBeNull();
  expect(usage.monthTotal?.usedRatio).toBe(0.1341);
  expect(usage.monthCode?.usedRatio).toBe(0.05);
  expect(usage.extraUsage).toMatchObject({ balanceCents: 2500, currency: "CNY" });
});

it("clamps ratios and drops malformed entries instead of inventing a percentage", () => {
  const usage = parseProviderUsage({
    usages: {
      limit5h: { usedRatio: 1.4, resetAt: "not-a-date" },
      limit7d: { usedRatio: -1 },
      monthTotal: { usedRatio: "0.5" },
      monthCode: { resetAt: "2026-12-08T17:03:00.000Z" },
    },
    extraUsage: { balanceCents: -5 },
  })!;
  expect(usage.limit5h).toEqual({ usedRatio: 1, resetAt: null });
  expect(usage.limit7d).toBeNull();
  expect(usage.monthTotal).toBeNull();
  expect(usage.monthCode).toBeNull();
  expect(usage.extraUsage).toBeNull();
});

it("returns null when the answer contains no usable quota", () => {
  expect(parseProviderUsage(null)).toBeNull();
  expect(parseProviderUsage({})).toBeNull();
  expect(parseProviderUsage({ usages: {} })).toBeNull();
  expect(parseProviderUsage({ usages: { limit5h: {} } })).toBeNull();
});

it("uses the official Kimi Code usage endpoint without duplicating /v1", () => {
  expect(usageEndpoint("https://api.kimi.com/coding")).toBe("https://api.kimi.com/coding/v1/usages");
  expect(usageEndpoint("https://api.kimi.com/coding/")).toBe("https://api.kimi.com/coding/v1/usages");
  expect(usageEndpoint("https://api.kimi.com/coding/v1")).toBe("https://api.kimi.com/coding/v1/usages");
});

it("parses the official DeepSeek balance and rejects malformed amounts", () => {
  const value = parseDeepSeekBalance({ is_available: true, balance_infos: [
    { currency: "CNY", total_balance: "110.25", granted_balance: "10.00", topped_up_balance: "100.25" },
    { currency: "USD", total_balance: "15.50", granted_balance: "0.00", topped_up_balance: "15.50" },
    { currency: "bad", total_balance: "-1", granted_balance: "0", topped_up_balance: "0" },
  ] })!;
  expect(value.balance).toEqual({ available: true, entries: [
    { currency: "CNY", total: 110.25, granted: 10, toppedUp: 100.25 },
    { currency: "USD", total: 15.5, granted: 0, toppedUp: 15.5 },
  ] });
  expect(value.limit5h).toBeNull();
  expect(parseDeepSeekBalance({ is_available: true, balance_infos: [] })).toBeNull();
  expect(parseDeepSeekBalance({ is_available: "yes", balance_infos: [{ currency: "CNY", total_balance: "1", granted_balance: "0", topped_up_balance: "1" }] })).toBeNull();
});

it("uses only DeepSeek's official HTTPS balance origin", () => {
  expect(deepSeekBalanceEndpoint("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com/user/balance");
  expect(() => deepSeekBalanceEndpoint("https://evil.example/v1")).toThrow(/Неофициальный/);
});
