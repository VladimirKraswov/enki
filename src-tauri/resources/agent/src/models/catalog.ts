// Pi ModelRuntime catalog → the provider/model shape the UI model picker uses.
// Exact provider and model ids are preserved; nothing is renamed or merged.

import type { ModelInfoDTO, ProviderDTO, ProvidersDTO } from "../protocol.ts";
import { catalogSnapshot, modelThinkingLevels, type SdkModel, type SdkModelRuntime } from "../sdk/adapter.ts";

export function modelInfo(model: SdkModel): ModelInfoDTO {
  const levels = modelThinkingLevels(model).filter((level) => level !== "off");
  return {
    id: model.id,
    providerID: model.provider,
    name: model.name,
    api: { id: model.api, url: model.baseUrl },
    capabilities: {
      reasoning: model.reasoning,
      toolcall: true,
      attachment: model.input.includes("image"),
      input: { text: model.input.includes("text"), image: model.input.includes("image") },
    },
    limit: { context: model.contextWindow, output: model.maxTokens },
    cost: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite },
    variants: model.reasoning && levels.length ? Object.fromEntries(levels.map((level) => [level, { id: level }])) : null,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: Object.fromEntries(Object.entries(model.thinkingLevelMap).map(([k, v]) => [k, v ?? null])) } : {}),
  };
}

export function providers(runtime: SdkModelRuntime, defaults: { providerID: string; modelID: string } | null): ProvidersDTO {
  const all: ProviderDTO[] = catalogSnapshot(runtime).map((provider) => ({
    id: provider.id,
    name: provider.name,
    source: "builtin",
    ...(provider.baseUrl ? { options: { baseURL: provider.baseUrl } } : {}),
    auth: { configured: provider.configured },
    models: Object.fromEntries(provider.models.map((model) => [model.id, modelInfo(model)])),
  }));
  return {
    all,
    connected: all.filter((provider) => provider.auth?.configured).map((provider) => provider.id),
    default: defaults ? { [defaults.providerID]: defaults.modelID } : null,
  };
}
