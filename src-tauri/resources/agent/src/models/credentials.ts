// Pi provider credentials stored in the OS vault through the native broker.
//
// Implements the pi-ai CredentialStore contract on top of ONE native revision
// authority (shared with config import): `modify` reads value+revision, runs
// the SDK callback without any native lock held, then compare-and-sets. A
// stale revision is a conflict, never an overwrite, and the callback is never
// repeated (an OAuth refresh token may be single-use). Nothing is written to
// agentDir/auth.json; values live in memory only while a request needs them.

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Broker } from "../control/broker.ts";
import type { SdkAuthOptions, SdkCredential, SdkCredentialInfo, SdkCredentialStore } from "../sdk/adapter.ts";
import { ConfigProjection } from "./config.ts";

function isCredential(value: unknown): value is SdkCredential {
  if (!value || typeof value !== "object") return false;
  const c = value as { type?: unknown; key?: unknown; access?: unknown; refresh?: unknown; expires?: unknown };
  if (c.type === "api_key") return c.key === undefined || typeof c.key === "string";
  return c.type === "oauth" && typeof c.access === "string" && typeof c.refresh === "string" && typeof c.expires === "number";
}

export const validProvider = (id: string) => /^[A-Za-z0-9._-]{1,128}$/.test(id);

export class CredentialConflict extends Error {
  constructor() {
    super("CREDENTIAL_CONFLICT: данные доступа к провайдеру изменились в другом окне или процессе. Обновите и повторите.");
    this.name = "CredentialConflict";
  }
}

interface Loaded { credential: SdkCredential | undefined; revision: number; stored: boolean }

export class VaultCredentialStore implements SdkCredentialStore {
  private chains = new Map<string, Promise<unknown>>();

  /** `config` supplies the imported models.json key fallback and the fail-closed preflight. */
  constructor(private readonly broker: Broker, private readonly config: ConfigProjection = ConfigProjection.none()) {}

  private async load(providerId: string, signal?: AbortSignal): Promise<Loaded> {
    if (!validProvider(providerId)) return { credential: undefined, revision: 0, stored: false };
    // Before any provider request: unresolved bindings refuse, no ambient key.
    this.config.assertAdmissible(providerId);
    const result = await this.broker.call<{ value: string | null; revision: number }>("vault.credentialRead", { providerId }, signal);
    if (result.value === null) {
      // SDK precedence: a stored credential wins; models.json apiKey is the fallback.
      const key = this.config.apiKey(providerId);
      return { credential: key === undefined ? undefined : { type: "api_key", key }, revision: result.revision, stored: false };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(result.value); } catch { parsed = undefined; }
    if (!isCredential(parsed)) throw new Error("Сохранённые данные доступа к провайдеру повреждены.");
    return { credential: parsed, revision: result.revision, stored: true };
  }

  async read(providerId: string, options?: SdkAuthOptions): Promise<SdkCredential | undefined> {
    return (await this.load(providerId, options?.signal)).credential;
  }

  /** Metadata only; every value read stays inside the broker call per provider. */
  async list(options?: SdkAuthOptions): Promise<readonly SdkCredentialInfo[]> {
    const result = await this.broker.call<{ providers: string[] }>("vault.credentialList", {}, options?.signal);
    const out: SdkCredentialInfo[] = [];
    for (const providerId of result.providers) {
      if (!validProvider(providerId)) continue;
      const loaded = await this.load(providerId, options?.signal).catch(() => undefined);
      if (loaded?.stored && loaded.credential) out.push({ providerId, type: loaded.credential.type });
    }
    return out;
  }

  /** Idempotent by operationId: a lost ACK is retried once with the SAME id. */
  private async compareAndSet(providerId: string, expectedRevision: number, value: string | null, signal?: AbortSignal): Promise<{ revision: number; conflict?: boolean }> {
    const params = { operationId: randomUUID(), providerId, expectedRevision, value };
    try { return await this.broker.call("vault.compareAndSet", params, signal); }
    catch (error) {
      if (signal?.aborted) throw error;
      return this.broker.call("vault.compareAndSet", params, signal);
    }
  }

  /** Per-provider serialization shared by `modify` and `delete` (in-process; cross-process order is the native CAS). */
  private enqueue<T>(providerId: string, work: () => Promise<T>): Promise<T> {
    if (!validProvider(providerId)) return Promise.reject(new Error("Некорректный идентификатор провайдера."));
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(work);
    this.chains.set(providerId, task);
    void task.finally(() => { if (this.chains.get(providerId) === task) this.chains.delete(providerId); }).catch(() => {});
    return task;
  }

  /**
   * SDK contract (pi-ai auth/types.d.ts CredentialStore.modify): a callback
   * returning `undefined` leaves the entry UNCHANGED and resolves with the
   * current credential. It is never a deletion: the SDK OAuth double-check
   * returns undefined when another client already refreshed.
   */
  modify(providerId: string, fn: (current: SdkCredential | undefined) => Promise<SdkCredential | undefined>, options?: SdkAuthOptions): Promise<SdkCredential | undefined> {
    return this.enqueue(providerId, async () => {
      const current = await this.load(providerId, options?.signal);
      const next = await fn(current.credential);
      if (next === undefined) return current.credential;
      if (isDeepStrictEqual(next, current.credential)) return next;
      if (!isCredential(next)) throw new Error("Провайдер вернул некорректные данные доступа.");
      const result = await this.compareAndSet(providerId, current.revision, JSON.stringify(next), options?.signal);
      if (!result.conflict) return next;
      // Another store/process/import committed first. For an OAuth refresh use
      // that fresher committed credential; never re-run the refresh callback.
      if (current.credential?.type === "oauth" && next.type === "oauth") {
        const fresh = await this.load(providerId, options?.signal);
        if (fresh.stored && fresh.credential?.type === "oauth") return fresh.credential;
      }
      throw new CredentialConflict();
    });
  }

  /** Logout: its own serialized CAS tombstone at the revision just read; a newer write is a conflict, never erased. */
  delete(providerId: string, options?: SdkAuthOptions): Promise<void> {
    return this.enqueue(providerId, async () => {
      const current = await this.load(providerId, options?.signal);
      if (!current.stored) return;
      const result = await this.compareAndSet(providerId, current.revision, null, options?.signal);
      if (result.conflict) throw new CredentialConflict();
    });
  }
}
