#!/usr/bin/env node
// Run this TRUSTED updater with an existing trusted Node24. The authenticated
// manifest digest must come from the signed update transport, never a neighboring
// candidate .sha256 file. Candidate code is not imported/executed before verify.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { MANIFEST, acquireArtifactLease, sha256File, syncArtifact, syncDirectory, verifyArtifact } from './artifact.mjs';
import { SDK_CONTRACT } from './sdk-contract.mjs';
// The reviewed qualified runtime set (sdk-contract.mjs). installRemote may be
// given another reviewed set (tests of cross-SDK paired rollback); the CLI never.
let qualified = SDK_CONTRACT.qualified;
const qualifiedRuntime = (sdk, node) => qualified.some(entry => entry.sdk === sdk && entry.node === node);
const STATE = '.remote-runtime-state.json', JOURNAL = '.remote-runtime-update.json';
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const version = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(value) && !value.endsWith('.');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const refused = message => Object.assign(new Error(message), { code: 'ENKI_UPDATE_REFUSED' });
function read(file, ceiling = 1024 * 1024) { sha256File(file); if (fs.statSync(file).size > ceiling) throw new Error('Updater metadata exceeds limit'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
function exists(file) { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function save(root, file, value) {
  const temporary = path.join(root, `.remote-${crypto.randomUUID()}.tmp`), fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (exists(path.join(root, file))) sha256File(path.join(root, file));
  fs.renameSync(temporary, path.join(root, file)); syncDirectory(root);
}
const descriptor = value => record(value) && Object.keys(value).every(k => ['version', 'manifestSha256'].includes(k)) && version(value.version) && hash(value.manifestSha256);
const equal = (a, b) => a === null ? b === null : b !== null && a.version === b.version && a.manifestSha256 === b.manifestSha256;
function state(root) {
  if (!exists(path.join(root, STATE))) return { schema: 1, current: null, previous: null, previousBackup: null };
  const value = read(path.join(root, STATE));
  if (!record(value) || value.schema !== 1 || !(value.current === null || descriptor(value.current)) || !(value.previous === null || descriptor(value.previous))
    || !Object.hasOwn(value, 'previousBackup') || Object.keys(value).some(key => !['schema', 'current', 'previous', 'previousBackup'].includes(key))) throw new Error('Invalid remote runtime state');
  return value;
}
export function inspectArtifact(root, expectedManifestSha256) {
  if (!hash(expectedManifestSha256)) throw new Error('Authenticated expected manifest SHA256 is required');
  if (sha256File(path.join(root, MANIFEST)) !== expectedManifestSha256) throw new Error('Candidate manifest authentication failed');
  const errors = verifyArtifact(root, { manifestSha256: expectedManifestSha256 }); if (errors.length) throw new Error(`Unverified runtime: ${errors.slice(0, 5).join('; ')}`);
  const manifest = read(path.join(root, MANIFEST), 8 * 1024 * 1024), info = read(path.join(root, 'app/runtime-version.json'));
  for (const file of ['app/dist/daemon-control.js', 'app/runtime-version.json', 'app/runtime-lock.json', 'app/package-lock.json']) if (!Object.hasOwn(manifest.files, file)) throw new Error(`Runtime metadata is not covered: ${file}`);
  if (!record(info) || !/^[a-f0-9]{16}$/.test(info.version ?? '') || !qualifiedRuntime(info.sdk, info.node)
    || !Number.isSafeInteger(info.dataSchema) || info.dataSchema < 1 || info.contract !== manifest.contract || manifest.version !== `${info.sdk}-${info.version}`) throw new Error('Runtime metadata does not match the authenticated artifact');
  return { root, manifest, info, descriptor: { version: manifest.version, manifestSha256: expectedManifestSha256 } };
}
/** Must be called under the publisher OS lease. Existing versions are completely
 * reverified; a partial/corrupt directory is never accepted or overwritten. */
export function publishImmutable(root, candidate, expectedManifestSha256) {
  const source = inspectArtifact(candidate, expectedManifestSha256), target = path.join(root, source.descriptor.version);
  if (exists(target)) { inspectArtifact(target, expectedManifestSha256); return target; }
  const temporary = path.join(root, `.publish-${crypto.randomUUID()}`);
  try {
    fs.cpSync(candidate, temporary, { recursive: true, dereference: false, errorOnExist: true, force: false });
    inspectArtifact(temporary, expectedManifestSha256); syncArtifact(temporary);
    if (exists(target)) throw new Error('Concurrent immutable runtime appeared');
    fs.renameSync(temporary, target); syncDirectory(root); return target;
  } finally { if (exists(temporary)) fs.rmSync(temporary, { recursive: true, force: true }); }
}
function currentPointer(root) {
  const file = path.join(root, 'current'); if (!exists(file)) return null;
  if (!fs.lstatSync(file).isSymbolicLink()) throw new Error('Current runtime pointer is not an owned symlink');
  const value = fs.readlinkSync(file); if (!version(value)) throw new Error('Unsafe runtime pointer'); return value;
}
function point(root, value, allowed) {
  const old = currentPointer(root); if (!allowed.includes(old)) throw new Error('Unexpected runtime pointer; journal retained');
  if (value === null) { if (old !== null) fs.unlinkSync(path.join(root, 'current')); syncDirectory(root); return; }
  if (!descriptor(value)) throw new Error('Invalid runtime pointer descriptor');
  inspectArtifact(path.join(root, value.version), value.manifestSha256);
  const temporary = path.join(root, `.current-${crypto.randomUUID()}`); fs.symlinkSync(value.version, temporary);
  fs.renameSync(temporary, path.join(root, 'current')); syncDirectory(root);
}
function expected(control, data, artifact) { return { dataHash: control.dataHash(data), version: artifact.info.version,
  contract: artifact.info.contract, schema: artifact.info.dataSchema, sdk: artifact.info.sdk }; }
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The LIVE data layout exactly as the verified runtime bundle defines it
 * (platform/paths.ts DATA_LAYOUT): single safe path segments only. */
function liveLayout(control) {
  const layout = control.DATA_LAYOUT;
  if (!record(layout) || !SEGMENT.test(layout.database ?? '') || !SEGMENT.test(layout.sessions ?? '') || layout.backups !== 'update-backups'
    || !Array.isArray(layout.databaseCompanions) || !layout.databaseCompanions.every(name => SEGMENT.test(name) && name.startsWith(`${layout.database}-`))) throw new Error('Verified daemon control has no valid live data layout');
  return { database: layout.database, files: [layout.database, ...layout.databaseCompanions], sessions: layout.sessions };
}
async function controlModule(artifact) {
  const value = await import(pathToFileURL(path.join(artifact.root, 'app/dist/daemon-control.js')).href);
  for (const name of ['acquireStartLease', 'acquireLease', 'dataHash', 'privateRoot', 'probeDaemon', 'requestJson', 'beginDaemonMaintenance', 'endDaemonMaintenance', 'stopDaemon', 'ensureDaemon',
    'verifySessionSnapshot', 'restoreSessionSnapshot', 'validSnapshot']) if (typeof value[name] !== 'function') throw new Error(`Verified daemon control contract is missing ${name}`);
  liveLayout(value);
  return value;
}
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const BACKUP_KEYS = ['bytes', 'createdAt', 'id', 'relativePath', 'runtimeVersion', 'schema', 'sdk', 'sha256'];
/** Exact typed UpdateBackup (core/runtime.ts): no missing, extra or mistyped
 * fields, compared field by field (never by key order of a serialization).
 * `sessions` (paired JSONL snapshot) is absent only in DB-only receipts of
 * older runtimes; those can never authorize a cross-SDK rollback. */
function exactBackup(control, value) {
  const keys = record(value) ? Object.keys(value).filter(key => key !== 'sessions').sort().join() : '';
  return record(value) && keys === BACKUP_KEYS.join() && typeof value.id === 'string' && UUID_V4.test(value.id)
    && value.relativePath === `update-backups/${value.id}/state.sqlite` && hash(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes > 0
    && Number.isSafeInteger(value.schema) && value.schema > 0 && typeof value.sdk === 'string' && typeof value.runtimeVersion === 'string'
    && Number.isSafeInteger(value.createdAt) && value.createdAt > 0 && (!Object.hasOwn(value, 'sessions') || control.validSnapshot(value.sessions));
}
const sameSessions = (a, b) => a === undefined ? b === undefined : b !== undefined && ['manifestSha256', 'files', 'bytes'].every(key => a[key] === b[key]);
const sameBackup = (a, b) => BACKUP_KEYS.every(key => a[key] === b[key]) && sameSessions(a.sessions, b.sessions);
function verifyBackup(control, data, backup, artifact) {
  if (!exactBackup(control, backup) || backup.schema !== artifact.info.dataSchema || backup.sdk !== artifact.info.sdk || backup.runtimeVersion !== artifact.info.version) throw new Error('Backup does not pair with the previous runtime');
  const file = path.join(data, ...backup.relativePath.split('/')), receipt = read(path.join(path.dirname(file), 'receipt.json'), 64 * 1024);
  if (!exactBackup(control, receipt) || !sameBackup(receipt, backup)) throw new Error('Paired backup receipt does not match exactly');
  if (sha256File(file) !== backup.sha256 || fs.statSync(file).size !== backup.bytes) throw new Error('Paired backup integrity failed');
  const database = new DatabaseSync(file, { readOnly: true });
  try { if (database.prepare('PRAGMA user_version').get().user_version !== backup.schema || database.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Paired backup schema/integrity failed'); }
  finally { database.close(); }
  if (backup.sessions) control.verifySessionSnapshot(data, backup.id, backup.sessions);
  return file;
}
/** The daemon lifetime lease is an OS lock held by any live daemon. Acquiring it
 * proves no daemon for this data root is running; a missing probe does not. */
function holdStopped(control, data) {
  try { return control.acquireLease(data, 'lifetime'); }
  catch (error) { if (error?.code === 'ENKI_DAEMON_BUSY') throw new Error('A daemon still holds this data root; outcome retained, nothing was replaced', { cause: error }); throw error; }
}
/** Move the LIVE database with its WAL/SHM/journal (and, when asked, the live
 * session store) aside into one new directory: never deleted, never merged. */
function preserveLive(control, data, label, { sessions = false } = {}) {
  const layout = liveLayout(control), saved = path.join(data, `${label}-${crypto.randomUUID()}`); let moved = 0;
  for (const name of [...layout.files, ...(sessions ? [layout.sessions] : [])]) {
    if (!exists(path.join(data, name))) continue;
    if (!moved++) fs.mkdirSync(saved, { mode: 0o700 });
    if (name !== layout.sessions) sha256File(path.join(data, name));
    fs.renameSync(path.join(data, name), path.join(saved, name));
  }
  if (moved) { syncDirectory(saved); syncDirectory(data); }
  return moved ? saved : null;
}
/** Live data present at all: database files, or any session file. */
function liveData(control, data) {
  const layout = liveLayout(control), sessions = path.join(data, layout.sessions);
  if (layout.files.some(name => exists(path.join(data, name)))) return true;
  return exists(sessions) && fs.readdirSync(sessions).some(key => !fs.lstatSync(path.join(sessions, key)).isDirectory() || fs.readdirSync(path.join(sessions, key)).length > 0);
}
function restoreBackup(control, data, backup, previous) {
  const source = verifyBackup(control, data, backup, previous), release = holdStopped(control, data), layout = liveLayout(control);
  try {
    // Start (caller) and lifetime leases are both held: no writer can open.
    // The verified durable copy exists before the live files are moved aside.
    const temporary = path.join(data, `.restore-${crypto.randomUUID()}.sqlite`); fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL); fs.chmodSync(temporary, 0o600);
    if (sha256File(temporary) !== backup.sha256) { fs.rmSync(temporary); throw new Error('Paired backup changed during restoration'); }
    const fd = fs.openSync(temporary, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const saved = preserveLive(control, data, 'failed-update') ?? path.join(data, `failed-update-${crypto.randomUUID()}`);
    fs.renameSync(temporary, path.join(data, layout.database)); syncDirectory(data);
    // The exact paired JSONL transcripts of the same backup. A failure here
    // leaves the journal in 'candidate', so the next recovery repeats the whole
    // (idempotent) restoration; the current store is preserved, never deleted.
    if (backup.sessions) control.restoreSessionSnapshot(data, backup.id, backup.sessions, saved);
  } finally { release(); }
}
export function stripInjection(source, platform = process.platform) {
  const fold = (key) => platform === 'win32' ? key.toUpperCase() : key;
  const blocked = new Set(['NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE', 'NODE_EXTRA_CA_CERTS_OVERRIDE'].map(fold));
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && !blocked.has(fold(key))));
}
function launch(control, data, artifact, lease) {
  // Preserve the original SDK-related environment: main bootstrap captures it
  // before applying the immutable profile and restoring project-shell overrides.
  // One policy with the fresh `ensure` launch: the verified control bundle's
  // daemonEnvironment (four injection keys removed, everything else kept).
  // An older verified bundle without it gets the identical four-key removal.
  const env = typeof control.daemonEnvironment === 'function' ? control.daemonEnvironment(process.env) : stripInjection(process.env);
  return control.ensureDaemon({ data, agentDir: path.join(data, 'agent'), userPiAgentDir: path.join(data, 'explicit-pi-import'), startOwner: lease.nonce },
    expected(control, data, artifact), { executable: path.join(artifact.root, ...artifact.manifest.node.split('/')), entry: path.join(artifact.root, ...artifact.manifest.entry.split('/')), env }, 30_000, lease);
}
function validJournal(value) {
  // freshData is absent in journals written before first-install recovery existed.
  return record(value) && value.schema === 1 && UUID_V4.test(value.id ?? '') && ['preparing', 'ready', 'candidate', 'committed'].includes(value.phase)
    && record(value.before) && (value.before.current === null || descriptor(value.before.current)) && (value.before.previous === null || descriptor(value.before.previous))
    && descriptor(value.target) && Object.hasOwn(value, 'oldReceipt') && Object.hasOwn(value, 'newReceipt') && hash(value.dataHash)
    && (!Object.hasOwn(value, 'freshData') || typeof value.freshData === 'boolean')
    && Object.keys(value).every(key => ['schema', 'id', 'phase', 'before', 'target', 'dataHash', 'oldReceipt', 'newReceipt', 'freshData'].includes(key));
}
const clearJournal = root => { fs.unlinkSync(path.join(root, JOURNAL)); syncDirectory(root); };
/** Reconcile a begin request whose receipt was never recorded. Read-only GET of
 * its exact request id; the begin POST is never replayed. Returns the held
 * receipt, `null` when the request provably holds no fence, or throws. */
async function reconcileBegin(control, data, previous, id) {
  const identity = expected(control, data, previous), connected = await control.probeDaemon(data, identity);
  if (!connected) { holdStopped(control, data)(); return null; } // no live daemon => no in-memory fence
  let outcome;
  try { outcome = await control.requestJson(connected.state.port, connected.token, `/_enki/runtime/maintenance/${id}`); }
  catch (error) {
    if (/HTTP 404$/.test(error?.message ?? '')) outcome = { state: 'unknown' }; // this generation never received it
    else throw new Error('Maintenance outcome is uncertain; journal retained and mutation was not replayed', { cause: error });
  }
  if (record(outcome) && outcome.state === 'pending') throw new Error('Maintenance begin is still pending; journal retained and mutation was not replayed');
  const health = await control.requestJson(connected.state.port, connected.token, '/_enki/runtime/health');
  const held = record(health) ? health.maintenance : undefined;
  if (record(outcome) && outcome.ok === true && outcome.id === id) {
    if (!record(held) || held.id !== id || held.lease !== outcome.lease || held.identity?.instance !== connected.state.identity.instance) return null; // already released
    verifyBackup(control, data, outcome.backup, previous); return outcome;
  }
  // failed/unknown: this request holds nothing. Any other held fence is foreign.
  if (record(held) && held.id === id) throw new Error('Maintenance state is inconsistent; journal retained');
  return null;
}
async function heldHealth(control, data, artifact, lease) {
  // This call reuses only an authenticated matching existing daemon; it must
  // never spawn during uncertain recovery. readState + exact instance fence.
  const identity = expected(control, data, artifact);
  const connected = await control.probeDaemon(data, identity); if (!connected) return null;
  const health = await control.requestJson(connected.state.port, connected.token, '/_enki/runtime/health');
  if (!record(health) || health.state !== 'ready' || !record(health.identity)
    || health.identity.instance !== connected.state.identity.instance || Object.keys(identity).some(key => health.identity[key] !== identity[key])) throw new Error('Daemon generation changed during recovery');
  return health;
}
async function recover(root, data, control, lease) {
  if (!exists(path.join(root, JOURNAL))) return;
  const journal = read(path.join(root, JOURNAL)); if (!validJournal(journal) || journal.dataHash !== control.dataHash(data)) throw new Error('Unsafe or foreign update journal retained');
  const target = inspectArtifact(path.join(root, journal.target.version), journal.target.manifestSha256);
  const previous = journal.before.current ? inspectArtifact(path.join(root, journal.before.current.version), journal.before.current.manifestSha256) : null;
  if (journal.phase === 'committed') {
    const current = state(root); if (!equal(current.current, journal.target)) throw new Error('Committed state does not match journal');
    point(root, journal.target, [journal.target.version]);
    let fence = (await heldHealth(control, data, target, lease))?.maintenance;
    if (fence === undefined && !(await control.probeDaemon(data, expected(control, data, target)))) {
      // Committed but dead: start the committed runtime under this start lease.
      // It comes up with its initial fence, released only after authenticated readiness.
      holdStopped(control, data)();
      const started = await launch(control, data, target, lease);
      if (!started.maintenance?.initial) throw new Error('Committed runtime did not confirm its startup fence; journal retained');
      fence = started.maintenance;
    }
    if (fence) await control.endDaemonMaintenance(data, expected(control, data, target), lease, fence);
    clearJournal(root); return;
  }
  if (previous && !journal.oldReceipt) {
    // Only 'preparing' can lack a receipt: begin was sent but its ACK was lost.
    if (journal.phase !== 'preparing') throw new Error('Journal lacks its maintenance receipt; retained');
    const receipt = await reconcileBegin(control, data, previous, journal.id);
    // No fence is held and nothing was stopped, pointed or migrated: cancel cleanly.
    if (!receipt) { if (currentPointer(root) !== journal.before.current.version) throw new Error('Runtime pointer changed before activation; journal retained'); clearJournal(root); return; }
    journal.oldReceipt = receipt; save(root, JOURNAL, journal);
  }
  // A candidate is only ever launched after 'candidate' is durable.
  const candidateHealth = journal.phase === 'candidate' ? await heldHealth(control, data, target, lease) : null;
  if (candidateHealth) {
    if (!candidateHealth.maintenance) throw new Error('Candidate is not fenced; automatic rollback refused');
    await control.stopDaemon(data, expected(control, data, target), { startLease: lease, maintenanceLease: candidateHealth.maintenance.lease });
  }
  if (previous) {
    if (!journal.oldReceipt?.backup) throw new Error('Paired backup is missing; rollback refused');
    verifyBackup(control, data, journal.oldReceipt.backup, previous);
    const oldHealth = await heldHealth(control, data, previous, lease);
    if (oldHealth) {
      // Still fenced by THIS update and never stopped: just release the fence.
      if (!oldHealth.maintenance || oldHealth.maintenance.id !== journal.oldReceipt.id || oldHealth.maintenance.lease !== journal.oldReceipt.lease || journal.phase === 'candidate') throw new Error('Previous daemon is running without this update fence; rollback refused');
      point(root, journal.before.current, [journal.target.version, journal.before.current.version]);
      await control.endDaemonMaintenance(data, expected(control, data, previous), lease, oldHealth.maintenance);
    } else {
      // Exact paired backup only if the candidate may have opened the data, and
      // only after the lifetime lease proves every daemon has really stopped.
      if (journal.phase === 'candidate') restoreBackup(control, data, journal.oldReceipt.backup, previous);
      else holdStopped(control, data)();
      point(root, journal.before.current, [journal.target.version, journal.before.current.version]);
      const restarted = await launch(control, data, previous, lease); if (!restarted.maintenance) throw new Error('Previous runtime did not retain its startup fence');
      await control.endDaemonMaintenance(data, expected(control, data, previous), lease, restarted.maintenance);
    }
  } else {
    if (journal.phase === 'candidate') {
      // First install: anything in the data root was created by the fenced
      // candidate (journal proves none existed). Preserve it aside so a retry
      // is not blocked as "unadopted data"; never delete it.
      if (journal.freshData !== true) { if (liveData(control, data)) throw new Error('First-install data has unknown provenance; explicit adoption required, journal retained'); }
      else { const release = holdStopped(control, data); try { preserveLive(control, data, 'failed-first-install', { sessions: true }); } finally { release(); } }
    }
    point(root, null, [null, journal.target.version]);
  }
  save(root, STATE, journal.before); clearJournal(root);
}
/** The control module is imported only from a publisher-owned immutable version
 * directory, fully re-verified immediately before import, never from the
 * caller-supplied candidate path (which may change after authentication). */
function controlSource(dist, published) {
  if (published) return published;
  if (exists(path.join(dist, JOURNAL))) { const journal = read(path.join(dist, JOURNAL)); if (!validJournal(journal)) throw new Error('Unsafe update journal retained'); return journal.target; }
  const current = state(dist).current; if (!current) throw new Error('No installed runtime'); return current;
}
/** Actual remote install: authenticates before dynamic import or candidate Node,
 * holds publisher and daemon OS leases through drain/backup/stop/start/commit. */
export async function installRemote({ dist, candidate, expectedManifestSha256, data, rollback = false, restoreDataBackup = false, qualifiedRuntimes = SDK_CONTRACT.qualified }) {
  qualified = qualifiedRuntimes;
  // Fail fast before creating any lease, directory or data root.
  if (!rollback) inspectArtifact(candidate, expectedManifestSha256);
  fs.mkdirSync(dist, { recursive: true, mode: 0o700 }); dist = fs.realpathSync(dist);
  const publisher = acquireArtifactLease(dist);
  let startLease;
  try {
    const published = rollback ? null : inspectArtifact(publishImmutable(dist, candidate, expectedManifestSha256), expectedManifestSha256).descriptor;
    const source = controlSource(dist, published);
    const control = await controlModule(inspectArtifact(path.join(dist, source.version), source.manifestSha256)); data = control.privateRoot(data);
    if (data === dist || data.startsWith(dist + path.sep) || dist.startsWith(data + path.sep)) throw new Error('Runtime code and mutable data must be separate');
    startLease = control.acquireStartLease(data); await recover(dist, data, control, startLease);
    const before = state(dist); if (currentPointer(dist) !== (before.current?.version ?? null)) throw new Error('Runtime pointer and state differ');
    let target;
    if (rollback) {
      if (!before.previous) throw new Error('No previous runtime'); target = inspectArtifact(path.join(dist, before.previous.version), before.previous.manifestSha256);
    } else target = inspectArtifact(path.join(dist, published.version), published.manifestSha256);
    if (equal(before.current, target.descriptor)) return { version: target.descriptor.version, changed: false };
    const previous = before.current ? inspectArtifact(path.join(dist, before.current.version), before.current.manifestSha256) : null;
    // The real LIVE layout of the verified runtime (runtime.sqlite + companions + sessions).
    const freshData = !previous && !liveData(control, data);
    if (!previous && !freshData) throw refused('Existing data without an authenticated previous runtime needs explicit adoption');
    const crossSdk = Boolean(previous) && previous.info.sdk !== target.info.sdk;
    // Rolling back across a schema or SDK change restores the exact paired DB +
    // JSONL snapshot the older runtime took before the update (current data is
    // preserved aside). Only a receipt WITH sessions can authorize an SDK change.
    const schemaRollback = rollback && previous && (previous.info.dataSchema !== target.info.dataSchema || crossSdk);
    if (schemaRollback && !restoreDataBackup) throw refused('Schema or SDK rollback requires explicit paired-backup restoration (--restore-paired-data)');
    if (schemaRollback && crossSdk && !before.previousBackup?.sessions) throw refused('SDK rollback requires a paired backup that includes every session transcript');
    // Validate the older paired backup before anything is fenced or stopped.
    if (schemaRollback) verifyBackup(control, data, before.previousBackup, target);
    const journal = { schema: 1, id: crypto.randomUUID(), phase: 'preparing', before, target: target.descriptor, dataHash: control.dataHash(data), oldReceipt: null, newReceipt: null, freshData };
    save(dist, JOURNAL, journal);
    if (previous) {
      // One begin POST; an uncertain ACK is reconciled by GET on the next run.
      journal.oldReceipt = await control.beginDaemonMaintenance(data, expected(control, data, previous), startLease, journal.id);
      verifyBackup(control, data, journal.oldReceipt.backup, previous);
      if (crossSdk && !journal.oldReceipt.backup.sessions) {
        // Forward SDK change without a transcript snapshot could not be rolled
        // back exactly: release this exact fence, change nothing, refuse.
        await control.endDaemonMaintenance(data, expected(control, data, previous), startLease, journal.oldReceipt);
        clearJournal(dist);
        throw refused('SDK upgrade requires the installed runtime to take a paired session snapshot; nothing was changed');
      }
    }
    journal.phase = 'ready'; save(dist, JOURNAL, journal);
    if (previous) await control.stopDaemon(data, expected(control, data, previous), { startLease, maintenanceLease: journal.oldReceipt.lease });
    point(dist, target.descriptor, [before.current?.version ?? null]);
    journal.phase = 'candidate'; save(dist, JOURNAL, journal);
    // Durable 'candidate' first: recovery then restores the newer paired backup.
    if (schemaRollback) restoreBackup(control, data, before.previousBackup, target);
    const ready = await launch(control, data, target, startLease); if (!ready.maintenance?.initial) throw new Error('Candidate startup fence was not confirmed');
    journal.newReceipt = ready.maintenance;
    const next = { schema: 1, current: target.descriptor, previous: before.current, previousBackup: journal.oldReceipt?.backup ?? null };
    save(dist, STATE, next); journal.phase = 'committed'; save(dist, JOURNAL, journal);
    await control.endDaemonMaintenance(data, expected(control, data, target), startLease, ready.maintenance);
    fs.unlinkSync(path.join(dist, JOURNAL)); syncDirectory(dist);
    return { version: target.descriptor.version, changed: true };
  } catch (error) {
    // A typed refusal changed nothing and left no journal.
    if (error?.code === 'ENKI_UPDATE_REFUSED') throw error;
    // Never guess an uncertain POST outcome or replay it. The next invocation
    // reconciles the retained journal with authenticated health and OS leases.
    throw new Error(`Remote update was not fully confirmed: ${error.message}. The recovery journal is retained.`, { cause: error });
  } finally { startLease?.release(); publisher.release(); }
}
/** CLI (through install-remote-entry.mjs, which checks the host Node first).
 * Resolves the exit code. */
export async function main(argv) {
  const value = flag => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
  try { console.log(await installRemote({ dist: value('--dist'), candidate: value('--artifact'), expectedManifestSha256: value('--manifest-sha256'), data: value('--data'), rollback: argv.includes('--rollback'), restoreDataBackup: argv.includes('--restore-paired-data') })); return 0; }
  catch (error) { console.error(error.message); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
