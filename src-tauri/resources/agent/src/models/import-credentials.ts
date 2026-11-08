import { planPiAgentImport } from "../legacy/pi-agent.ts";
import type { SdkCredential, SdkCredentialStore } from "../sdk/adapter.ts";
import { CredentialConflict, validProvider } from "./credentials.ts";

export interface CredentialImportResult { imported: string[]; kept: string[]; failed: Array<{ provider: string; reason: string }> }

/** One provider at a time through the native versioned CAS. A present credential
 * is never replaced, so a retry after a lost ACK stays idempotent. */
async function transferSecrets(secrets: ReadonlyArray<{ provider?: string | null; value: unknown }>, store: SdkCredentialStore,
  configured: (provider: string) => boolean, signal?: AbortSignal): Promise<CredentialImportResult> {
  const result: CredentialImportResult = { imported: [], kept: [], failed: [] };
  for (const secret of secrets) {
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

/** Credential-only transfer never changes the active config generation, models,
 * defaults or discovery/trust. Each provider uses the native versioned CAS;
 * retries keep already imported keys, including after a lost overall ACK. */
export async function importLegacyCredentials(source: string, store: SdkCredentialStore, configured: (provider: string) => boolean, signal?: AbortSignal): Promise<CredentialImportResult> {
  const plan = planPiAgentImport(source, { origin: "user-pi-credentials", credentialsOnly: true });
  if (plan.secrets.length > 64 || plan.secrets.some(s => !s.provider || !validProvider(s.provider))) throw new Error("В прежних настройках Pi слишком много ключей или некорректное имя провайдера. Ничего не перенесено.");
  return transferSecrets(plan.secrets, store, configured, signal);
}

/** The runtime's own agentDir/auth.json is where the pinned SDK (and its CLI)
 * writes provider credentials, including subscription OAuth tokens. Enki keeps
 * credentials in the OS vault, so a token obtained outside Enki is invisible
 * until it is adopted here — that is why a signed-in subscription could be
 * missing from the model list. Only providers Enki already knows are adopted,
 * the vault always wins, and the file itself is never changed. */
export async function adoptAgentDirCredentials(agentDir: string, store: SdkCredentialStore, known: ReadonlySet<string>, signal?: AbortSignal): Promise<CredentialImportResult> {
  if (!known.size) return { imported: [], kept: [], failed: [] };
  let plan: ReturnType<typeof planPiAgentImport>;
  try { plan = planPiAgentImport(agentDir, { origin: "agent-dir-credentials", credentialsOnly: true }); }
  catch { return { imported: [], kept: [], failed: [] }; }
  // Unknown or malformed entries never reach the OS vault.
  const secrets = plan.secrets.filter(s => !!s.provider && validProvider(s.provider) && known.has(s.provider)).slice(0, 64);
  return transferSecrets(secrets, store, () => false, signal);
}
