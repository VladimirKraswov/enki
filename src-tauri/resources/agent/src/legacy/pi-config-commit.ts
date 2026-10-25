// Concrete PiConfigCommitPort over the LOCAL supervisor broker only.
//
// The frozen plan's sanitized parts become a manifest (names, hashes, sizes,
// bindings, deferred pointers, discovery policy — never `secrets`). Files go
// in fixed 48 KiB chunks so every control frame stays far below 1 MiB; each
// secret is one bounded frame, compared by native code against the already
// staged OS value on retry. The full inventory is budgeted BEFORE begin. A
// lost ACK is reconciled through config.status with the SAME operation id:
// no new import, no new id, no blind credential replay, no partial success.

import { randomUUID } from "node:crypto";
import type { Broker, ConfigMethod } from "../control/broker.ts";
import { PiConfigError, type PiAgentPlan, type PiConfigCommitPort } from "./pi-agent.ts";

export const CONFIG_CHUNK = 48 * 1024;
const MAX_SECRET = 64 * 1024, MAX_FILE = 4 * 1024 * 1024, MAX_TOTAL = 12 * 1024 * 1024, MAX_BINDINGS = 1024;
const PROVIDER = /^[A-Za-z0-9._-]{1,128}$/;

export interface CommitReceipt {
  receiptId: string;
  files: Array<{ name: string; sha256: string }>;
  vaultIds: string[];
  configRevision: number;
  generationId: string;
  manifestHash: string;
  /** Deterministic precedence outcomes, e.g. an existing provider credential kept. */
  conflicts: Array<{ vaultId: string; policy: string }>;
}
interface Status { phase: "unknown" | "prepared" | "published" | "committed" | "aborted"; receipt?: CommitReceipt; error?: string | null }

/** Native errors are fixed `CODE: text` strings; only the code is surfaced. */
function codeOf(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  return /^(CONFIG_[A-Z_]+|CREDENTIAL_[A-Z_]+):/.exec(message)?.[1] ?? fallback;
}

export interface CommitPortOptions {
  signal?: AbortSignal;
  /** Runtime gates: maintenance fence, existing owner models.json conflict. Throws to refuse. */
  preflight?: () => void;
}

export class NativePiConfigCommitPort implements PiConfigCommitPort {
  constructor(private readonly broker: Broker, private readonly options: CommitPortOptions = {}) {}

  private call<T>(method: ConfigMethod, params: Record<string, unknown>): Promise<T> {
    return this.broker.call<T>(method, params, this.options.signal, 30_000);
  }

  /** Same request once more after a lost ACK; native dedupes by id/index/value. */
  private async idempotent<T>(method: ConfigMethod, params: Record<string, unknown>): Promise<T> {
    try { return await this.call<T>(method, params); }
    catch (error) {
      if (this.options.signal?.aborted || codeOf(error, "") !== "") throw error;
      return this.call<T>(method, params);
    }
  }

  private budget(plan: PiAgentPlan): void {
    let total = 0;
    for (const file of plan.files) {
      const size = Buffer.byteLength(file.content, "utf8");
      if (size === 0 || size > MAX_FILE) throw new PiConfigError("publication_file_too_large", `/${file.name}`);
      total += size;
    }
    if (total > MAX_TOTAL) throw new PiConfigError("publication_inventory_too_large", "/");
    if (plan.bindings.length > MAX_BINDINGS || plan.bindings.length !== plan.secrets.length) throw new PiConfigError("publication_inventory_too_large", "/bindings");
    for (const binding of plan.bindings) {
      // One identifier contract for planner, native authority and CredentialStore.
      if (binding.provider === null ? binding.kind === "credential" : !PROVIDER.test(binding.provider))
        throw new PiConfigError("provider_id_requires_explicit_mapping", binding.pointer);
      if (!plan.secrets.some(secret => secret.id === binding.vaultId)) throw new PiConfigError("incomplete_secret_inventory", binding.pointer);
    }
    for (const secret of plan.secrets)
      if (Buffer.byteLength(JSON.stringify(secret.value), "utf8") > MAX_SECRET) throw new PiConfigError("secret_exceeds_os_vault_limit", secret.sourcePointer);
  }

  async commit(plan: PiAgentPlan): Promise<CommitReceipt> {
    if (this.broker.kind !== "supervisor" || !this.broker.available()) throw new PiConfigError("local_native_vault_required", "/");
    this.budget(plan);
    this.options.preflight?.();
    const current = await this.call<{ configRevision: number }>("config.current", {});
    const manifest = {
      version: 1, origin: plan.origin, expectedRevision: current.configRevision,
      files: plan.files.map(file => ({ name: file.name, sha256: file.sha256, size: Buffer.byteLength(file.content, "utf8") })),
      sourceHashes: { ...plan.sourceHashes },
      bindings: plan.bindings.map(b => ({ vaultId: b.vaultId, pointer: b.pointer, provider: b.provider, kind: b.kind })),
      deferred: [...plan.deferred], discovery: { ...plan.discovery },
    };
    const operationId = randomUUID();
    let receipt: CommitReceipt;
    try {
      await this.idempotent("config.begin", { operationId, manifest });
      for (const file of plan.files) {
        const bytes = Buffer.from(file.content, "utf8");
        for (let index = 0; index * CONFIG_CHUNK < bytes.length; index++) {
          const dataBase64 = bytes.subarray(index * CONFIG_CHUNK, (index + 1) * CONFIG_CHUNK).toString("base64");
          await this.idempotent("config.fileChunk", { operationId, name: file.name, index, dataBase64 });
        }
      }
      for (const secret of plan.secrets)
        await this.idempotent("config.secretPut", { operationId, logicalId: secret.id, value: JSON.stringify(secret.value) });
      receipt = await this.commitOrReconcile(operationId);
    } catch (error) {
      // Before the head nothing is active; remove only this job's own refs.
      const status = await this.call<Status>("config.status", { operationId }).catch(() => null);
      if (status?.phase === "committed" && status.receipt) receipt = status.receipt;
      else {
        await this.call("config.abort", { operationId }).catch(() => undefined);
        throw new PiConfigError(codeOf(error, "native_commit_failed").toLowerCase(), "/commit");
      }
    }
    this.verify(plan, receipt, current.configRevision);
    return receipt;
  }

  private async commitOrReconcile(operationId: string): Promise<CommitReceipt> {
    try { return await this.call<CommitReceipt>("config.commit", { operationId }); }
    catch (error) {
      if (this.options.signal?.aborted || codeOf(error, "") !== "") throw error;
      // Lost ACK: ask, never re-import. A still-open job resumes idempotently.
      const status = await this.call<Status>("config.status", { operationId });
      if (status.phase === "committed" && status.receipt) return status.receipt;
      if (status.phase === "prepared" || status.phase === "published") return this.call<CommitReceipt>("config.commit", { operationId });
      throw error;
    }
  }

  /** The receipt must describe exactly this frozen plan, nothing more or less. */
  private verify(plan: PiAgentPlan, receipt: CommitReceipt, expected: number): void {
    const files = new Map(receipt.files.map(file => [file.name, file.sha256]));
    const ids = new Set(receipt.vaultIds);
    if (receipt.configRevision !== expected + 1 || files.size !== plan.files.length || receipt.files.length !== plan.files.length
      || !plan.files.every(file => files.get(file.name) === file.sha256)
      || ids.size !== plan.secrets.length || receipt.vaultIds.length !== plan.secrets.length || !plan.secrets.every(secret => ids.has(secret.id)))
      throw new PiConfigError("receipt_does_not_match_plan", "/commit");
  }
}
