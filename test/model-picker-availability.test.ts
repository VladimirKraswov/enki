import { expect, it } from "vitest";
import { availablePickerModels, MODEL_SECTIONS, withCurrentSelection } from "../src/models/picker";
import type { ProviderInfo } from "../src/api/types";

it("shows owned unloaded GPUs first, paid entitlements next and confirmed free models last", () => {
  const providers: ProviderInfo[] = [
    { id: "unconfigured", models: { nova: { id: "nova", providerID: "unconfigured" } } },
    { id: "router", models: {
      free: { id: "free", providerID: "router", access: { state: "available", kind: "free" } },
      unknown: { id: "unknown", providerID: "router" },
      denied: { id: "denied", providerID: "router", access: { state: "unavailable", kind: "paid" } },
    } },
    { id: "deepseek", models: { flash: { id: "flash", providerID: "deepseek", access: { state: "available", kind: "paid" } } } },
    { id: "my-gpu", models: { unloaded: { id: "unloaded", providerID: "my-gpu" } } },
    { id: "subscription", models: { included: { id: "included", providerID: "subscription", access: { state: "available", kind: "subscription" } } } },
  ];
  const result = availablePickerModels(providers, ["router", "deepseek", "subscription"], p => p === "my-gpu");
  expect(result.map(m => m.modelID)).toEqual(["unloaded", "flash", "included", "free"]);
  expect(result.map(m => m.section)).toEqual([MODEL_SECTIONS.local, MODEL_SECTIONS.paid, MODEL_SECTIONS.paid, MODEL_SECTIONS.free]);
  expect(result.find(m => m.modelID === "included")?.detail).toContain("подписке");
});

it("revoking a key hides even previously available cloud models without modifying source data", () => {
  const provider: ProviderInfo = { id: "cloud", models: { m: { id: "m", providerID: "cloud", access: { state: "available", kind: "paid" } } } };
  const before = JSON.stringify(provider);
  expect(availablePickerModels([provider], [], () => false)).toEqual([]);
  expect(JSON.stringify(provider)).toBe(before);
});

it("keeps the selected working model visible after a transient access refresh", () => {
  const providers: ProviderInfo[] = [{ id: "kimi", name: "Kimi", models: {
    pro: { id: "pro", providerID: "kimi", name: "Kimi K3.1 Pro", access: { state: "unknown" } },
  } }];
  const listed = availablePickerModels(providers, [], () => false);
  expect(listed).toEqual([]);
  const result = withCurrentSelection(listed, providers, { providerID: "kimi", modelID: "pro" });
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ label: "Kimi K3.1 Pro", section: "Текущая модель" });
  expect(result[0].detail).toContain("выбор чата сохранён");
  expect(withCurrentSelection(result, providers, { providerID: "kimi", modelID: "pro" })).toBe(result);
});

it("does not duplicate a confirmed selected model and tolerates an absent catalog entry", () => {
  const listed = availablePickerModels([{ id: "router", models: {
    free: { id: "free", providerID: "router", access: { state: "available", kind: "free" } },
  } }], ["router"], () => false);
  expect(withCurrentSelection(listed, [], { providerID: "router", modelID: "free" })).toEqual(listed);
  const absent = withCurrentSelection([], [], { providerID: "gone", modelID: "old-model" });
  expect(absent[0]).toMatchObject({ providerID: "gone", modelID: "old-model", label: "old-model" });
});
