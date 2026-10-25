import './artifact-test-port.mjs';
// Shared fixture for installer tests (not a test file itself). The daemon
// LIFECYCLE is an explicit in-memory port (globalThis.__enkiFakeDaemon; no Node
// runtime, SDK or candidate entry runs), but every DATA path is the actual
// production code: platform/paths.ts (runtimePaths + DATA_LAYOUT), store/db.ts
// (the real runtime schema in runtime.sqlite) and platform/update-snapshot.ts
// (paired JSONL snapshot). The control module is authenticated like any file.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MANIFEST, buildManifest, sha256File } from './artifact.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = name => pathToFileURL(path.join(REPO, 'src-tauri/resources/agent/src', name)).href;

export const CONTROL = `import fs from 'node:fs'; import path from 'node:path'; import { createHash, randomUUID } from 'node:crypto'; import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { runtimePaths } from '${source('platform/paths.ts')}';
import { Database } from '${source('store/db.ts')}';
import { snapshotSessions } from '${source('platform/update-snapshot.ts')}';
export { DATA_LAYOUT } from '${source('platform/paths.ts')}';
export { restoreSessionSnapshot, validSnapshot, verifySessionSnapshot } from '${source('platform/update-snapshot.ts')}';
const f = () => globalThis.__enkiFakeDaemon;
export const privateRoot = p => { fs.mkdirSync(p, { recursive: true, mode: 0o700 }); return fs.realpathSync(p); };
export const dataHash = d => createHash('sha256').update(privateRoot(d)).digest('hex');
export function acquireLease(root, kind) { if (kind === 'lifetime' && f().running) throw Object.assign(new Error('busy'), { code: 'ENKI_DAEMON_BUSY' }); return () => {}; }
export function acquireStartLease(data) { return { data, nonce: 'N'.repeat(43), release() {} }; }
export async function probeDaemon(data, e) { const r = f().running; return r && r.version === e.version ? { state: { port: 1, identity: { ...r } }, token: 't'.repeat(43) } : null; }
export async function requestJson(port, token, pathname) {
  f().log.push(['GET', pathname]);
  if (pathname.endsWith('/health')) return { state: 'ready', identity: f().running, ...(f().held ? { maintenance: f().held } : {}) };
  const value = f().receipts[pathname.split('/').pop()]; if (!value) throw new Error('Daemon control HTTP 404'); return value;
}
// The actual runtime database location and schema, created like the runtime does.
function database(data) { const file = runtimePaths(data).db; if (!fs.existsSync(file)) new Database(file).close(); return file; }
export async function beginDaemonMaintenance(data, e, lease, id) {
  f().log.push(['begin', id]); const dir = path.join(data, 'update-backups', id); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'state.sqlite'), live = new DatabaseSync(database(data)); try { await sqliteBackup(live, file); } finally { live.close(); }
  const sessions = f().dbOnlyBackup ? undefined : snapshotSessions(data, id);
  const backup = { id, relativePath: 'update-backups/' + id + '/state.sqlite', sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), bytes: fs.statSync(file).size, schema: e.schema, runtimeVersion: e.version, sdk: e.sdk, createdAt: 1, ...(sessions ? { sessions } : {}) };
  const onDisk = f().receiptOnDisk ? f().receiptOnDisk(backup) : backup; fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(onDisk));
  const receipt = { ok: true, op: 'maintenance', id, identity: f().running, lease: 'L'.repeat(43), backup }; f().held = receipt; f().receipts[id] = receipt;
  if (f().loseBeginAck) { f().loseBeginAck = false; throw new Error('Daemon maintenance ACK is unavailable; do not replay its request'); }
  return receipt;
}
export async function endDaemonMaintenance(data, e, lease, receipt) {
  f().log.push(['end', receipt.id]); if (f().failEnd) { f().failEnd = false; f().running = null; f().held = null; throw new Error('daemon died'); }
  if (!f().held || f().held.id !== receipt.id) throw new Error('Maintenance belongs to another daemon instance'); f().held = null;
}
export async function stopDaemon(data, e) { f().log.push(['stop', e.version]); f().running = null; f().held = null; }
export async function ensureDaemon(config, e) {
  f().log.push(['launch', e.version]); database(config.data);
  const hook = f().onLaunch; f().onLaunch = null; if (hook) hook(config.data, e);
  if (f().dieAfterData) { f().dieAfterData = false; throw new Error('Enki Runtime exited before readiness'); }
  f().running = { ...e, instance: randomUUID() }; f().held = { ok: true, op: 'maintenance', id: randomUUID(), identity: f().running, lease: 'I'.repeat(43), initial: true };
  return { port: 1, token: 't'.repeat(43), instance: f().running.instance, contract: e.contract, maintenance: f().held };
}
`;

/** The data schema the actual store/db.ts applies (CONTROL creates the real
 * Database), read from its single authority protocol.ts. Artifact metadata must
 * advertise it, or the installer's fail-closed paired-backup check correctly
 * refuses every backup; a cross-schema fixture passes `dataSchema` explicitly. */
export const CURRENT_SCHEMA = (() => {
  const match = /export const SCHEMA_VERSION = ([1-9]\d*);/.exec(fs.readFileSync(path.join(REPO, 'src-tauri/resources/agent/src/protocol.ts'), 'utf8'));
  if (!match) throw new Error('protocol.ts SCHEMA_VERSION literal not found');
  return Number(match[1]);
})();

/** A complete authenticated artifact; `node` and `main.js` are never executed. */
export function artifact(root, hex, { sdk = '0.85.1', dataSchema = CURRENT_SCHEMA, control = CONTROL } = {}) {
  const dir = path.join(root, `candidate-${hex}`);
  fs.mkdirSync(path.join(dir, 'node/bin'), { recursive: true }); fs.mkdirSync(path.join(dir, 'app/dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node/bin/node'), 'NEVER_EXECUTED'); fs.writeFileSync(path.join(dir, 'app/dist/main.js'), "throw Error('NEVER_EXECUTED')");
  fs.writeFileSync(path.join(dir, 'app/dist/daemon-control.js'), control);
  fs.writeFileSync(path.join(dir, 'app/package-lock.json'), '{}'); fs.writeFileSync(path.join(dir, 'app/runtime-lock.json'), '{}');
  fs.writeFileSync(path.join(dir, 'app/runtime-version.json'), JSON.stringify({ version: hex, sdk, node: '24.22.1', dataSchema, contract: 1 }));
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(buildManifest(dir, { version: `${sdk}-${hex}`, contract: 1, node: 'node/bin/node', entry: 'app/dist/main.js' })));
  return { candidate: dir, expectedManifestSha256: sha256File(path.join(dir, MANIFEST)) };
}

export function setup(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'remote-recovery-'))); t.after(() => { fs.rmSync(root, { recursive: true, force: true }); delete globalThis.__enkiFakeDaemon; });
  const daemon = globalThis.__enkiFakeDaemon = { running: null, held: null, receipts: {}, log: [] };
  const base = { dist: path.join(root, 'dist'), data: path.join(root, 'data') };
  return { root, daemon, base, v1: { ...base, ...artifact(root, '1111111111111111') }, v2: { ...base, ...artifact(root, '2222222222222222') } };
}
export const JOURNAL_FILE = '.remote-runtime-update.json';
export const journal = s => JSON.parse(fs.readFileSync(path.join(s.base.dist, JOURNAL_FILE), 'utf8'));
export const hasJournal = s => fs.existsSync(path.join(s.base.dist, JOURNAL_FILE));
