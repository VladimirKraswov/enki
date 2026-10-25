import { isAllowedBaseUrl } from "../api/http";
import type { ModelService } from "./services";

/** Only public routing fields, never a provider's headers or API credential. */
export interface ModelSource {
  providerID: string;
  modelID: string;
  baseURL?: string;
  remoteID?: string;
}

function apiRoot(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || !isAllowedBaseUrl(url.origin)) return;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch { return; }
}

export function publicSources(models: ModelSource[]): ModelSource[] {
  return models.map(m => ({ providerID: m.providerID, modelID: m.modelID,
    baseURL: apiRoot(m.baseURL), remoteID: m.remoteID || m.modelID }));
}

/** An explicit binding establishes the relationship between an agent's API root
 * and a control endpoint (which may use another SSH port). Other providers at
 * that EXACT API root inherit the readiness gate, not execution permission.
 * The authenticated registry still has to authorize their exact public ID.
 * Never infer ownership from labels, ID prefixes or matching IDs on other hosts.
 */
export function resolveService(services: ModelService[], sources: Map<string, ModelSource[]>,
  providerID: string, modelID: string, agent?: string): { service?: ModelService; error?: string } {
  const explicit = services.find(s => s.providerID === providerID && Object.prototype.hasOwnProperty.call(s.bindings, modelID));
  if (explicit) return { service: explicit };
  const candidates: { service: ModelService; remoteID: string }[] = [];
  for (const [engine, models] of sources) {
    if (agent && engine !== agent) continue;
    const model = models.find(m => m.providerID === providerID && m.modelID === modelID);
    if (!model?.baseURL) continue;
    for (const service of services) {
      if (models.some(m => m.providerID === service.providerID && Object.prototype.hasOwnProperty.call(service.bindings, m.modelID) &&
          m.baseURL === model.baseURL)) candidates.push({ service, remoteID: model.remoteID || modelID });
    }
  }
  if (!candidates.length) return {};
  if (new Set(candidates.map(c => `${c.service.endpoint}/${c.remoteID}`)).size !== 1)
    return { error: "Для этого API настроены разные сервисы управления. Укажите явную привязку модели в настройках." };
  const { service, remoteID } = candidates[0];
  return { service: { ...service, providerID, bindings: { [modelID]: remoteID } } };
}
