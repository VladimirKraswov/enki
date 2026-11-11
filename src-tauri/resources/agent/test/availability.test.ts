// Availability classification, the tiny pre-summary probe, and the fallback
// compaction candidate choice. These decide WHEN Enki may offer another
// provider's model; the transition itself is covered by the integration test.
import { expect, it } from "vitest";
import { availabilityProblem, classifyModelFailure, pickCompactionAlternatives, probeResolvedAvailability } from "../src/models/availability.ts";
import type { CatalogProvider } from "../src/sdk/adapter.ts";

it("classifies provider quota failures, not ordinary errors", () => {
  expect(classifyModelFailure(new Error('429 {"error":{"type":"exceeded_current_quota_error","message":"You\'ve reached your 5-hour usage limit."}}'))).toBe("quota");
  expect(classifyModelFailure(new Error("insufficient_quota: you exceeded your current quota"))).toBe("quota");
  expect(classifyModelFailure(new Error("HTTP 402 payment required"))).toBe("quota");
  expect(classifyModelFailure(new Error("401 invalid api key"))).toBe("auth");
  expect(classifyModelFailure(new Error("connect ECONNREFUSED 192.168.31.71:1919"))).toBe("unreachable");
  expect(classifyModelFailure(new Error("terminated"))).toBe("unknown");
  expect(classifyModelFailure(new Error("context length exceeded"))).toBe("unknown");
});

it("explains only blocking kinds", () => {
  expect(availabilityProblem("quota")).toMatch(/лимит/);
  expect(availabilityProblem("auth")).toMatch(/доступ/);
  expect(availabilityProblem("unreachable")).toMatch(/не отвечает/);
  expect(availabilityProblem("ready")).toBeNull();
  expect(availabilityProblem("unknown")).toBeNull();
});

const controller = new AbortController();

it("reads the probe verdict from the provider's own answer", async () => {
  const resolved = { baseURL: "https://api.example.com/v1", headers: { Authorization: "Bearer x" } };
  const seen: string[] = [];
  const fetchFor = (status: number, text = "") => async (url: string, init?: { signal?: AbortSignal }) => {
    if (init?.signal?.aborted) throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    seen.push(url); return { status, text: async () => text };
  };
  expect(await probeResolvedAvailability("openai-completions", "m", resolved, controller.signal, fetchFor(200))).toBe("ready");
  expect(await probeResolvedAvailability("openai-completions", "m", resolved, controller.signal, fetchFor(429, "quota"))).toBe("quota");
  expect(await probeResolvedAvailability("openai-completions", "m", resolved, controller.signal, fetchFor(401))).toBe("auth");
  expect(await probeResolvedAvailability("openai-completions", "m", resolved, controller.signal, fetchFor(503))).toBe("unknown");
  expect(await probeResolvedAvailability("openai-completions", "m", resolved, controller.signal, fetchFor(400, "exceeded_current_quota_error"))).toBe("quota");
  expect(seen.every((url) => url === "https://api.example.com/v1/chat/completions")).toBe(true);
  // An unknown API shape is never guessed at, and missing access material
  // stays unknown so the normal attempt decides.
  expect(await probeResolvedAvailability("faux-x", "m", resolved, controller.signal, fetchFor(200))).toBe("unknown");
  expect(await probeResolvedAvailability("openai-completions", "m", null, controller.signal, fetchFor(200))).toBe("unknown");
  const aborted = new AbortController();
  aborted.abort();
  expect(await probeResolvedAvailability("openai-completions", "m", resolved, aborted.signal, fetchFor(200))).toBe("unknown");
});

it("reports a dead endpoint as unreachable, everything else as unknown", async () => {
  const resolved = { baseURL: "http://127.0.0.1:1/v1", headers: {} };
  expect(await probeResolvedAvailability("openai-completions", "m", resolved, controller.signal,
    async () => { throw Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }); })).toBe("unreachable");
  expect(await probeResolvedAvailability("openai-completions", "m", resolved, controller.signal,
    async () => { throw new Error("bad json body"); })).toBe("unknown");
});

const provider = (id: string, configured: boolean, models: Array<{ id: string; name?: string; contextWindow?: number }>): CatalogProvider =>
  ({ id, name: id, configured, models }) as unknown as CatalogProvider;

it("offers only configured OTHER providers that can hold the whole context", () => {
  const snapshot = [
    provider("kimi-coding", true, [{ id: "k3.1-pro", contextWindow: 1_048_576 }]),
    provider("deepseek", true, [{ id: "deepseek-flash", name: "DeepSeek Flash", contextWindow: 1_048_576 }, { id: "small", contextWindow: 128_000 }]),
    provider("openai", true, [{ id: "gpt-big", name: "GPT Big", contextWindow: 2_000_000 }]),
    provider("noauth", false, [{ id: "huge-unconfigured", contextWindow: 9_000_000 }]),
  ];
  const picked = pickCompactionAlternatives(snapshot, { providerID: "kimi-coding", modelID: "k3.1-pro" }, 900_000);
  // Largest window first; same (exhausted account) provider excluded; the
  // 128K model cannot hold 900K+margin; unconfigured providers never qualify.
  expect(picked.map((c) => `${c.providerID}/${c.modelID}`)).toEqual(["openai/gpt-big", "deepseek/deepseek-flash"]);
  expect(picked[0].name).toBe("GPT Big");
  // With a small context need, more candidates (still window-sorted) qualify.
  expect(pickCompactionAlternatives(snapshot, { providerID: "kimi-coding", modelID: "k3.1-pro" }, 1_000).length).toBe(3);
});
