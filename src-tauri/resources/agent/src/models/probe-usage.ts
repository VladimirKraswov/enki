// Read the provider's OWN quota. For Kimi Code the subscription endpoint is
// `<api base>/v1/usages` returning the 5-hour, weekly and monthly ratios with
// reset timestamps. Credentials are resolved through the runtime's credential
// store, so a refreshed OAuth token is used — never a stale `auth.json` copy.
import { catalogueRequest, findModel, type SdkModelRuntime } from "../sdk/adapter.ts";
import { parseDeepSeekBalance, parseProviderUsage, type ProviderUsage } from "./usage.ts";

export function usageEndpoint(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, "");
  return `${base}${base.endsWith("/v1") ? "" : "/v1"}/usages`;
}

export function deepSeekBalanceEndpoint(baseURL: string): string {
  const url = new URL(baseURL);
  if (url.protocol !== "https:" || url.origin !== "https://api.deepseek.com") throw new Error("Неофициальный адрес DeepSeek API.");
  return new URL("/user/balance", url.origin).href;
}

export async function probeProviderUsage(runtime: SdkModelRuntime, providerID: string, modelID: string, signal: AbortSignal): Promise<ProviderUsage> {
  const model = findModel(runtime, providerID, modelID);
  if (!model) throw new Error("Модель не найдена в каталоге Pi.");
  const resolved = await catalogueRequest(runtime, model, signal);
  if (!resolved) throw new Error("Нет сохранённых данных доступа к этому провайдеру.");
  const deepSeek = providerID === "deepseek";
  const endpoint = deepSeek ? deepSeekBalanceEndpoint(resolved.baseURL) : usageEndpoint(resolved.baseURL);
  const response = await fetch(endpoint, { headers: { ...resolved.headers, Accept: "application/json" }, signal });
  if (!response.ok) throw new Error(`Провайдер не отдал данные квоты (HTTP ${response.status}).`);
  const payload = await response.json().catch(() => null);
  const usage = deepSeek ? parseDeepSeekBalance(payload) : parseProviderUsage(payload);
  if (!usage) throw new Error("Провайдер вернул неподдерживаемые данные квоты.");
  return usage;
}
