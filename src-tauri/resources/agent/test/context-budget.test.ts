import { expect, it } from "vitest";
import { compactionBudget, isLocalProvider, LOCAL_COMPACTION_TRIGGER_RATIO } from "../src/context-budget.ts";

const QWEN = { contextWindow: 262_144, maxTokens: 16_384 };

it("keeps the cloud default: compaction only near the full window", () => {
  const b = compactionBudget(QWEN);
  expect(b.triggerTokens).toBe(262_144 - (16_384 + 4096));
  expect(b.reserveTokens).toBe(20_480);
});

it("compacts a small local model at 68% of the window instead of 92%", () => {
  const b = compactionBudget(QWEN, { triggerRatio: LOCAL_COMPACTION_TRIGGER_RATIO });
  expect(b.triggerTokens).toBe(Math.floor(262_144 * 0.68));
  expect(b.reserveTokens).toBe(262_144 - Math.floor(262_144 * 0.68));
  expect(b.keepRecentTokens).toBe(20_000);
});

it("an explicit reserve can still require an even earlier trigger", () => {
  const b = compactionBudget(QWEN, { triggerRatio: 0.68, reserveTokens: 120_000 });
  expect(b.reserveTokens).toBe(120_000);
});

it("never lets the ratio starve the advertised answer budget", () => {
  const tiny = compactionBudget({ contextWindow: 8_192, maxTokens: 4_096 }, { triggerRatio: 0.9 });
  expect(tiny.reserveTokens).toBe(8_191);
  expect(tiny.triggerTokens).toBe(1);
  const small = compactionBudget({ contextWindow: 32_768, maxTokens: 8_192 }, { triggerRatio: 0.2 });
  expect(small.reserveTokens).toBe(32_768 - Math.floor(32_768 * 0.2));
});

it("ignores an invalid ratio and detects only owner-configured local providers", () => {
  for (const triggerRatio of [0, 1, -0.5, Number.NaN, Number.POSITIVE_INFINITY])
    expect(compactionBudget(QWEN, { triggerRatio }).triggerTokens).toBe(241_664);
  expect(isLocalProvider("local-qwen-next")).toBe(true);
  expect(isLocalProvider("kimi-coding")).toBe(false);
  expect(isLocalProvider(undefined)).toBe(false);
});
