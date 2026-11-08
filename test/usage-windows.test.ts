import { expect, it } from "vitest";
import { limitPercent, monthlyProviderUsage, nextMonthStart } from "../src/usage/windows";
import type { UsageFact } from "../src/usage/cache";

const fact = (t: number, provider: string, model = "m", total = 100): UsageFact => ({
  t, sk: `Pi\0${provider}\0${model}`, sid: "s", c: [total, 0, 0, 0, 0, 0, 0],
});

it("sums only this provider's replies of the current local month and names the reset date", () => {
  const now = new Date(2026, 10, 8, 12, 30).getTime();
  const facts = [
    fact(new Date(2026, 10, 1, 9).getTime(), "kimi-coding", "k3.1-pro", 1000),
    fact(new Date(2026, 10, 8, 11).getTime(), "kimi-coding", "kimi-for-coding", 2500),
    fact(now, "kimi-coding", "k3.1-pro", 500),
    fact(new Date(2026, 10, 8, 10).getTime(), "deepseek", "deepseek-flash", 9000),
    fact(new Date(2026, 9, 31, 23).getTime(), "kimi-coding", "k3.1-pro", 7777), // October
    fact(now + 3600_000, "kimi-coding", "k3.1-pro", 123), // future
  ];
  const usage = monthlyProviderUsage(facts, "kimi-coding", now);
  expect(usage.tokens).toBe(4000);
  expect(usage.replies).toBe(3);
  expect(usage.resetAt).toBe(new Date(2026, 11, 1, 0, 0, 0, 0).getTime());
  expect(monthlyProviderUsage(facts, "unknown-provider", now).tokens).toBe(0);
});

it("never invents a percentage without a positive finite configured limit", () => {
  expect(limitPercent(4000, undefined)).toBeNull();
  expect(limitPercent(4000, 0)).toBeNull();
  expect(limitPercent(4000, -1)).toBeNull();
  expect(limitPercent(4000, Number.NaN)).toBeNull();
  expect(limitPercent(4000, 10000)).toBe(40);
  expect(limitPercent(12000, 10000)).toBe(100);
});

it("nextMonthStart is the first local midnight of the next month, including year rollover", () => {
  expect(nextMonthStart(new Date(2026, 11, 31, 23, 59).getTime())).toBe(new Date(2027, 0, 1).getTime());
  expect(nextMonthStart(new Date(2026, 10, 8).getTime())).toBe(new Date(2026, 11, 1).getTime());
});
