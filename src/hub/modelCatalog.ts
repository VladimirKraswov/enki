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

/** Thrown by a preWrite guard when new agent work started while the catalog
 * plan was being read: nothing has been written and nothing needs rollback. */
export class CatalogBusyAbort extends Error {
  constructor() { super("Агенты ещё работают; каталог не применён, настройки не изменены."); }
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
  preWrite?: () => void,
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
  // The caller's guard runs after every await before this point and
  // immediately before the write: work that started while the plan was being
  // read must not be displaced by the save.
  if (piMerge.changed) {
    preWrite?.();
    await runtime.client.saveModelsConfig(current.content, piMerge.text);
  }
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

export interface CatalogPreview {
  /** true when applying would write models.json (or the read could not decide). */
  changed: boolean;
  /** An external/imported or read-only profile: apply refuses regardless of diff. */
  blocked: boolean;
  /** Provider ids a successful (or already-matching) apply would record as owned. */
  appliedPi: string[];
}

/**
 * Read-only structural check against the live models.json: the same plan and
 * merge that applyCatalog would perform, but no CAS write and no provider
 * refresh, so it is safe while an agent is busy and cannot surface an
 * unrelated provider's discovery timeout as a failed apply. An unparseable or
 * unreadable configuration reports `changed` — only a real equality is a no-op.
 */
export async function previewCatalog(
  catalog: HubCatalog,
  prefs: HubModelsPrefs,
  runtime: { client: RuntimeModelsPort; remote: boolean },
): Promise<CatalogPreview> {
  const plan = planCatalog(catalog, prefs);
  const appliedPi = Object.keys(plan.pi);
  if (runtime.remote) return { changed: true, blocked: true, appliedPi };
  if (!prefs.enabled) return { changed: appliedPi.length > 0, blocked: false, appliedPi };
  const status = await runtime.client.configStatus();
  const current = await runtime.client.modelsConfig();
  if (status.state === "ready" || status.state === "blocked" || current.readOnly)
    return { changed: true, blocked: true, appliedPi };
  const merge = mergePiModels(current.content, plan.pi, plan.removePi);
  if (merge.error) return { changed: true, blocked: false, appliedPi };
  return { changed: merge.changed, blocked: false, appliedPi };
}
