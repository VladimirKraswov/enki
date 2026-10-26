// IO layer for the shared Hub model catalog: fetch/publish over the Hub command
// and apply to the single Enki Runtime's models.json through its CAS endpoint.

import { capabilityNative } from "../capabilities/integration";
import {
  mergePiModels,
  planCatalog,
  type HubCatalog,
  type HubModel,
  type HubModelsPrefs,
} from "../models/catalog";

export const fetchCatalog = () =>
  capabilityNative<HubCatalog>("hub_model_catalog", {
    action: "get",
    models: null,
    adminKey: null,
  });

export const publishCatalog = (models: HubModel[], adminKey?: string, expectedVersion?: number) =>
  capabilityNative<HubCatalog>("hub_model_catalog", {
    action: "publish",
    models: { models, ...(expectedVersion === undefined ? {} : {expectedVersion}) },
    adminKey: adminKey?.trim() ? adminKey.trim() : null,
  });

export interface ApplyReport {
  opencodeChanged: boolean;
  piChanged: boolean;
  added: string[];
  replaced: string[];
  removed: string[];
}

/**
 * models.json WAS committed, but the runtime could not re-read it cleanly. Not a
 * success; still, the written providers are now Enki-owned, so the caller must
 * record `appliedPi` or a later catalog removal could never remove them.
 */
export class CatalogRefreshError extends Error {
  readonly appliedPi: string[];
  constructor(message: string, appliedPi: string[]) { super(message); this.appliedPi = appliedPi; }
}

/** The single runtime's model configuration API (RuntimeClient). */
export interface RuntimeModelsPort {
  configStatus(): Promise<{ state: "none" | "ready" | "shadowed" | "blocked" }>;
  modelsConfig(): Promise<{ path: string; content: string; readOnly?: boolean }>;
  saveModelsConfig(expected: string, content: string): Promise<unknown>;
  refreshProviders(): Promise<{ errors: string[] }>;
}

/**
 * Writes the effective catalog into the ONE runtime's models.json through its
 * CAS endpoint and refreshes the runtime catalog. There is no per-engine
 * OpenCode/Pi writer any more. Refused (nothing written, no false "applied"):
 * - a remote runtime: its configuration and credentials are server-owned, and
 *   loopback catalog endpoints would point at the wrong machine;
 * - an active imported Pi generation (ready/blocked): writing the owner file
 *   would shadow it and drop its header/key bindings; no merge exists yet.
 */
export async function applyCatalog(
  catalog: HubCatalog,
  prefs: HubModelsPrefs,
  runtime: { client: RuntimeModelsPort; remote: boolean },
): Promise<{ report: ApplyReport; appliedOpencode: string[]; appliedPi: string[] }> {
  if (!prefs.enabled) throw new Error("Применение каталога выключено на этом устройстве.");
  if (runtime.remote) throw new Error("Каталог Hub применяется только к среде выполнения этого компьютера. Настройки моделей удалённого сервера не изменены.");
  const plan = planCatalog(catalog, prefs);
  const status = await runtime.client.configStatus();
  const current = await runtime.client.modelsConfig();
  if (status.state === "ready" || status.state === "blocked" || current.readOnly)
    throw new Error("Настройки моделей загружены из внешнего профиля. Их объединение с каталогом Hub пока не поддерживается; текущие подключения сохранены.");
  const piMerge = mergePiModels(current.content, plan.pi, plan.removePi);
  if (piMerge.error) throw new Error(piMerge.error);
  // CAS: an edit made elsewhere since the read is refused by the runtime (409).
  if (piMerge.changed) await runtime.client.saveModelsConfig(current.content, piMerge.text);
  const appliedPi = Object.keys(plan.pi);
  const refreshed = await runtime.client.refreshProviders().catch((error: unknown) => ({ errors: [error instanceof Error ? error.message : String(error)] }));
  if (refreshed.errors.length)
    throw new CatalogRefreshError(`Каталог записан, но среда выполнения сообщила об ошибках при перечитывании моделей: ${refreshed.errors.join("; ")}`, appliedPi);
  return {
    report: { opencodeChanged: false, piChanged: piMerge.changed, added: piMerge.added, replaced: piMerge.replaced, removed: piMerge.removed },
    appliedOpencode: [],
    appliedPi,
  };
}
