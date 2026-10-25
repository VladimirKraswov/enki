// TEST ONLY. In-memory model of the native config/credential authority broker
// contract (src-tauri/src/runtime/config_commit.rs), used to exercise the TS
// port, projection and CredentialStore. The real authority, OS vault, durable
// publication and crash recovery are covered by the native Rust suite.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Broker, BrokerMethod } from "../src/control/broker.ts";

interface Op { phase: string; manifest: any; generation: string; chunks: Map<string, Buffer>; refs: Map<string, string>; receipt?: any; error?: string }
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export class FakeAuthority implements Broker {
  readonly kind = "supervisor" as const;
  readonly calls: Array<{ method: string; frame: string }> = [];
  readonly vault = new Map<string, string>();
  readonly credentials = new Map<string, { revision: number; account: string | null }>();
  readonly head = { revision: 0, generation: null as string | null, op: null as string | null };
  readonly ops = new Map<string, Op>();
  private readonly cas = new Map<string, { provider: string; expected: number; request: string; result: any }>();
  /** Execute the next call of this method, then lose its response (lost ACK). */
  readonly loseAck = new Set<string>();
  /** Fail the next call of this method with a native coded error before executing it. */
  readonly failNext = new Map<string, string>();
  constructor(readonly root: string) {}
  available(): boolean { return true; }

  /** Full Broker.call signature. The in-memory authority answers synchronously;
   * cancellation/timeout are transport concerns it does not model. */
  async call<T>(method: BrokerMethod, params: Record<string, unknown>, _signal?: AbortSignal, _timeoutMs?: number): Promise<T> {
    this.calls.push({ method, frame: JSON.stringify({ type: "request", id: randomUUID(), method, params }) });
    const failure = this.failNext.get(method);
    if (failure) { this.failNext.delete(method); throw new Error(failure); }
    const result = this.handle(method, structuredClone(params) as any);
    if (this.loseAck.delete(method)) throw new Error("Enki не ответил на запрос среды выполнения вовремя.");
    return structuredClone(result) as T;
  }

  private handle(method: string, p: any): unknown {
    switch (method) {
      case "config.current": {
        const op = this.head.op ? this.ops.get(this.head.op) : undefined;
        if (!op) return { configRevision: this.head.revision, generationId: null };
        return { configRevision: this.head.revision, generationId: op.generation, manifestHash: op.receipt.manifestHash,
          directory: path.join(this.root, op.generation), files: op.manifest.files,
          bindings: op.manifest.bindings, deferred: op.manifest.deferred };
      }
      case "config.begin": {
        const existing = this.ops.get(p.operationId);
        if (existing) { if (sha(JSON.stringify(existing.manifest)) !== sha(JSON.stringify(p.manifest))) throw new Error("CONFIG_OPERATION_CONFLICT: x"); return { phase: existing.phase }; }
        if (p.manifest.expectedRevision !== this.head.revision) throw new Error("CONFIG_REVISION_CONFLICT: x");
        this.ops.set(p.operationId, { phase: "prepared", manifest: p.manifest, generation: `g${randomUUID()}`, chunks: new Map(), refs: new Map() });
        return { phase: "prepared", configRevision: this.head.revision };
      }
      case "config.fileChunk": {
        const op = this.open(p.operationId), data = Buffer.from(p.dataBase64, "base64");
        if (data.length > 48 * 1024) throw new Error("CONFIG_SCHEMA: x");
        const prior = op.chunks.get(p.name) ?? Buffer.alloc(0), offset = p.index * 48 * 1024;
        if (offset < prior.length) { if (!prior.subarray(offset, offset + data.length).equals(data)) throw new Error("CONFIG_OPERATION_CONFLICT: x"); return {}; }
        if (offset !== prior.length) throw new Error("CONFIG_CHUNK_ORDER: x");
        op.chunks.set(p.name, Buffer.concat([prior, data]));
        return {};
      }
      case "config.secretPut": {
        const op = this.open(p.operationId), account = `pi-ref:${sha(`${p.logicalId}\0${p.operationId}`)}`;
        if (Buffer.byteLength(p.value) > 64 * 1024) throw new Error("CONFIG_SECRET_TOO_LARGE: x");
        const staged = this.vault.get(account);
        if (staged !== undefined && staged !== p.value) throw new Error("CONFIG_SECRET_CONFLICT: x");
        this.vault.set(account, p.value); op.refs.set(p.logicalId, account);
        return { staged: true };
      }
      case "config.commit": {
        const op = this.ops.get(p.operationId);
        if (!op) throw new Error("CONFIG_OPERATION_UNKNOWN: x");
        if (op.phase === "committed") return op.receipt;
        if (op.phase === "aborted") throw new Error(op.error);
        if (op.manifest.expectedRevision !== this.head.revision) { this.cleanup(op, "CONFIG_REVISION_CONFLICT: x"); throw new Error("CONFIG_REVISION_CONFLICT: x"); }
        for (const file of op.manifest.files) if (sha(op.chunks.get(file.name) ?? "") !== file.sha256) throw new Error("CONFIG_INCOMPLETE: x");
        if (op.manifest.bindings.some((b: any) => !op.refs.has(b.vaultId))) throw new Error("CONFIG_INCOMPLETE: x");
        const dir = path.join(this.root, op.generation);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        for (const file of op.manifest.files) fs.writeFileSync(path.join(dir, file.name), op.chunks.get(file.name)!, { mode: 0o600 });
        const conflicts: any[] = [];
        for (const b of op.manifest.bindings) if (b.kind === "credential") {
          if (this.credentials.has(b.provider)) conflicts.push({ vaultId: b.vaultId, policy: "existing-provider-credential-kept" });
          else this.credentials.set(b.provider, { revision: 1, account: op.refs.get(b.vaultId)! });
        }
        this.head.revision += 1; this.head.generation = op.generation; this.head.op = p.operationId;
        op.phase = "committed";
        op.receipt = { receiptId: `cfg-${sha(p.operationId).slice(0, 32)}`, files: op.manifest.files.map((f: any) => ({ name: f.name, sha256: f.sha256 })),
          vaultIds: op.manifest.bindings.map((b: any) => b.vaultId), configRevision: this.head.revision, generationId: op.generation,
          manifestHash: sha(JSON.stringify(op.manifest)), conflicts };
        return op.receipt;
      }
      case "config.status": {
        const op = this.ops.get(p.operationId);
        return op ? { phase: op.phase, receipt: op.receipt, error: op.error ?? null } : { phase: "unknown" };
      }
      case "config.abort": {
        const op = this.ops.get(p.operationId);
        if (!op) throw new Error("CONFIG_OPERATION_UNKNOWN: x");
        if (op.phase !== "committed") this.cleanup(op, "CONFIG_CANCELLED: x");
        return { phase: op.phase };
      }
      case "config.secretRead": {
        if (p.configRevision !== this.head.revision) throw new Error("CONFIG_REVISION_CHANGED: x");
        const account = this.ops.get(this.head.op!)?.refs.get(p.logicalId);
        const value = account ? this.vault.get(account) : undefined;
        if (value === undefined) throw new Error("CONFIG_SECRET_UNAVAILABLE: x");
        return { value, configRevision: this.head.revision };
      }
      case "vault.credentialRead": {
        const row = this.credentials.get(p.providerId);
        if (!row) return { value: null, revision: 0, source: "none" };
        if (row.account === null) return { value: null, revision: row.revision, source: "deleted" };
        const value = this.vault.get(row.account);
        if (value === undefined) throw new Error("CONFIG_SECRET_UNAVAILABLE: x");
        return { value, revision: row.revision, source: "versioned" };
      }
      case "vault.credentialList": return { providers: [...this.credentials].filter(([, r]) => r.account).map(([k]) => k) };
      case "vault.compareAndSet": {
        // Receipt bound to the COMPLETE request incl. value-vs-null (native: vault-keyed MAC, never the value).
        const request = p.value === null ? "null" : `value:${sha(p.value)}`;
        const prior = this.cas.get(p.operationId);
        if (prior) { if (prior.provider !== p.providerId || prior.expected !== p.expectedRevision || prior.request !== request) throw new Error("CONFIG_OPERATION_CONFLICT: x"); return prior.result; }
        const row = this.credentials.get(p.providerId), revision = row?.revision ?? 0;
        let result: any;
        if (revision !== p.expectedRevision) result = { conflict: true, revision };
        else {
          const account = p.value === null ? null : `pi-ref:${sha(`${p.providerId}\0${p.operationId}`)}`;
          if (account) this.vault.set(account, p.value);
          this.credentials.set(p.providerId, { revision: revision + 1, account });
          result = { revision: revision + 1 };
        }
        this.cas.set(p.operationId, { provider: p.providerId, expected: p.expectedRevision, request, result });
        return result;
      }
      default: throw new Error("Неизвестный запрос среды выполнения");
    }
  }

  private open(id: string): Op {
    const op = this.ops.get(id);
    if (!op) throw new Error("CONFIG_OPERATION_UNKNOWN: x");
    if (op.phase !== "prepared") throw new Error("CONFIG_OPERATION_PHASE: x");
    return op;
  }
  private cleanup(op: Op, error: string): void {
    for (const account of op.refs.values()) this.vault.delete(account);
    op.phase = "aborted"; op.error = error;
  }
}
