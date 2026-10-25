// Host lifecycle only: no SDK, agent loop, transcript or execution policy.
export interface RuntimePort {
  stopAdmission(): void;
  drain(deadlineMs: number): Promise<{ interrupted: unknown[] }>;
  shutdown(): Promise<void>;
}
export interface TransportPort {
  port: number;
  stopAdmission(): void;
  close(deadlineMs?: number): Promise<void>;
}
export interface StopResult { interrupted: unknown[]; errors: string[]; timedOut: boolean }
export class Lifecycle {
  state: 'new' | 'starting' | 'ready' | 'stopping' | 'stopped' = 'new';
  readonly startup = new AbortController();
  private runtime?: RuntimePort;
  private transport?: TransportPort;
  private starting?: Promise<void>;
  private stopping?: Promise<StopResult>;
  constructor(private readonly hooks: {
    create(signal: AbortSignal): Promise<RuntimePort>;
    listen(runtime: RuntimePort, signal: AbortSignal): Promise<TransportPort>;
    ready(runtime: RuntimePort, transport: TransportPort): void;
  }) {}
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.state !== 'new') return Promise.reject(new Error('Runtime startup was cancelled'));
    this.state = 'starting';
    this.starting = (async () => {
      this.runtime = await this.hooks.create(this.startup.signal);
      if (this.startup.signal.aborted) { this.runtime.stopAdmission(); return; }
      this.transport = await this.hooks.listen(this.runtime, this.startup.signal);
      if (this.startup.signal.aborted) { this.transport.stopAdmission(); return; }
      this.state = 'ready';
      this.hooks.ready(this.runtime, this.transport);
    })();
    return this.starting;
  }
  stop(deadlineMs: number): Promise<StopResult> {
    if (this.stopping) return this.stopping;
    this.state = 'stopping';
    this.startup.abort(new Error('Runtime startup stopped'));
    this.runtime?.stopAdmission();
    this.transport?.stopAdmission();
    const until = Date.now() + Math.min(Math.max(Number.isFinite(deadlineMs) ? deadlineMs : 0, 0), 30 * 60_000);
    const result: StopResult = { interrupted: [], errors: [], timedOut: false };
    const bounded = async <T>(work: () => Promise<T>, label: string): Promise<T | undefined> => {
      const remaining = Math.max(0, until - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(work),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { result.timedOut = true; reject(new Error(`${label}: shutdown deadline exceeded`)); }, remaining); }),
        ]);
      } catch (error) {
        if (!(label === 'startup' && (error === this.startup.signal.reason || (error instanceof Error && error.name === 'AbortError')))) result.errors.push(error instanceof Error ? error.message.slice(0, 500) : `${label} failed`);
        return undefined;
      }
      finally { if (timer) clearTimeout(timer); }
    };
    this.stopping = (async () => {
      // A cancelled factory is still owned until it settles or the total deadline.
      if (this.starting) await bounded(() => this.starting!, 'startup');
      this.transport?.stopAdmission();
      if (this.runtime) {
        const drained = await bounded(() => this.runtime!.drain(Math.max(0, until - Date.now() - 100)), 'drain');
        if (drained) result.interrupted = drained.interrupted;
        await bounded(() => this.runtime!.shutdown(), 'shutdown');
      }
      if (this.transport) await bounded(() => this.transport!.close(Math.max(0, until - Date.now() - 10)), 'transport close');
      this.state = 'stopped';
      return result;
    })();
    return this.stopping;
  }
}

export interface Configuration { token: string; origins: string[]; version: string; generation: string; requestId: string; initialMaintenance?: boolean }
/** A control pipe is one generation. Configure is immutable; rotate has an ACK. */
export class ConfigurationGate {
  current: Configuration | null = null;
  private rotations = new Map<string, { token: string; graceMs: number }>();
  configure(next: Configuration): 'configured' | 'duplicate' {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(next.token) || next.origins.length > 16 || !next.version || next.version.length > 128 || !/^[A-Za-z0-9_-]{43}$/.test(next.generation) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(next.requestId)) throw new Error('Invalid runtime configuration');
    if (this.current) {
      if (JSON.stringify(next) !== JSON.stringify(this.current)) throw new Error('Runtime is already configured with different authority');
      return 'duplicate';
    }
    this.current = { ...next, origins: [...next.origins] };
    return 'configured';
  }
  rotate(request: { requestId: string; token: string; graceMs: number }, install: () => void): { type: 'ack'; op: 'rotate'; ok: true; id: string; generation: string } {
    if (!this.current) throw new Error('Configure must precede rotation');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request.requestId) || !/^[A-Za-z0-9_-]{32,256}$/.test(request.token) || !Number.isFinite(request.graceMs) || request.graceMs < 0 || request.graceMs > 300_000) throw new Error('Invalid rotation request');
    const previous = this.rotations.get(request.requestId);
    if (previous) {
      if (previous.token !== request.token || previous.graceMs !== request.graceMs) throw new Error('Rotation ID reused with different authority');
      return { type: 'ack', op: 'rotate', ok: true, id: request.requestId, generation: this.current.generation };
    }
    if (this.rotations.size >= 1024) throw new Error('Rotation receipt limit reached; restart runtime to establish a new generation');
    install();
    this.rotations.set(request.requestId, { token: request.token, graceMs: request.graceMs });
    return { type: 'ack', op: 'rotate', ok: true, id: request.requestId, generation: this.current.generation };
  }
}

/** The callback must fence ALL execution sources, not just HTTP requests. */
export class MaintenanceGate {
  private held = false;
  private checking = false;
  constructor(private readonly port: { fence(value: boolean): void; authoritativeIdle(): Promise<boolean> }) {}
  isHeld(): boolean { return this.held && !this.checking; }
  /** Trusted startup only, before any scheduler, client or session may run. */
  holdAtStartup(): void {
    if (this.held || this.checking) throw new Error('Maintenance is already held');
    this.port.fence(true); this.held = true;
  }
  async begin(): Promise<void> {
    if (this.checking) throw new Error('Maintenance admission check is in progress');
    if (this.held) return;
    this.port.fence(true); // synchronous and before the first await
    this.checking = true;
    try {
      if (!(await this.port.authoritativeIdle())) throw new Error('Runtime is busy; maintenance was not admitted');
      this.held = true;
    } catch (error) { this.port.fence(false); throw error; }
    finally { this.checking = false; }
  }
  end(): void { if (this.checking) throw new Error('Maintenance check is still in progress'); if (this.held) { this.held = false; this.port.fence(false); } }
}
