// Enki Runtime entry (supervised by the native app, or a remote daemon). The
// SDK loads only inside the owned factory, after its immutable environment.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, type Args } from './launch-args.ts';
import { reserveStdout, LineReader, parseSupervisorMessage } from './control/channel.ts';
import { ClientRelayBroker, SupervisorBroker } from './control/broker.ts';
import { Lifecycle, ConfigurationGate, type StopResult } from './lifecycle.ts';
import { DaemonMaintenance } from './daemon-maintenance.ts';
import { assertStartOwner, beginDaemon, CONTROL, daemonEnvironment, dataHash, privateRoot, ensureDaemon, stopDaemon, type ExpectedIdentity, type Identity } from './daemon-control.ts';
import { HttpError, startServer, withStatus, type Credentials, type Router } from './server/http.ts';
import { CONTRACT_VERSION, SCHEMA_VERSION, SDK_VERSION } from './protocol.ts';
import type { Runtime, RuntimeConfig } from './core/runtime.ts';
import { installSdkEnvironment } from './platform/environment.ts';
const REMOTE_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];
function runtimeVersion(): string {
  const value: unknown = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../runtime-version.json', import.meta.url)), 'utf8'));
  if (!value || typeof value !== 'object' || !('version' in value) || typeof value.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(value.version)) throw new Error('Packaged runtime version metadata is missing or invalid');
  return value.version;
}
function expected(args: Args): ExpectedIdentity { return { dataHash: dataHash(args.data), version: runtimeVersion(), contract: CONTRACT_VERSION, schema: SCHEMA_VERSION, sdk: SDK_VERSION }; }
function identity(runtime: Runtime, args: Args): Identity { return { ...expected(args), instance: runtime.instance }; }
function childEnvironment(): NodeJS.ProcessEnv {
  // Same policy as the native supervisor and the verified updater restart:
  // inherit unchanged except the four interpreter-injection keys. The SDK
  // bootstrap captures the original PI/ADC values before applying its profile
  // and restores them only for project tools (platform/environment.ts).
  return daemonEnvironment(process.env);
}
async function createRuntime(args: Args, config: Pick<RuntimeConfig, 'host' | 'broker' | 'credentials' | 'initialMaintenance'>, signal: AbortSignal): Promise<Runtime> {
  signal.throwIfAborted();
  args.data = privateRoot(args.data);
  installSdkEnvironment(fileURLToPath(new URL('../sdk-profile', import.meta.url)));
  const { Runtime: Factory } = await import('./core/runtime.ts');
  signal.throwIfAborted();
  return Factory.create({ dataDir: args.data, agentDir: args.agentDir, userPiAgentDir: args.userPiAgentDir, legacy: { opencodeDb: args.opencodeDb, piCliRoot: args.piCliRoot }, allowModelNetwork: true, version: runtimeVersion(), signal, ...config });
}
function earlySignals(stop: () => void): () => void {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, stop);
  return () => { for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.off(signal, stop); };
}
function addControl(router: Router, value: Identity, life: Lifecycle, stop: (deadline: number) => Promise<unknown>, maintenance?: DaemonMaintenance): void {
  router.add('GET', `${CONTROL}/health`, () => ({ identity: value, state: life.state, ...(maintenance?.snapshot() ? { maintenance: maintenance.snapshot() } : {}) }));
  router.add('POST', `${CONTROL}/shutdown`, (request) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || !('instance' in body) || body.instance !== value.instance || !('dataHash' in body) || body.dataHash !== value.dataHash || !('requestId' in body) || typeof body.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.requestId)) throw new HttpError(409, 'Runtime generation does not match; stop was not accepted');
    maintenance?.assertShutdown(body);
    request.response.once('finish', () => { void stop(30_000); });
    return withStatus(202, { accepted: true, instance: value.instance, requestId: body.requestId });
  });
  maintenance?.routes(router);
}
async function supervised(args: Args): Promise<void> {
  const writer = reserveStdout(), gate = new ConfigurationGate();
  const send = (message: Record<string, unknown>) => { const generation = gate.current?.generation; if (!generation) throw new Error('Configure must precede control output'); writer({ ...message, generation }); };
  const broker = new SupervisorBroker(send), credentials: Credentials = { current: null, previous: null };
  let runtime: Runtime | undefined;
  let configuredResolve!: () => void, configuredReject!: (error: Error) => void;
  const configured = new Promise<void>((resolve, reject) => { configuredResolve = resolve; configuredReject = reject; });
  const timer = setTimeout(() => configuredReject(new Error('Supervisor configuration deadline exceeded')), 15_000);
  const life: Lifecycle = new Lifecycle({
    create: async (signal) => { runtime = await createRuntime(args, { host: 'local', broker, credentials: 'vault', initialMaintenance: gate.current?.initialMaintenance }, signal); runtime.onActivity = (activity) => send({ type: 'activity', instance: runtime!.instance, ...activity }); return runtime; },
    listen: async () => {
      if (!runtime) throw new Error('Runtime is unavailable');
      const { buildRoutes } = await import('./server/routes.ts');
      const routes = buildRoutes(runtime, null); addControl(routes, identity(runtime, args), life, (deadline) => stop(deadline));
      return startServer(routes, { credentials, allowedOrigins: () => gate.current?.origins ?? [], maxBody: 64 * 1024 * 1024, accepting: () => life.state === 'ready' && runtime!.admission.open(), admit: () => runtime!.admitMutation(), controlPath: (p) => p.startsWith(CONTROL + '/') });
    },
    ready: (_runtime, transport) => send({ type: 'ready', requestId: gate.current!.requestId, port: transport.port, instance: runtime!.instance, contract: CONTRACT_VERSION, schema: SCHEMA_VERSION, sdk: SDK_VERSION, version: runtimeVersion(), dataHash: dataHash(args.data), activity: runtime!.activity() }),
  });
  let finishing: Promise<StopResult> | undefined;
  const stop = (deadline: number, requestId?: string): Promise<StopResult> => {
    clearTimeout(timer);
    if (!finishing) finishing = life.stop(deadline).then(async (result) => {
      if (gate.current) { if (requestId) send({ type: 'ack', op: 'shutdown', ok: result.errors.length === 0 && !result.timedOut, ...(result.errors.length || result.timedOut ? { error: 'SHUTDOWN_INCOMPLETE' } : {}), id: requestId, instance: runtime?.instance ?? null, ...result }); send({ type: 'drained', instance: runtime?.instance ?? null, ...result }); }
      broker.disconnect();
      try { await writer.flush(200); } catch (error) { result.errors.push(error instanceof Error ? error.message : 'Control flush failed'); }
      process.exit(result.errors.length || result.timedOut ? 1 : 0);
    });
    return finishing;
  };
  earlySignals(() => { void stop(5_000); }); // before configure or Runtime.create
  // Exact maintenance receipts. begin/end are deduplicated by requestId (the
  // stored outcome, never a second execution) and run strictly in arrival
  // order, so an `end` cannot overtake a begin still inside backupForUpdate and
  // a late begin cannot resurrect a fence. A completed end retires every held
  // begin. `status` is read-only; ordered after its target on this channel,
  // `unknown` proves the target never arrived.
  type MaintenanceReceipt = { mode: 'begin' | 'end'; state: 'pending' | 'held' | 'ended' | 'failed' | 'done'; result: Promise<Record<string, unknown>> };
  const maintenanceReceipts = new Map<string, MaintenanceReceipt>();
  let maintenanceOrder: Promise<unknown> = Promise.resolve();
  const reader = new LineReader((line) => {
    const message = parseSupervisorMessage(line); if (!message) return;
    try {
      if (message.type === 'configure') {
        gate.configure(message); credentials.current ??= message.token; clearTimeout(timer); configuredResolve(); return;
      }
      if (message.generation !== gate.current?.generation) return;
      if (message.type === 'response') { broker.pending.settle(message.id, message.ok ? { ok: true, value: message.value } : { ok: false, error: message.error }); return; }
      if (message.type === 'shutdown') { void stop(message.mode === 'now' ? 0 : message.deadlineMs ?? 60_000, message.requestId); return; }
      if (message.type === 'rotate') {
        const ack = gate.rotate({ ...message, graceMs: message.graceMs ?? 60_000 }, () => { if (credentials.current) credentials.previous = { token: credentials.current, until: Date.now() + (message.graceMs ?? 60_000) }; credentials.current = message.token; });
        send({ ...ack, instance: runtime?.instance ?? null }); return;
      }
      if (message.type === 'maintenance') {
        const ack = { type: 'ack', op: 'maintenance', id: message.requestId, instance: runtime?.instance ?? null };
        if (message.mode === 'status') {
          const target = maintenanceReceipts.get(message.target);
          send({ ...ack, ok: true, target: message.target, mode: target?.mode ?? null, state: target?.state ?? 'unknown' }); return;
        }
        const existing = maintenanceReceipts.get(message.requestId);
        if (existing && existing.mode !== message.mode) throw new Error('Maintenance request ID reused with another operation');
        if (existing) {
          // Same id: stored outcome only. A begin retired by a later end is no longer a held fence.
          void existing.result.then((result) => send(existing.mode === 'begin' && existing.state === 'ended' ? { ...result, ok: false, error: 'MAINTENANCE_ENDED' } : result)); return;
        }
        if (maintenanceReceipts.size >= 1024) throw new Error('Maintenance receipt limit reached');
        const mode = message.mode, requestId = message.requestId;
        const receipt: MaintenanceReceipt = { mode, state: 'pending', result: Promise.resolve({}) };
        receipt.result = maintenanceOrder.then(async (): Promise<Record<string, unknown>> => {
          if (!runtime || life.state !== 'ready') { receipt.state = 'failed'; return { ...ack, ok: false, error: 'RUNTIME_NOT_READY' }; }
          try {
            if (mode === 'begin') {
              await runtime.beginMaintenance();
              try { const backup = await runtime.backupForUpdate(requestId); receipt.state = 'held'; return { ...ack, ok: true, backup }; }
              catch (error) { runtime.endMaintenance(); throw error; }
            }
            runtime.endMaintenance();
            for (const other of maintenanceReceipts.values()) if (other.mode === 'begin' && other.state === 'held') other.state = 'ended';
            receipt.state = 'done'; return { ...ack, ok: true };
          } catch { receipt.state = 'failed'; return { ...ack, ok: false, error: 'RUNTIME_BUSY' }; }
        });
        maintenanceOrder = receipt.result.catch(() => undefined);
        maintenanceReceipts.set(requestId, receipt);
        void receipt.result.then(send); return;
      }
    } catch { if (gate.current) send({ type: 'control.error', requestId: 'requestId' in message ? message.requestId : undefined, instance: runtime?.instance ?? null, code: 'INVALID_CONTROL_TRANSITION', message: 'Команда управления не принята. Проверьте состояние среды выполнения.' }); }
  }, () => { void stop(0); });
  process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk: string) => reader.push(chunk)); process.stdin.once('end', () => { broker.disconnect(); void stop(10_000); }); process.stdin.once('error', () => { broker.disconnect(); void stop(5_000); });
  try { await configured; await life.start(); }
  catch { configuredReject(new Error('Runtime startup failed')); if (gate.current) send({ type: 'startup.error', code: 'RUNTIME_STARTUP_FAILED', message: 'Не удалось запустить среду выполнения Enki. Проверьте установленный пакет и повторите подключение.' }); await stop(5_000); }
}
async function daemon(args: Args): Promise<void> {
  let runtime: Runtime | undefined;
  let ownership: ReturnType<typeof beginDaemon> | undefined;
  let relayReady = false;
  const relay = new ClientRelayBroker((request) => { if (!runtime || !relayReady) throw new Error('Runtime journal is not ready for broker publication'); runtime.journal.append(null, null, { type: 'broker.request', properties: { ...request } }, true); });
  const credentials: Credentials = { current: null, previous: null };
  const life: Lifecycle = new Lifecycle({
    create: async (signal) => { if (args.startOwner) assertStartOwner(args.data, args.startOwner); ownership = beginDaemon(args.data); credentials.current = ownership.token; runtime = await createRuntime(args, { host: 'remote', broker: relay, credentials: 'agent-dir', initialMaintenance: !!args.startOwner }, signal); relayReady = true; return runtime; },
    listen: async () => {
      if (!runtime) throw new Error('Runtime is unavailable');
      const { buildRoutes } = await import('./server/routes.ts'); const routes = buildRoutes(runtime, relay);
      addControl(routes, identity(runtime, args), life, (deadline) => stop(deadline), new DaemonMaintenance(args.data, identity(runtime, args), runtime, args.startOwner));
      return startServer(routes, { credentials, allowedOrigins: () => REMOTE_ORIGINS, maxBody: 64 * 1024 * 1024, anyLoopbackPort: true, accepting: () => life.state === 'ready' && runtime!.admission.open(), admit: () => runtime!.admitMutation(), controlPath: (p) => p.startsWith(CONTROL + '/') }, args.port ?? 0);
    },
    ready: (_runtime, transport) => ownership!.publish(transport.port, identity(runtime!, args)),
  });
  let finishing: Promise<StopResult> | undefined;
  const stop = (deadline: number): Promise<StopResult> => finishing ??= life.stop(deadline).then((result) => { relayReady = false; ownership?.close(result); process.exit(result.errors.length || result.timedOut ? 1 : 0); });
  earlySignals(() => { void stop(5_000); }); // before lifetime lease or factory
  try { await life.start(); }
  catch { process.send?.({ type: 'startup-error', code: 'RUNTIME_STARTUP_FAILED', message: 'Enki Runtime startup failed; the installed package could not establish readiness.' }); await stop(5_000); }
}
const args = parseArgs(process.argv.slice(2));
const run = args.mode === 'supervised' ? supervised : args.mode === 'daemon' ? daemon : async (input: Args) => {
  if (input.mode === 'stop') await stopDaemon(input.data, expected(input));
  else process.stdout.write(JSON.stringify(await ensureDaemon(input, expected(input), { executable: process.execPath, entry: fileURLToPath(import.meta.url), env: childEnvironment() })) + '\n');
};
run(args).catch(() => { process.send?.({ type: 'startup-error', code: 'RUNTIME_STARTUP_FAILED', message: 'Enki Runtime startup failed.' }); process.stderr.write('Enki Runtime: RUNTIME_STARTUP_FAILED. Readiness was not established; no command was replayed.\n'); process.exit(1); });
