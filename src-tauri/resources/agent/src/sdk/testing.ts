// Test-only harness around the pinned SDK's deterministic faux provider.
// Never imported by src/main.ts; the production bundle does not contain it.
// Responses are scripted per test, so runs are reproducible without a model,
// network or GPU, while every other part of the SDK (session tree, tools,
// extensions, compaction, events) is the real pinned implementation.

import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createModelRuntime, type SdkModelRuntime } from "./adapter.ts";

export { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, type FauxResponseStep };

export interface ScriptedRuntime {
  modelRuntime: SdkModelRuntime;
  provider: string;
  models: { large: string; small: string; medium: string; vision: string; huge: string };
  setResponses(steps: FauxResponseStep[]): void;
  appendResponses(steps: FauxResponseStep[]): void;
  /** Only when the harness was created with the alt provider; the fallback-compaction role. */
  altProvider: string | null;
  setAltResponses(steps: FauxResponseStep[]): void;
  altCalls(): number;
  pending(): number;
  calls(): number;
}

export async function scriptedRuntime(agentDir: string, options: { altProvider?: boolean } = {}): Promise<ScriptedRuntime> {
  const modelRuntime = await createModelRuntime({ agentDir, credentials: { kind: "memory" }, allowNetwork: false });
  const faux = fauxProvider({
    provider: "enki-scripted",
    models: [
      { id: "scripted-large", name: "Scripted large", contextWindow: 200_000, maxTokens: 8_000, reasoning: true, input: ["text"] },
      // Full shipped tool schemas must leave actual compaction headroom. This
      // remains far smaller than large; effective 4k refusal is tested with an
      // explicit caller budget, without relaxing the production floor check.
      { id: "scripted-small", name: "Scripted small", contextWindow: 8_000, maxTokens: 512, reasoning: false, input: ["text"] },
      // Smaller than large, yet a short chat's real request (Enki system prompt
      // + tool schemas, as reported by faux usage) genuinely fits its budget.
      { id: "scripted-medium", name: "Scripted medium", contextWindow: 16_000, maxTokens: 512, reasoning: false, input: ["text"] },
      { id: "scripted-vision", name: "Scripted vision", contextWindow: 64_000, maxTokens: 2_000, reasoning: false, input: ["text", "image"] },
    ],
    tokensPerSecond: 100_000,
    // Exercise the real SDK delta stream without thousands of sub-millisecond
    // sleeps: Windows rounds them to ~15 ms. Turn ordering/cancellation tests
    // use explicit gates rather than depending on simulated model bandwidth.
    tokenSize: { min: 16, max: 32 },
  });
  modelRuntime.registerNativeProvider(faux.provider);
  // The scripted provider needs no secret; a runtime-only key satisfies the
  // SDK's "auth configured" preflight without touching any credential store.
  await modelRuntime.setRuntimeApiKey("enki-scripted", "scripted-test-key");
  // A second provider stands in for the fallback-compaction role (another
  // account whose quota survived, with a very large window).
  let alt: ReturnType<typeof fauxProvider> | null = null;
  if (options.altProvider) {
    alt = fauxProvider({
      provider: "enki-scripted-alt",
      models: [
        { id: "scripted-alt-huge", name: "Scripted alt huge", contextWindow: 1_000_000, maxTokens: 8_000, reasoning: false, input: ["text"] },
        { id: "scripted-alt-small", name: "Scripted alt small", contextWindow: 4_000, maxTokens: 512, reasoning: false, input: ["text"] },
      ],
      tokensPerSecond: 100_000,
      tokenSize: { min: 16, max: 32 },
    });
    modelRuntime.registerNativeProvider(alt.provider);
    await modelRuntime.setRuntimeApiKey("enki-scripted-alt", "scripted-alt-key");
  }
  return {
    modelRuntime,
    provider: "enki-scripted",
    models: { large: "scripted-large", small: "scripted-small", medium: "scripted-medium", vision: "scripted-vision", huge: "scripted-alt-huge" },
    setResponses: (steps) => faux.setResponses(steps),
    appendResponses: (steps) => faux.appendResponses(steps),
    altProvider: alt ? "enki-scripted-alt" : null,
    setAltResponses: (steps) => { if (!alt) throw new Error("alt provider is not registered"); alt.setResponses(steps); },
    altCalls: () => alt?.state.callCount ?? 0,
    pending: () => faux.getPendingResponseCount(),
    calls: () => faux.state.callCount,
  };
}
