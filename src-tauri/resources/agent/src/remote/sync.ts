// Versioned Runtime↔Hub synchronization transport. No polling timers or command
// execution live in the snapshot builder; no Hub data is an execution authority.
import type { Runtime } from "../core/runtime.ts";

export type RemoteCommand = { id: string; session: string | null; kind: string; payload: Record<string, unknown> };
type SyncAnswer = { commands?: RemoteCommand[]; watch?: string | null; revision?: number; detailRevision?: number };
type Hooks = {
  beforeSync: (signal: AbortSignal) => Promise<void>;
  overview: () => Record<string, unknown>;
  detail: (session: string) => Record<string, unknown>;
  execute: (command: RemoteCommand, signal: AbortSignal) => Promise<unknown>;
};

export class RemoteSyncTransport {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private failures = 0;
  private watch: string | null = null;
  private readonly results = new Map<string, { ok: boolean; result: unknown }>();
  private readonly abort = new AbortController();

  constructor(private readonly runtime: Runtime, private readonly intervalMs: number, private readonly hooks: Hooks) {}

  start(): void { if (!this.timer && !this.running && !this.stopped) void this.tick(); }
  stop(): void {
    this.stopped = true; this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  private schedule(delay = this.intervalMs): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { this.timer = null; void this.tick(); }, delay);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped || this.runtime.draining) { this.schedule(); return; }
    this.running = true;
    let immediate = false;
    try {
      const identity = await this.runtime.config.broker.call<{ scope: string | null }>("hub.identity", {}, this.abort.signal, 5_000);
      if (!identity.scope) return;
      await this.hooks.beforeSync(this.abort.signal);
      // One request and one Hub transaction. A detail response can no longer be
      // lost behind an independently successful overview heartbeat.
      const response = await this.runtime.config.broker.call<SyncAnswer>("hub.request", {
        path: "remote/sync", scope: identity.scope,
        body: { overview: this.hooks.overview(), detail: this.watch ? this.hooks.detail(this.watch) : undefined },
      }, this.abort.signal, 15_000);
      if (response.watch !== this.watch) { this.watch = response.watch ?? null; immediate = true; }
      this.failures = 0;
      for (const command of response.commands ?? []) {
        if (this.stopped) break;
        let result: unknown, ok = false;
        const previous = this.results.get(command.id);
        if (previous) { ok = previous.ok; result = previous.result; }
        else {
          try { result = await this.hooks.execute(command, this.abort.signal); ok = true; }
          catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
          this.results.set(command.id, { ok, result });
          if (this.results.size > 500) this.results.delete(this.results.keys().next().value!);
        }
        try {
          await this.runtime.config.broker.call("hub.request", { path: "remote/complete", scope: identity.scope,
            body: { id: command.id, ok, result } }, this.abort.signal, 10_000);
        } catch { /* delivered command remains durable and is retried */ }
        immediate = true;
      }
    } catch {
      this.failures += 1;
      // Local chats are never blocked by Hub absence; bounded backoff avoids
      // hot reconnect loops while preserving automatic recovery.
    } finally {
      this.running = false;
      this.schedule(immediate ? 0 : Math.min(10_000, this.intervalMs * 2 ** Math.min(this.failures, 4)));
    }
  }
}
