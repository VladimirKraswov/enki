// Private daemon control. No persisted PID is ever a process authority.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { StopResult } from './lifecycle.ts';
import type { UpdateBackup } from './core/runtime.ts';
// The trusted installer takes the LIVE data layout and the paired session
// snapshot verifier/restorer only from this verified, SDK-free bundle: the same
// source the runtime itself uses (platform/paths.ts, platform/update-snapshot.ts).
export { DATA_LAYOUT } from './platform/paths.ts';
export { restoreSessionSnapshot, validSnapshot, verifySessionSnapshot } from './platform/update-snapshot.ts';
export const CONTROL = '/_enki/runtime';
/** Interpreter-injection keys the native local supervisor also removes (src-tauri/src/runtime.rs). */
export const NODE_INJECTION_KEYS: readonly string[] = Object.freeze(['NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE', 'NODE_EXTRA_CA_CERTS_OVERRIDE']);
/**
 * Environment of a detached daemon, identical for the fresh `ensure` launch and
 * the verified updater restart (it imports this bundle). Same semantics as the
 * native local supervisor: the ambient environment is inherited unchanged
 * (HOME, USERPROFILE, SSH_AUTH_SOCK, proxies, custom project variables reach
 * project tools) and only the four injection keys are removed. Built in memory
 * for one spawn; never persisted or logged.
 */
export function daemonEnvironment(source: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  // Windows variable names are case-insensitive: `Node_Options` is NODE_OPTIONS.
  const fold = (key: string) => platform === 'win32' ? key.toUpperCase() : key;
  const blocked = new Set(NODE_INJECTION_KEYS.map(fold));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && !blocked.has(fold(key))) env[key] = value;
  return env;
}
export interface ExpectedIdentity { dataHash: string; version: string; contract: number; schema: number; sdk: string }
export interface Identity extends ExpectedIdentity { instance: string }
export interface DaemonState { schema: 1; port: number; identity: Identity }
export interface StartLease { readonly data: string; readonly nonce: string; release(): void }
export interface HeldMaintenanceReceipt { ok: true; op: 'maintenance'; id: string; identity: Identity; lease: string; initial?: true }
export interface MaintenanceReceipt extends HeldMaintenanceReceipt { backup: UpdateBackup }
/** Typed, prompt startup failure: the child handle spawned by THIS ensure call
 * exited before authenticated readiness. Carries only its exit code/signal and
 * a bounded child-reported reason; no argv, environment or PID authority. */
export class DaemonStartupError extends Error {
  readonly code = 'ENKI_DAEMON_STARTUP_EXITED';
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  constructor(exitCode: number | null, signal: NodeJS.Signals | null, detail?: string) {
    const status = exitCode !== null ? `exit code ${exitCode}` : signal !== null ? `signal ${signal}` : 'reported a startup error; its own child is terminated';
    super(`Enki Runtime failed before readiness (${status})${detail ? `: ${detail.slice(0, 500)}` : ''}`);
    this.name = 'DaemonStartupError'; this.exitCode = exitCode; this.signal = signal;
  }
}
const ownedStartLeases = new WeakSet<StartLease>();
const tokenPattern = /^[A-Za-z0-9_-]{32,256}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function physical(full: string, file = false): void {
  let at = path.parse(full).root;
  const parts = full.slice(at.length).split(path.sep).filter(Boolean);
  parts.forEach((part, index) => {
    at = path.join(at, part);
    const stat = fs.lstatSync(at);
    if (stat.isSymbolicLink() || (index === parts.length - 1 && file ? !stat.isFile() : !stat.isDirectory())) throw new Error('Daemon path contains a link or unexpected object');
  });
}
export function privateRoot(input: string): string {
  if (!path.isAbsolute(input)) throw new Error('Daemon data root must be absolute');
  const root = path.resolve(input);
  if (root === path.parse(root).root || root === path.resolve(os.homedir())) throw new Error('Daemon requires a dedicated private data directory, not a filesystem root or home');
  let at = path.parse(root).root;
  for (const part of root.slice(at.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    try { fs.lstatSync(at); } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; fs.mkdirSync(at, { mode: 0o700 }); }
    physical(at);
  }
  const canonical = fs.realpathSync.native(root);
  physical(canonical);
  if (canonical === path.parse(canonical).root || canonical === path.resolve(os.homedir())) throw new Error('Daemon requires a dedicated private data directory');
  fs.chmodSync(canonical, 0o700);
  return canonical;
}
export const dataHash = (data: string) => createHash('sha256').update(privateRoot(data)).digest('hex');
function exists(file: string): boolean { try { fs.lstatSync(file); return true; } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; } }
function readPrivate(root: string, name: string): string {
  const full = path.join(root, name); physical(full, true);
  const stat = fs.statSync(full);
  if (stat.size > 64 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Daemon metadata is too large or not private');
  const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { return fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
}
function syncDirectory(root: string): void {
  let fd: number | undefined;
  try { fd = fs.openSync(root, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); fs.fsyncSync(fd); }
  catch (cause) { throw new Error('Private daemon metadata requires supported directory synchronization; platform not qualified', { cause }); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function writePrivate(root: string, name: string, value: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Invalid daemon metadata name');
  physical(root);
  const target = path.join(root, name); if (exists(target)) physical(target, true);
  const temporary = path.join(root, `.pending-${randomUUID()}`);
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, target); syncDirectory(root);
}
/** A permanent, dedicated SQLite inode: process death releases the OS lease. */
export function acquireLease(root: string, kind: 'start' | 'lifetime'): () => void {
  const file = path.join(root, `daemon-${kind}.sqlite`);
  for (const suffix of ['', '-journal', '-wal', '-shm']) if (exists(file + suffix)) physical(file + suffix, true);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
    db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE');
  } catch (cause) { db?.close(); const busy = cause instanceof Error && /locked|busy/i.test(cause.message); const error = new Error(busy ? 'Daemon lifecycle lease is already held' : 'Daemon lifecycle lease cannot be opened', { cause }); Object.assign(error, { code: busy ? 'ENKI_DAEMON_BUSY' : 'ENKI_DAEMON_LEASE_INVALID' }); throw error; }
  let closed = false;
  return () => { if (closed) return; closed = true; try { db!.exec('ROLLBACK'); } finally { db!.close(); } };
}
/** The trusted updater holds this across fence, stop, promotion and restart. */
export function acquireStartLease(data: string): StartLease {
  const root = privateRoot(data), release = acquireLease(root, 'start'), nonce = randomBytes(32).toString('base64url');
  let closed = false;
  try { writePrivate(root, 'daemon-start-owner.json', JSON.stringify({ nonce })); }
  catch (error) { release(); throw error; }
  const lease: StartLease = { data: root, nonce, release() {
    if (closed) return; closed = true; ownedStartLeases.delete(lease);
    try {
      const current: unknown = JSON.parse(readPrivate(root, 'daemon-start-owner.json'));
      if (record(current) && current.nonce === nonce) { fs.unlinkSync(path.join(root, 'daemon-start-owner.json')); syncDirectory(root); }
    } finally { release(); }
  } };
  ownedStartLeases.add(lease); return lease;
}
export function assertStartOwner(data: string, nonce: unknown): void {
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error('Owned update lifecycle lease is required');
  const root = privateRoot(data), current: unknown = JSON.parse(readPrivate(root, 'daemon-start-owner.json'));
  if (!record(current) || current.nonce !== nonce) throw new Error('Update lifecycle lease owner does not match');
  let release: (() => void) | undefined;
  try { release = acquireLease(root, 'start'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENKI_DAEMON_BUSY') return; throw error; }
  release(); throw new Error('Update lifecycle OS lease has already been released');
}
function assertHeldStart(data: string, lease: StartLease): void {
  if (!ownedStartLeases.has(lease) || lease.data !== privateRoot(data)) throw new Error('Caller does not own this daemon lifecycle lease');
  assertStartOwner(data, lease.nonce);
}
function identityMatches(actual: unknown, expected: ExpectedIdentity, instance?: string): actual is Identity {
  return record(actual) && typeof actual.instance === 'string' && uuid.test(actual.instance) && (!instance || actual.instance === instance)
    && actual.dataHash === expected.dataHash && actual.version === expected.version && actual.contract === expected.contract && actual.schema === expected.schema && actual.sdk === expected.sdk;
}
export function readState(root: string): DaemonState | null {
  if (!exists(path.join(root, 'daemon.json'))) return null;
  const data: unknown = JSON.parse(readPrivate(root, 'daemon.json'));
  if (!record(data) || data.schema !== 1 || !Number.isInteger(data.port) || Number(data.port) < 1 || Number(data.port) > 65535 || !record(data.identity)) throw new Error('Invalid private daemon metadata; no process will be signalled');
  const i = data.identity;
  if (typeof i.instance !== 'string' || !uuid.test(i.instance) || typeof i.dataHash !== 'string' || !/^[a-f0-9]{64}$/.test(i.dataHash) || typeof i.version !== 'string' || !i.version || i.version.length > 128 || typeof i.sdk !== 'string' || !Number.isSafeInteger(i.contract) || !Number.isSafeInteger(i.schema)) throw new Error('Invalid daemon identity');
  return { schema: 1, port: Number(data.port), identity: { instance: i.instance, dataHash: i.dataHash, version: i.version, sdk: i.sdk, contract: Number(i.contract), schema: Number(i.schema) } };
}
function readToken(root: string): string { const token = readPrivate(root, 'daemon.token').trim(); if (!tokenPattern.test(token)) throw new Error('Invalid private daemon credential'); return token; }
/** Only the lifetime lease winner may write token/state. Ensure never does. */
export function beginDaemon(input: string): { token: string; publish(port: number, identity: Identity): void; close(result?: StopResult): void } {
  const root = privateRoot(input), release = acquireLease(root, 'lifetime');
  let published: Identity | undefined; let closed = false;
  try {
    const old = path.join(root, 'daemon.json');
    if (exists(old)) {
      // A legacy daemon does not hold this new lifetime lease. Never rewrite
      // its token merely because this lease is free; a PID cannot prove it dead.
      readState(root); // validates the recognized protocol, before any mutation
      physical(old, true); fs.unlinkSync(old); syncDirectory(root);
    }
    const token = randomBytes(32).toString('base64url'); writePrivate(root, 'daemon.token', token);
    return { token,
      publish(port, identity) {
        if (closed || !Number.isInteger(port) || port < 1 || port > 65535 || !uuid.test(identity.instance) || identity.dataHash !== dataHash(root)) throw new Error('Invalid daemon publication');
        published = identity; writePrivate(root, 'daemon.json', JSON.stringify({ schema: 1, port, identity }));
      },
      close(result) {
        if (closed) return; closed = true;
        try { const current = readState(root); if (published && current?.identity.instance === published.instance) { if (result) writePrivate(root, 'daemon-stopped.json', JSON.stringify({ identity: published, result })); fs.unlinkSync(path.join(root, 'daemon.json')); syncDirectory(root); } }
        finally { release(); }
      },
    };
  } catch (error) { release(); throw error; }
}
export function requestJson(port: number, token: string, pathname: string, body?: unknown, timeoutMs = 2_000): Promise<unknown> {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !tokenPattern.test(token) || (!['health','shutdown','maintenance'].some(name => pathname === `${CONTROL}/${name}`) && !new RegExp(`^${CONTROL}/maintenance/[a-f0-9-]{36}$`).test(pathname))) return Promise.reject(new Error('Invalid exact daemon control target'));
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = http.request({ hostname: '127.0.0.1', port, path: pathname, method: payload ? 'POST' : 'GET', agent: false,
      headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } }, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024) response.destroy(new Error('Daemon control response too large')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => { if (response.statusCode !== 200 && response.statusCode !== 202) { reject(new Error(`Daemon control HTTP ${response.statusCode}`)); return; } try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid daemon control response')); } });
    });
    const timer = setTimeout(() => request.destroy(new Error('Daemon control timeout')), timeoutMs);
    request.on('error', reject); request.once('close', () => clearTimeout(timer)); request.end(payload);
  });
}
async function healthy(root: string, expected: ExpectedIdentity): Promise<{ state: DaemonState; token: string } | null> {
  let state: DaemonState | null;
  try { state = readState(root); } catch { return null; }
  if (!state || !identityMatches(state.identity, expected)) return null;
  // A stale state file is not authority to send its bearer to a recycled port.
  let release: (() => void) | undefined;
  try { release = acquireLease(root, 'lifetime'); }
  catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENKI_DAEMON_BUSY') throw error; }
  if (release) { release(); return null; }
  try {
    const token = readToken(root), health = await requestJson(state.port, token, `${CONTROL}/health`);
    if (!record(health) || health.state !== 'ready' || !identityMatches(health.identity, expected, state.identity.instance)) return null;
    return { state, token };
  } catch { return null; }
}
/** Authenticated, lifetime-owned read only. Never spawns or rotates authority. */
export function probeDaemon(data: string, expected: ExpectedIdentity): Promise<{ state: DaemonState; token: string } | null> {
  return healthy(privateRoot(data), expected);
}
/** `userPiAgentDir` absent = no owner Pi profile may be imported (explicit profiles). */
export interface LaunchConfig { data: string; agentDir?: string; port?: number; opencodeDb?: string; piCliRoot?: string; userPiAgentDir?: string; startOwner?: string }
export function daemonArguments(entry: string, input: LaunchConfig): string[] {
  return [entry, '--mode', 'daemon', '--data', input.data, ...(input.userPiAgentDir ? ['--user-pi-agent-dir', input.userPiAgentDir] : []),
    ...(input.agentDir ? ['--agent-dir', input.agentDir] : []), ...(input.port ? ['--port', String(input.port)] : []),
    ...(input.opencodeDb ? ['--opencode-db', input.opencodeDb] : []), ...(input.piCliRoot ? ['--pi-cli-root', input.piCliRoot] : []), ...(input.startOwner ? ['--start-owner', input.startOwner] : [])];
}
export async function ensureDaemon(config: LaunchConfig, expected: ExpectedIdentity, launch: { executable: string; entry: string; env: NodeJS.ProcessEnv }, timeoutMs = 20_000, startLease?: StartLease): Promise<{ port: number; token: string; instance: string; contract: number; maintenance?: HeldMaintenanceReceipt }> {
  const root = privateRoot(config.data), until = Date.now() + timeoutMs;
  if (expected.dataHash !== dataHash(root) || !path.isAbsolute(launch.executable) || !path.isAbsolute(launch.entry) || ![config.userPiAgentDir, config.agentDir, config.opencodeDb, config.piCliRoot].filter((p) => p !== undefined).every((p) => path.isAbsolute(p!))) throw new Error('Daemon startup requires explicit absolute owned paths and matching data identity');
  if (config.startOwner && (!startLease || startLease.nonce !== config.startOwner)) throw new Error('Fenced startup requires its caller-owned lifecycle lease');
  let release: (() => void) | undefined;
  if (startLease) { assertHeldStart(root, startLease); release = () => {}; }
  while (!release) { try { const lease = acquireStartLease(root); release = () => lease.release(); } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENKI_DAEMON_BUSY' || Date.now() >= until) throw error; await wait(25); } }
  let child: ReturnType<typeof spawn> | undefined;
  // Mutated by child callbacks; an annotated holder keeps strict flow typing honest.
  const own: { exited: boolean; spawnError?: Error; reason?: string; code?: number | null; signal?: NodeJS.Signals | null } = { exited: false };
  try {
    let found = await healthy(root, expected);
    if (!found) {
      child = spawn(launch.executable, daemonArguments(launch.entry, config), { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, env: launch.env });
      child.once('error', (error) => { own.spawnError = error; });
      child.once('exit', (code, signal) => { own.exited = true; own.code = code; own.signal = signal; });
      child.on('message', (value: unknown) => { if (record(value) && value.type === 'startup-error' && typeof value.message === 'string') own.reason = value.message.slice(0, 500); });
      while (!(found = await healthy(root, expected))) {
        if (own.spawnError) throw own.spawnError;
        // Our own child handle reported a startup error or its exit: readiness
        // can no longer arrive from it. Fail promptly with its safe status,
        // briefly settling the other signal; never consult daemon.json PIDs.
        if (own.reason !== undefined || own.exited) {
          const settle = Date.now() + 1_000;
          while (!own.exited && Date.now() < settle) await wait(20);
          if (own.reason === undefined) await wait(100); // 'exit' may precede the final IPC reason
          throw new DaemonStartupError(own.code ?? null, own.signal ?? null, own.reason);
        }
        if (Date.now() >= until) throw new Error('Enki Runtime did not establish authenticated matching readiness; startup outcome is uncertain');
        await wait(50);
      }
    }
    if (child?.connected) child.disconnect(); child?.unref();
    let maintenance: HeldMaintenanceReceipt | undefined;
    if (config.startOwner) {
      const health = await requestJson(found.state.port, found.token, `${CONTROL}/health`);
      if (!record(health) || !validHeldMaintenance(health.maintenance, expected, found.state.identity.instance) || health.maintenance.initial !== true)
        throw new Error('Candidate daemon did not confirm its initial maintenance fence');
      maintenance = health.maintenance;
    }
    return { port: found.state.port, token: found.token, instance: found.state.identity.instance, contract: expected.contract, ...(maintenance ? { maintenance } : {}) };
  } catch (error) {
    // Only a child handle created by THIS invocation may be terminated.
    if (child && !own.exited) { child.kill('SIGTERM'); const end = Date.now() + 1_000; while (!own.exited && Date.now() < end) await wait(20); if (!own.exited) child.kill('SIGKILL'); }
    if (child?.connected) child.disconnect(); child?.unref();
    throw error;
  } finally { release(); }
}
export async function stopDaemon(data: string, expected: ExpectedIdentity, options: { startLease?: StartLease; maintenanceLease?: string } = {}): Promise<void> {
  const lease = options.startLease ?? acquireStartLease(data);
  assertHeldStart(data, lease);
  try { await stopDaemonHeld(data, expected, lease, options.maintenanceLease); }
  finally { if (!options.startLease) lease.release(); }
}
async function stopDaemonHeld(data: string, expected: ExpectedIdentity, lease: StartLease, maintenanceLease?: string): Promise<void> {
  const root = privateRoot(data), found = await healthy(root, expected);
  if (!found) throw new Error('No authenticated matching daemon is ready; no process was signalled');
  // One POST only. A lost response is not authorization to replay it.
  let acknowledged = false;
  try {
    const result = await requestJson(found.state.port, found.token, `${CONTROL}/shutdown`, { instance: found.state.identity.instance, dataHash: expected.dataHash, requestId: randomUUID(), startOwner: lease.nonce, ...(maintenanceLease ? { lease: maintenanceLease } : {}) });
    acknowledged = record(result) && result.instance === found.state.identity.instance && result.accepted === true;
  } catch { /* Reconcile readonly below; never repeat the stop POST. */ }
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    let released: (() => void) | undefined;
    try { released = acquireLease(root, 'lifetime'); } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENKI_DAEMON_BUSY') throw error; }
    if (released) {
      try {
        const receipt: unknown = JSON.parse(readPrivate(root, 'daemon-stopped.json'));
        if (!record(receipt) || !identityMatches(receipt.identity, expected, found.state.identity.instance) || !record(receipt.result) || receipt.result.timedOut !== false || !Array.isArray(receipt.result.errors) || receipt.result.errors.length) throw new Error('Daemon ended without a successful matching shutdown receipt; outcome is uncertain');
        return;
      } finally { released(); }
    }
    const state = readState(root);
    if (state && state.identity.instance !== found.state.identity.instance) throw new Error('Daemon generation changed during stop; outcome is uncertain');
    // The server may already have closed its socket. Reconcile only the OS
    // lifetime lease and private matching completion receipt; never dial a
    // stale port that the operating system could now reuse for another owner.
    await wait(50);
  }
  throw new Error(`Daemon stop outcome is uncertain (${acknowledged ? 'accepted' : 'ACK unavailable'}); no OS signal was sent and the request was not replayed`);
}
function validHeldMaintenance(value: unknown, expected: ExpectedIdentity, instance: string): value is HeldMaintenanceReceipt {
  return record(value) && value.ok === true && value.op === 'maintenance' && typeof value.id === 'string' && uuid.test(value.id)
    && identityMatches(value.identity, expected, instance) && typeof value.lease === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.lease);
}
function validMaintenance(value: unknown, expected: ExpectedIdentity, instance: string, id: string): value is MaintenanceReceipt {
  if (!validHeldMaintenance(value, expected, instance) || value.id !== id || !('backup' in value) || !record(value.backup)) return false;
  const b = value.backup;
  return b.id === id && b.relativePath === `update-backups/${id}/state.sqlite` && typeof b.sha256 === 'string' && /^[a-f0-9]{64}$/.test(b.sha256)
    && Number.isSafeInteger(b.bytes) && Number(b.bytes) > 0 && b.schema === expected.schema && b.sdk === expected.sdk && b.runtimeVersion === expected.version && Number.isSafeInteger(b.createdAt);
}
export async function beginDaemonMaintenance(data: string, expected: ExpectedIdentity, startLease: StartLease, requestId = randomUUID()): Promise<MaintenanceReceipt> {
  assertHeldStart(data, startLease);
  const root = privateRoot(data), found = await healthy(root, expected);
  if (!found) throw new Error('No authenticated matching daemon is ready for maintenance');
  let response: unknown;
  try { response = await requestJson(found.state.port, found.token, `${CONTROL}/maintenance`, { instance: found.state.identity.instance, dataHash: expected.dataHash, requestId, mode: 'begin', startOwner: startLease.nonce }, 30_000); }
  catch {
    // One mutation only. Recover its receipt with bounded, authenticated reads.
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      assertHeldStart(root, startLease);
      const current = readState(root);
      if (!current || !identityMatches(current.identity, expected, found.state.identity.instance)) throw new Error('Daemon maintenance outcome is uncertain; generation changed');
      let released: (() => void) | undefined;
      try { released = acquireLease(root, 'lifetime'); }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENKI_DAEMON_BUSY') throw error; }
      if (released) { released(); throw new Error('Daemon ended before its maintenance receipt was confirmed; do not replay its request'); }
      try { response = await requestJson(current.port, found.token, `${CONTROL}/maintenance/${requestId}`); } catch { throw new Error('Daemon maintenance ACK is unavailable; do not replay its request'); }
      if (!record(response) || response.state !== 'pending') break;
      await wait(50);
    }
  }
  if (!validMaintenance(response, expected, found.state.identity.instance, requestId)) throw new Error('Daemon did not provide a matching durable backup/maintenance receipt');
  return response;
}
export async function endDaemonMaintenance(data: string, expected: ExpectedIdentity, startLease: StartLease, receipt: HeldMaintenanceReceipt, requestId = randomUUID()): Promise<void> {
  assertHeldStart(data, startLease);
  if (!validHeldMaintenance(receipt, expected, receipt.identity.instance)) throw new Error('Invalid held daemon maintenance receipt');
  const found = await healthy(privateRoot(data), expected);
  if (!found || found.state.identity.instance !== receipt.identity.instance) throw new Error('Maintenance belongs to another daemon instance');
  const response = await requestJson(found.state.port, found.token, `${CONTROL}/maintenance`, { instance: receipt.identity.instance, dataHash: expected.dataHash, requestId, mode: 'end', startOwner: startLease.nonce, lease: receipt.lease });
  if (!record(response) || response.ok !== true || response.id !== requestId || !identityMatches(response.identity, expected, receipt.identity.instance)) throw new Error('Maintenance release was not confirmed');
}
