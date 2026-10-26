import type { ProviderInfo } from "../api/types";

export const MODEL_SECTIONS = { local: "Мои локальные модели", paid: "Платные модели", free: "Бесплатные модели" } as const;
export interface PickerModel { providerID: string; modelID: string; label: string; section: string; detail: string }

/** The SDK's complete reference catalogue is useful in settings, never as an
 * entitlement list. Unknown pricing cannot establish that a model is free. */
export function availablePickerModels(providers: ProviderInfo[], connected: readonly string[], managed: (provider: string, model: string) => boolean): PickerModel[] {
  const groups: Record<keyof typeof MODEL_SECTIONS, PickerModel[]> = { local: [], paid: [], free: [] };
  for (const provider of providers) for (const model of Object.values(provider.models)) {
    const local = managed(provider.id, model.id) || model.access?.kind === "local";
    // A managed GPU may be unloaded: residency is acquired at prompt delivery,
    // so "not resident" is not a reason to hide the owner's model.
    if (!local && (!connected.includes(provider.id) || model.access?.state !== "available")) continue;
    if (model.access?.state === "unavailable") continue;
    const section = local ? "local" : model.access?.kind === "free" ? "free" : "paid";
    const note = local ? "Ваше оборудование" : section === "free" ? "Без оплаты за токены · возможны лимиты" : model.access?.kind === "subscription" ? "Доступ по подписке" : "Оплата по тарифу провайдера";
    groups[section].push({ providerID: provider.id, modelID: model.id, label: model.name ?? model.id, section: MODEL_SECTIONS[section], detail: `${provider.name ?? provider.id} · ${note}` });
  }
  return ["local", "paid", "free"].flatMap(section => groups[section as keyof typeof groups].sort((a, b) => a.label.localeCompare(b.label, "ru") || a.providerID.localeCompare(b.providerID)));
}
