import type { ProviderInfo } from "../api/types";

export const MODEL_SECTIONS = { local: "Мои локальные модели", paid: "Платные модели", free: "Бесплатные модели" } as const;
export interface PickerModel { providerID: string; modelID: string; label: string; section: string; detail: string }

/** A chat's durable model choice is not an entitlement observation. A transient
 * discovery failure must not make the currently selected working model vanish
 * from its own picker (or look like a denial). Other unconfirmed models remain
 * hidden until discovery confirms them. */
export function withCurrentSelection(models: PickerModel[], providers: ProviderInfo[],
  selection: { providerID: string; modelID: string } | null): PickerModel[] {
  if (!selection || models.some(m => m.providerID === selection.providerID && m.modelID === selection.modelID)) return models;
  const provider = providers.find(p => p.id === selection.providerID);
  const model = provider?.models[selection.modelID];
  const state = model?.access?.state;
  const detail = state === "unavailable"
    ? `${provider?.name ?? selection.providerID} · проверка не подтвердила доступ; выбор чата сохранён`
    : state === "unknown"
      ? `${provider?.name ?? selection.providerID} · доступ проверяется; выбор чата сохранён`
      : `${provider?.name ?? selection.providerID} · выбрана в этом чате`;
  return [{
    providerID: selection.providerID, modelID: selection.modelID,
    label: model?.name ?? selection.modelID, section: "Текущая модель", detail,
  }, ...models];
}

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
