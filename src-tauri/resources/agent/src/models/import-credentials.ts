import { planPiAgentImport } from "../legacy/pi-agent.ts";
import type { SdkCredential, SdkCredentialStore } from "../sdk/adapter.ts";
import { CredentialConflict, validProvider } from "./credentials.ts";

export interface CredentialImportResult { imported: string[]; kept: string[]; failed: Array<{ provider: string; reason: string }> }
/** Credential-only transfer never changes the active config generation, models,
 * defaults or discovery/trust. Each provider uses the native versioned CAS;
 * retries keep already imported keys, including after a lost overall ACK. */
export async function importLegacyCredentials(source: string, store: SdkCredentialStore, configured: (provider: string) => boolean, signal?: AbortSignal): Promise<CredentialImportResult> {
  const plan = planPiAgentImport(source, { origin: "user-pi-credentials", credentialsOnly: true });
  if (plan.secrets.length > 64 || plan.secrets.some(s => !s.provider || !validProvider(s.provider))) throw new Error("В прежних настройках Pi слишком много ключей или некорректное имя провайдера. Ничего не перенесено.");
  const result: CredentialImportResult = { imported: [], kept: [], failed: [] };
  for (const secret of plan.secrets) {
    signal?.throwIfAborted();
    const provider = secret.provider!;
    if (configured(provider)) { result.kept.push(provider); continue; }
    try {
      let kept = false;
      const value = await store.modify(provider, async current => { kept = current !== undefined; return current ?? structuredClone(secret.value) as SdkCredential; }, { signal });
      if (!value) throw new Error("No committed credential");
      (kept ? result.kept : result.imported).push(provider);
    } catch (error) {
      signal?.throwIfAborted();
      result.failed.push({ provider, reason: error instanceof CredentialConflict ? "Ключ изменился в другом окне. Существующий ключ сохранён." : "Не удалось сохранить ключ в хранилище ОС. Проверьте системное разрешение для Enki." });
    }
  }
  return result;
}
