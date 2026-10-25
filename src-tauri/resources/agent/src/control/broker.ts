// Privileged operations the runtime cannot perform itself.
//
// The OS credential vault and the pinned-identity Hub client live in the native
// Enki process. The runtime asks for them through a broker:
//   - local runtime: JSON lines on the supervisor's stdio pipe (always present
//     while Enki runs, including when the window is hidden to the tray);
//   - remote runtime: relayed through an authenticated attached desktop client
//     (`broker.request` events answered via POST /v1/broker/:id). With no client
//     attached, brokered operations wait boundedly and then fail closed.
// No secret is ever written to disk, a URL or a log by the runtime.

import { randomUUID } from "node:crypto";

export type BrokerMethod =
  /** Versioned provider credentials: CAS is the only write path (no blind write/delete). */
  | "vault.credentialRead" | "vault.credentialList" | "vault.compareAndSet"
  /** Imported config transaction + active snapshot. Local supervisor only, never relayed. */
  | ConfigMethod
  | "hub.identity" | "hub.request"
  /** Native shared-capability registry for one project: key, skill roots, MCP readiness. */
  | "capabilities.prepare"
  | "ui.clipboard.write" | "ui.clipboard.read" | "ui.open-url";

export type ConfigMethod =
  | "config.begin" | "config.fileChunk" | "config.secretPut" | "config.commit"
  | "config.status" | "config.abort" | "config.current" | "config.secretRead";

export interface CapabilitiesScope {
  key: string;
  root: string;
  skillPaths: string[];
  /** Shared MCP runtime installed and at least one server enabled. */
  mcp: boolean;
  /** Servers are enabled but the shared runtime is missing: shown, never silent. */
  mcpUnavailable: string | null;
  /** Absolute Enki executable providing `--shared-mcp` and `--browser-mcp`. */
  executable: string;
  /** Managed browser tools are installed on this host. */
  browser: boolean;
  /** Browser skills; loaded only while the browser is enabled in settings. */
  browserSkillPath: string | null;
  lspConfig: string | null;
}

export interface Broker {
  readonly kind: "supervisor" | "client-relay" | "none";
  available(): boolean;
  call<T>(method: BrokerMethod, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<T>;
}

export class BrokerUnavailable extends Error {
  constructor(message = "Операция требует подключённого Enki (хранилище ключей или Hub недоступны).") { super(message); this.name = "BrokerUnavailable"; }
}

interface Waiting { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; detach(): void }

/** Correlates request ids with responses for any line/event transport. */
export class PendingCalls {
  private waiting = new Map<string, Waiting>();

  start<T>(send: (id: string) => void, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error("Операция отменена."));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => this.fail(id, new Error("Операция отменена."));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer: setTimeout(() => this.fail(id, new BrokerUnavailable("Enki не ответил на запрос среды выполнения вовремя.")), timeoutMs),
        detach: () => signal?.removeEventListener("abort", onAbort),
      });
      try { send(id); } catch (error) { this.fail(id, error instanceof Error ? error : new Error(String(error))); }
    });
  }

  settle(id: string, result: { ok: true; value: unknown } | { ok: false; error: string }): boolean {
    const waiting = this.waiting.get(id);
    if (!waiting) return false;
    this.waiting.delete(id);
    clearTimeout(waiting.timer);
    waiting.detach();
    if (result.ok) waiting.resolve(result.value);
    else waiting.reject(new Error(result.error.slice(0, 1000)));
    return true;
  }

  fail(id: string, error: Error): void {
    const waiting = this.waiting.get(id);
    if (!waiting) return;
    this.waiting.delete(id);
    clearTimeout(waiting.timer);
    waiting.detach();
    waiting.reject(error);
  }

  failAll(error: Error): void {
    for (const id of [...this.waiting.keys()]) this.fail(id, error);
  }
}

/** Broker over the supervisor pipe; `send` writes one JSON line to it. */
export class SupervisorBroker implements Broker {
  readonly kind = "supervisor" as const;
  readonly pending = new PendingCalls();
  private connected = true;

  constructor(private readonly send: (message: Record<string, unknown>) => void) {}

  available(): boolean { return this.connected; }

  disconnect(): void {
    this.connected = false;
    this.pending.failAll(new BrokerUnavailable("Связь с Enki прервана."));
  }

  call<T>(method: BrokerMethod, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
    if (!this.connected) return Promise.reject(new BrokerUnavailable());
    return this.pending.start<T>((id) => this.send({ type: "request", id, method, params }), signal, timeoutMs);
  }
}

/** Broker for a remote runtime: requests are published to attached clients. */
export class ClientRelayBroker implements Broker {
  readonly kind = "client-relay" as const;
  readonly pending = new PendingCalls();
  private clients = 0;

  constructor(private readonly publish: (request: { id: string; method: BrokerMethod; params: Record<string, unknown> }) => void) {}

  attach(): () => void {
    this.clients++;
    let detached = false;
    return () => { if (!detached) { detached = true; this.clients--; } };
  }

  available(): boolean { return this.clients > 0; }

  call<T>(method: BrokerMethod, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
    if (!this.available()) return Promise.reject(new BrokerUnavailable("Удалённой среде нужен подключённый Enki для доступа к Hub и хранилищу ключей."));
    return this.pending.start<T>((id) => this.publish({ id, method, params }), signal, timeoutMs);
  }
}

export const NO_BROKER: Broker = {
  kind: "none",
  available: () => false,
  call: () => Promise.reject(new BrokerUnavailable()),
};
