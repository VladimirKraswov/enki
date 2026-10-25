// Private proposal, based on the exact draft recorded in evidence/.
// No network, subprocess, SDK or preparation side effects at module import.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { flushDirectoriesSync } from './native-port.mjs';

export const PLATFORMS = ['darwin-arm64', 'win32-x64', 'linux-x64'];
export const MANIFEST = 'runtime-manifest.json';
const JOURNAL = '.runtime-artifact-journal.json';
const LEASE = '.runtime-artifact-lease.sqlite';
const DIGEST = /^[a-f0-9]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const own = (object, key) => Object.hasOwn(object, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validVersion = (value) => typeof value === 'string' && VERSION.test(value) && !value.endsWith('.');
const validContract = (value) => Number.isSafeInteger(value) && value > 0;
export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const hostPlatform = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;

/** Portable path grammar: Windows semantics must be rejected on every host. */
export function safeRelative(relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 4096 || /[\x00-\x1f\x7f<>:"\\|?*]/u.test(relative)) return false;
  return relative.split('/').every((part) => {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || Buffer.byteLength(part) > 255) return false;
    const base = part.split('.')[0].replace(/ +$/u, '').toUpperCase();
    return !/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/u.test(base);
  });
}

export function validateLock(lock, platform) {
  if (!record(lock) || lock.schema !== 1) throw new Error('runtime-lock.json: unsupported schema');
  if (!PLATFORMS.includes(platform)) throw new Error(`Unsupported runtime platform: ${platform}`);
  if (!record(lock.review) || lock.review.status !== 'PINNED') throw new Error('runtime-lock.json is not reviewed (review.status must be PINNED)');
  if (!validContract(lock.contract)) throw new Error('runtime-lock.json: invalid contract');
  if (!record(lock.sdk) || !validVersion(lock.sdk.version)) throw new Error('runtime-lock.json: invalid SDK version');
  const node = lock.node;
  if (!record(node) || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(node.version ?? '')) throw new Error('runtime-lock.json: invalid Node.js version');
  const [major, minor, patch] = node.version.split('.').map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger) || major < 22 || (major === 22 && minor < 19)) throw new Error('Pi SDK 0.85.1 requires Node.js >= 22.19.0');
  const source = `https://nodejs.org/dist/v${node.version}/`;
  // Exact URL, not startsWith: no userinfo, port, extra path, query or fragment.
  if (node.source !== source || new URL(node.source).href !== source) throw new Error('runtime-lock.json: Node.js must come from the exact official release URL');
  if (!record(node.artifacts) || Object.keys(node.artifacts).some((key) => !PLATFORMS.includes(key))) throw new Error('runtime-lock.json: invalid artifact platforms');
  const contracts = {
    'darwin-arm64': { files: [`node-v${node.version}-darwin-arm64.tar.gz`], binary: 'bin/node' },
    'win32-x64': { files: [`node-v${node.version}-win-x64.zip`], binary: 'node.exe' },
    'linux-x64': { files: [`node-v${node.version}-linux-x64.tar.gz`, `node-v${node.version}-linux-x64.tar.xz`], binary: 'bin/node' },
  };
  for (const key of PLATFORMS) {
    const artifact = node.artifacts[key];
    const expected = contracts[key];
    if (!record(artifact) || !expected.files.includes(artifact.file) || !safeRelative(artifact.file) || typeof artifact.sha256 !== 'string' || !DIGEST.test(artifact.sha256) || artifact.binary !== expected.binary) throw new Error(`runtime-lock.json: ${key} has invalid filename, binary or reviewed sha256`);
    if (own(artifact, 'url') && artifact.url !== `${source}${artifact.file}`) throw new Error(`runtime-lock.json: ${key} URL does not match the official artifact`);
  }
  return node.artifacts[platform];
}

export function parseShasums(text) {
  const out = Object.create(null);
  for (const line of text.split('\n')) {
    const match = /^([a-f0-9]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match) {
      if (!safeRelative(match[2]) || match[2].includes('/')) throw new Error('Unsafe checksum filename');
      if (own(out, match[2]) && out[match[2]] !== match[1]) throw new Error(`Conflicting checksums for ${match[2]}`);
      out[match[2]] = match[1];
    }
  }
  return out;
}

/** Reject links in every absolute path component before opening any content. */
function absoluteStat(input, kind) {
  const full = path.resolve(input);
  const parsed = path.parse(full);
  let at = parsed.root;
  const parts = full.slice(at.length).split(path.sep).filter(Boolean);
  let stat = fs.lstatSync(at, { bigint: true });
  for (let index = 0; index < parts.length; index++) {
    at = path.join(at, parts[index]);
    stat = fs.lstatSync(at, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error(`Runtime artifact contains a symbolic link: ${at}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`Artifact ancestor is not a directory: ${at}`);
  }
  if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Artifact path is not a regular ${kind}: ${full}`);
  return stat;
}
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function openRegular(full, access = fs.constants.O_RDONLY) {
  const before = absoluteStat(full, 'file');
  const fd = fs.openSync(full, access | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const after = absoluteStat(full, 'file');
    if (!opened.isFile() || !sameFile(before, opened) || !sameFile(after, opened)) throw new Error('Artifact file changed during open');
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}
export function sha256File(full) {
  const fd = openRegular(full);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    const after = fs.fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('Artifact file changed during hashing');
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
function readJson(full, ceiling = 8 * 1024 * 1024) {
  const fd = openRegular(full);
  try {
    const size = fs.fstatSync(fd).size;
    if (size > ceiling) throw new Error('Artifact metadata exceeds size limit');
    const bytes = Buffer.alloc(size + 1);
    let total = 0, length;
    while ((length = fs.readSync(fd, bytes, total, bytes.length - total, null)) > 0) {
      total += length;
      if (total > size) throw new Error('Artifact metadata changed during read');
    }
    if (total !== size) throw new Error('Artifact metadata changed during read');
    return JSON.parse(bytes.subarray(0, total).toString('utf8'));
  } finally { fs.closeSync(fd); }
}
function inventory(root) {
  absoluteStat(root, 'directory');
  const files = [], directories = [], canonical = new Map();
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (!safeRelative(relative)) throw new Error(`Unsafe artifact path: ${relative}`);
      const normalized = relative.normalize('NFC').toLowerCase();
      if (canonical.has(normalized)) throw new Error(`Portable path collision: ${relative} / ${canonical.get(normalized)}`);
      canonical.set(normalized, relative);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`Runtime artifact contains a symbolic link: ${relative}`);
      if (stat.isDirectory()) { directories.push(relative); walk(full); }
      else if (stat.isFile()) files.push(relative);
      else throw new Error(`Runtime artifact contains a special file: ${relative}`);
    }
  };
  walk(root);
  return { files: files.sort(), directories: directories.sort() };
}
export function listFiles(root) { return inventory(root).files; }
function shape(manifest) {
  const problems = [];
  if (!record(manifest)) return ['manifest must be an object'];
  const keys = ['schema', 'version', 'contract', 'node', 'entry', 'files'];
  if (Object.keys(manifest).some((key) => !keys.includes(key)) || keys.some((key) => !own(manifest, key))) problems.push('invalid manifest fields');
  if (manifest.schema !== 1) problems.push('unsupported manifest schema');
  if (!validVersion(manifest.version)) problems.push('invalid version');
  if (!validContract(manifest.contract)) problems.push('invalid contract');
  if (!safeRelative(manifest.node) || !safeRelative(manifest.entry) || manifest.node === manifest.entry) problems.push('invalid node or entry path');
  if (!record(manifest.files) || Object.keys(manifest.files).length === 0 || Object.keys(manifest.files).length > 200_000) return [...problems, 'invalid files inventory'];
  const canonical = new Map();
  for (const [relative, expected] of Object.entries(manifest.files)) {
    if (!safeRelative(relative) || relative === MANIFEST) problems.push(`unsafe path ${relative}`);
    if (typeof expected !== 'string' || !DIGEST.test(expected)) problems.push(`invalid sha256 ${relative}`);
    const normalized = relative.normalize('NFC').toLowerCase();
    if (canonical.has(normalized)) problems.push(`portable path collision ${relative}`);
    canonical.set(normalized, relative);
  }
  for (const key of ['node', 'entry']) if (typeof manifest[key] !== 'string' || !own(manifest.files, manifest[key])) problems.push(`${key} not covered by manifest`);
  return problems;
}
export function buildManifest(root, { version, contract, node, entry }) {
  if (!validVersion(version) || !validContract(contract) || !safeRelative(node) || !safeRelative(entry) || node === entry) throw new Error('Invalid manifest version, contract, interpreter or entry');
  const files = Object.create(null);
  for (const relative of listFiles(root)) if (relative !== MANIFEST) files[relative] = sha256File(path.join(root, ...relative.split('/')));
  const manifest = { schema: 1, version, contract, node, entry, files };
  const problems = shape(manifest);
  if (problems.length) throw new Error(`Invalid manifest: ${problems.join('; ')}`);
  return manifest;
}
/** Exact files inventory, portable paths, and ancestor/leaf link checks before hashes. */
export function verifyArtifact(root, expected = {}) {
  if (!record(expected)) return ['invalid expected artifact identity'];
  let manifest;
  try { absoluteStat(root, 'directory'); manifest = readJson(path.join(root, MANIFEST)); }
  catch (error) { return [`missing or unreadable runtime-manifest.json: ${error.message}`]; }
  const problems = shape(manifest);
  if (problems.length) return problems;
  for (const key of ['version', 'contract', 'node', 'entry']) if (own(expected, key) && manifest[key] !== expected[key]) problems.push(`unexpected ${key}`);
  let present;
  try { present = inventory(root); } catch (error) { return [...problems, error.message]; }
  const listed = new Set(Object.keys(manifest.files));
  const actual = new Set(present.files.filter((relative) => relative !== MANIFEST));
  for (const relative of listed) if (!actual.has(relative)) problems.push(`missing ${relative}`);
  for (const relative of actual) if (!listed.has(relative)) problems.push(`unlisted file ${relative}`);
  const allowedDirectories = new Set();
  for (const relative of listed) {
    let directory = path.posix.dirname(relative);
    while (directory !== '.') { allowedDirectories.add(directory); directory = path.posix.dirname(directory); }
  }
  for (const relative of present.directories) if (!allowedDirectories.has(relative)) problems.push(`unlisted empty directory ${relative}`);
  if (problems.length) return problems;
  for (const [relative, digest] of Object.entries(manifest.files)) {
    try { if (sha256File(path.join(root, ...relative.split('/'))) !== digest) problems.push(`hash mismatch ${relative}`); }
    catch (error) { problems.push(`unreadable ${relative}: ${error.message}`); }
  }
  if (own(expected, 'manifestSha256') && sha256File(path.join(root, MANIFEST)) !== expected.manifestSha256) problems.push('unexpected manifest sha256');
  return problems;
}

function statIfPresent(full) {
  try { return fs.lstatSync(full, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
let directoryFlushPort;
/** Windows has no portable directory fsync in Node. Promotion there requires
 * the trusted native runner (see native-port.mjs); unset means fail closed. */
export function setDirectoryFlushPort(runner) {
  if (runner !== undefined && (typeof runner !== 'string' || !path.isAbsolute(runner))) throw new Error('Directory flush port must be an absolute runner path');
  directoryFlushPort = runner;
}
function unsupportedDirectorySync(cause) {
  const error = new Error(`Runtime artifact promotion requires durable directory synchronization, unsupported on this filesystem/platform (${process.platform}${cause ? `, ${cause.code}` : ''}); a qualified native promotion adapter is required`, { cause });
  error.code = 'ENKI_ARTIFACT_DIRECTORY_SYNC_UNSUPPORTED';
  return error;
}
function flushDirectories(directories) {
  for (const directory of directories) absoluteStat(directory, 'directory');
  if (process.platform === 'win32') {
    if (!directoryFlushPort) throw unsupportedDirectorySync();
    flushDirectoriesSync(directoryFlushPort, directories.map((directory) => path.resolve(directory)));
    return;
  }
  for (const directory of directories) syncDirectory(directory);
}
export function syncDirectory(directory) {
  if (process.platform === 'win32') { flushDirectories([directory]); return; }
  absoluteStat(directory, 'directory');
  let fd;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    fs.fsyncSync(fd);
  } catch (cause) {
    if (['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(cause.code)) throw unsupportedDirectorySync(cause);
    throw cause;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function durableRename(from, to) {
  if (statIfPresent(to)) throw new Error(`Refusing to overwrite owned transaction path: ${path.basename(to)}`);
  fs.renameSync(from, to);
  syncDirectory(path.dirname(from));
  if (path.dirname(from) !== path.dirname(to)) syncDirectory(path.dirname(to));
}
function assertArtifact(directory) {
  const problems = verifyArtifact(directory);
  if (problems.length) throw new Error(`Artifact does not verify: ${problems.slice(0, 5).join('; ')}`);
}
function snapshot(directory) {
  if (!statIfPresent(directory)) return null;
  assertArtifact(directory);
  const stat = absoluteStat(directory, 'directory');
  return { manifest: sha256File(path.join(directory, MANIFEST)), dev: String(stat.dev), ino: String(stat.ino) };
}
function identity(directory, expected) {
  if (!expected || !statIfPresent(directory)) return false;
  const stat = absoluteStat(directory, 'directory');
  return String(stat.dev) === expected.dev && String(stat.ino) === expected.ino && sha256File(path.join(directory, MANIFEST)) === expected.manifest;
}
function assertSnapshot(directory, expected) {
  if (expected === null) {
    if (statIfPresent(directory)) throw new Error(`Unexpected artifact at ${path.basename(directory)}`);
  } else {
    if (!identity(directory, expected)) throw new Error(`Artifact identity changed: ${path.basename(directory)}`);
    assertArtifact(directory);
  }
}
export function syncArtifact(directory) {
  const tree = inventory(directory);
  // FlushFileBuffers (Windows fsync) requires a write-access handle; contents are not written.
  const flags = process.platform === 'win32' ? fs.constants.O_RDWR : fs.constants.O_RDONLY;
  for (const relative of tree.files) {
    const fd = openRegular(path.join(directory, ...relative.split('/')), flags);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  const directories = tree.directories.sort((a, b) => b.split('/').length - a.split('/').length).map((relative) => path.join(directory, ...relative.split('/')));
  flushDirectories([...directories, directory, path.dirname(directory)]);
}
function saveJournal(root, journal) {
  const temporary = path.join(root, `.runtime-artifact-journal-${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(journal) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const destination = path.join(root, JOURNAL);
  if (statIfPresent(destination)) absoluteStat(destination, 'file');
  fs.renameSync(temporary, destination);
  syncDirectory(root);
}
function clearJournal(root) { fs.unlinkSync(path.join(root, JOURNAL)); syncDirectory(root); }
function validSnapshot(value) {
  return value === null || (record(value) && Object.keys(value).length === 3 && DIGEST.test(value.manifest ?? '') && /^\d+$/.test(value.dev ?? '') && /^\d+$/.test(value.ino ?? ''));
}
function stagingRelative(root, staging) {
  const relative = path.relative(root, path.resolve(staging)).split(path.sep).join('/');
  if (!safeRelative(relative) || ['current', 'previous'].includes(relative.split('/')[0]) || relative.split('/')[0].startsWith('.runtime-artifact-')) throw new Error('Staging must be an owned descendant of the artifact root outside current/previous/transaction paths');
  return relative;
}
function loadJournal(root) {
  const journal = readJson(path.join(root, JOURNAL), 64 * 1024);
  if (!record(journal) || journal.schema !== 1 || !UUID.test(journal.id ?? '') || !['promote', 'rollback'].includes(journal.operation) || !['planned', 'committed'].includes(journal.state) || !record(journal.before) || !validSnapshot(journal.before.current) || !validSnapshot(journal.before.previous) || !validSnapshot(journal.incoming)) throw new Error('Invalid artifact transaction journal');
  const allowed = ['schema', 'id', 'operation', 'state', 'before', 'incoming', 'staging'];
  if (Object.keys(journal).some((key) => !allowed.includes(key)) || Object.keys(journal.before).some((key) => !['current', 'previous'].includes(key))) throw new Error('Unknown artifact journal fields');
  if (journal.operation === 'promote') {
    if (!journal.incoming || typeof journal.staging !== 'string' || stagingRelative(root, path.join(root, ...journal.staging.split('/'))) !== journal.staging) throw new Error('Unsafe journal staging path');
  } else if (journal.incoming !== null || journal.staging !== null || journal.before.previous === null) throw new Error('Invalid rollback journal');
  return journal;
}
function transactionPaths(root, journal) {
  return { current: path.join(root, 'current'), previous: path.join(root, 'previous'),
    parked: path.join(root, `.runtime-artifact-${journal.id}-${journal.operation === 'promote' ? 'previous' : 'current'}`),
    staging: journal.staging === null ? null : path.join(root, ...journal.staging.split('/')) };
}
function ensureStagingParent(root, staging) {
  const relative = path.relative(root, path.dirname(staging));
  let directory = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    directory = path.join(directory, part);
    if (!statIfPresent(directory)) fs.mkdirSync(directory, { mode: 0o700 });
    absoluteStat(directory, 'directory');
  }
  syncDirectory(path.dirname(staging));
}
function recoverLocked(root) {
  if (!statIfPresent(path.join(root, JOURNAL))) return { recovered: false };
  const journal = loadJournal(root);
  const p = transactionPaths(root, journal);
  // All extant slots must be known immutable directory identities. This avoids
  // moving/removing a changed or unexpected tree when recovery is uncertain.
  const known = [journal.before.current, journal.before.previous, journal.incoming].filter(Boolean);
  for (const directory of [p.current, p.previous, p.parked, p.staging].filter(Boolean)) {
    if (statIfPresent(directory)) {
      if (!known.some((expected) => identity(directory, expected))) throw new Error(`Unknown artifact in transaction slot ${path.basename(directory)}`);
      assertArtifact(directory);
    }
  }
  if (journal.state === 'committed') {
    assertSnapshot(p.current, journal.operation === 'promote' ? journal.incoming : journal.before.previous);
    assertSnapshot(p.previous, journal.before.current);
    if (statIfPresent(p.parked)) {
      assertSnapshot(p.parked, journal.operation === 'promote' ? journal.before.previous : null);
      fs.rmSync(p.parked, { recursive: true }); syncDirectory(root);
    }
  } else if (journal.operation === 'promote') {
    if (identity(p.current, journal.incoming)) {
      ensureStagingParent(root, p.staging);
      durableRename(p.current, p.staging);
    }
    if (identity(p.previous, journal.before.current)) durableRename(p.previous, p.current);
    if (identity(p.parked, journal.before.previous)) durableRename(p.parked, p.previous);
    assertSnapshot(p.current, journal.before.current);
    assertSnapshot(p.previous, journal.before.previous);
    if (statIfPresent(p.parked)) throw new Error('Unexpected parked artifact after promotion recovery');
  } else {
    if (identity(p.previous, journal.before.current)) durableRename(p.previous, p.parked);
    if (identity(p.current, journal.before.previous)) durableRename(p.current, p.previous);
    if (identity(p.parked, journal.before.current)) durableRename(p.parked, p.current);
    assertSnapshot(p.current, journal.before.current);
    assertSnapshot(p.previous, journal.before.previous);
    if (statIfPresent(p.parked)) throw new Error('Unexpected parked artifact after rollback recovery');
  }
  clearJournal(root);
  return { recovered: true, operation: journal.operation, committed: journal.state === 'committed' };
}
/** Dedicated immutable-publisher lease held across asynchronous daemon control.
 * The OS owns its lifetime; stale PID files are never a lock authority. */
export function acquireArtifactLease(root) {
  root = path.resolve(root);
  absoluteStat(root, 'directory');
  const lease = path.join(root, LEASE);
  for (const suffix of ['', '-journal', '-wal', '-shm']) if (statIfPresent(lease + suffix)) absoluteStat(lease + suffix, 'file');
  let database;
  try {
    database = new DatabaseSync(lease);
    fs.chmodSync(lease, 0o600);
    database.exec('PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS artifact_lease (id INTEGER PRIMARY KEY CHECK(id = 1)); BEGIN EXCLUSIVE');
    let released = false;
    return { root, release() {
      if (released) return; released = true;
      try { database.exec('ROLLBACK'); } finally { database.close(); }
    } };
  } catch (error) {
    if (database) { try { database.exec('ROLLBACK'); } catch {} database.close(); }
    if (error.code === 'ERR_SQLITE_ERROR' && /locked|busy/i.test(error.message)) throw new Error('Runtime artifact is locked by another operation', { cause: error });
    throw error;
  }
}
function withLease(root, action) {
  const lease = acquireArtifactLease(root);
  try { return action(lease.root); } finally { lease.release(); }
}
/** Recover an interrupted helper operation before any build scratch cleanup. */
export function recoverArtifacts(root) { return withLease(root, recoverLocked); }
function transact(root, journal, work) {
  saveJournal(root, journal);
  try {
    work();
    journal.state = 'committed';
    saveJournal(root, journal);
    recoverLocked(root); // verifies committed slots and removes only owned backup
  } catch (error) {
    let recovered;
    try { recovered = recoverLocked(root); }
    catch (recoveryError) { throw new AggregateError([error, recoveryError], 'Artifact operation failed; recovery journal retained'); }
    error.activationCommitted = recovered.committed === true;
    error.recovered = recovered.recovered;
    throw error;
  }
  return path.join(root, 'current');
}
/** Journaled, exclusive promotion. Multiple renames are NOT one atomic swap. */
export function promote(root, staging) {
  return withLease(root, (owned) => {
    recoverLocked(owned);
    const relative = stagingRelative(owned, staging);
    staging = path.join(owned, ...relative.split('/'));
    const incoming = snapshot(staging);
    if (!incoming) throw new Error('Staging artifact is missing');
    const rootStat = absoluteStat(owned, 'directory');
    if (incoming.dev !== String(rootStat.dev)) throw new Error('Staging must be on the same filesystem');
    const journal = { schema: 1, id: crypto.randomUUID(), operation: 'promote', state: 'planned', before: { current: snapshot(path.join(owned, 'current')), previous: snapshot(path.join(owned, 'previous')) }, incoming, staging: relative };
    syncArtifact(staging);
    const p = transactionPaths(owned, journal);
    return transact(owned, journal, () => {
      if (journal.before.previous) durableRename(p.previous, p.parked);
      if (journal.before.current) durableRename(p.current, p.previous);
      durableRename(p.staging, p.current);
      assertSnapshot(p.current, incoming);
      assertSnapshot(p.previous, journal.before.current);
    });
  });
}
/** Journaled rollback of code only; this does not undo a runtime data migration. */
export function rollback(root) {
  return withLease(root, (owned) => {
    recoverLocked(owned);
    const journal = { schema: 1, id: crypto.randomUUID(), operation: 'rollback', state: 'planned', before: { current: snapshot(path.join(owned, 'current')), previous: snapshot(path.join(owned, 'previous')) }, incoming: null, staging: null };
    if (!journal.before.previous) throw new Error('No previous runtime artifact to roll back to');
    syncArtifact(path.join(owned, 'previous'));
    const p = transactionPaths(owned, journal);
    return transact(owned, journal, () => {
      if (journal.before.current) durableRename(p.current, p.parked);
      durableRename(p.previous, p.current);
      if (journal.before.current) durableRename(p.parked, p.previous);
      assertSnapshot(p.current, journal.before.previous);
      assertSnapshot(p.previous, journal.before.current);
    });
  });
}

/** Original remote launcher; remote installer/preparer are outside this proposal. */
export const REMOTE_LAUNCHER = `#!/bin/sh
# Enki Runtime launcher (remote Linux host). Generated by scripts/runtime/prepare.mjs.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE
exec "$here/node/bin/node" "$here/app/dist/main.js" "$@"
`;
