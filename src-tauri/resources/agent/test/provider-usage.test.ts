import { expect, it } from "vitest";
import { parseProviderUsage } from "../src/models/usage.ts";
import { usageEndpoint } from "../src/models/probe-usage.ts";

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
