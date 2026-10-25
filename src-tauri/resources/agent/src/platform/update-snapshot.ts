// Exact paired snapshot of every mutable Pi SDK session file (JSONL), taken by
// the runtime inside backupForUpdate (held maintenance fence, confirmed idle,
// next to the SQLite backup) and verified/restored only by the trusted remote
// installer through the verified daemon-control bundle. SDK-free.
//
// Layout (fixed, derived from the backup id; the receipt carries no path):
//   <data>/update-backups/<id>/sessions/<relative>   copies
//   <data>/update-backups/<id>/sessions.json         manifest
// `<relative>` follows SESSION_LAYOUT (platform/paths.ts) exactly: SDK shard
// files `<sha16>/<name>` (manifest schema 1 and 2) and writable Pi CLI imports
// `pi-cli/pi-legacy-<48hex>/<name>` (schema 2 only). Journaled continuation
// staging must be empty under the idle fence and is never copied. Anything else
// fails closed. Originals and legacy import archives are never touched.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_LAYOUT, SESSION_LAYOUT } from "./paths.ts";

export interface SessionSnapshot { manifestSha256: string; files: number; bytes: number }
interface Entry { path: string; sha256: string; bytes: number }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const SNAPSHOT_LIMITS = Object.freeze({ files: 200_000, bytes: 16 * 1024 ** 3, manifest: 64 * 1024 * 1024 });
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const UNEXPECTED_ENTRY = "Хранилище сессий содержит неожиданный элемент; копия обновления не создана.";
const UNEXPECTED_FILE = "Хранилище сессий содержит неожиданный файл; копия обновления не создана.";

function sha256File(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW), hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
  try { for (;;) { const read = fs.readSync(fd, buffer); if (!read) break; hash.update(buffer.subarray(0, read)); } } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}
function fsyncFile(file: string): void { const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
/** Durable directory metadata. Windows needs a write-access directory handle for
 * FlushFileBuffers (libuv opens directories with backup semantics). */
export function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, process.platform === "win32" ? "r+" : fs.constants.O_RDONLY | NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
const exists = (file: string) => { try { fs.lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };
function backupDirectory(data: string, id: string): string {
  if (!UUID.test(id)) throw new Error("Invalid update backup id");
  return path.join(data, DATA_LAYOUT.backups, id);
}
/** Sorted names of a real (non-link) directory. */
function listDirectory(directory: string): string[] {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(UNEXPECTED_ENTRY);
  return fs.readdirSync(directory).sort();
}

/** True for a manifest path inside SESSION_LAYOUT; schema 1 has shard files only. */
export function validSessionPath(relative: string, schema: 1 | 2): boolean {
  const parts = relative.split("/");
  if (parts.length === 2) return SESSION_LAYOUT.shard.test(parts[0]!) && SESSION_LAYOUT.file.test(parts[1]!);
  return schema === 2 && parts.length === 3 && parts[0] === SESSION_LAYOUT.piCli
    && SESSION_LAYOUT.piCliSession.test(parts[1]!) && SESSION_LAYOUT.file.test(parts[2]!);
}

/** Every mutable session file under the live store, as sorted relative paths.
 * Throws on anything outside SESSION_LAYOUT (links, sockets, stray files). */
export function liveSessionFiles(live: string): string[] {
  const files: string[] = [];
  const regular = (directory: string, prefix: string, name: string) => {
    if (!SESSION_LAYOUT.file.test(name) || !fs.lstatSync(path.join(directory, name)).isFile()) throw new Error(UNEXPECTED_FILE);
    files.push(`${prefix}/${name}`);
  };
  if (!exists(live)) return files;
  for (const key of listDirectory(live)) {
    const directory = path.join(live, key);
    if (SESSION_LAYOUT.shard.test(key)) {
      for (const name of listDirectory(directory)) {
        // Staging is journaled and rolled back/cleaned by startup recovery; a
        // leftover is never authoritative, but it is not silently skipped either.
        if (name === SESSION_LAYOUT.continuationStaging) {
          if (listDirectory(path.join(directory, name)).length) throw new Error("Незавершённое продолжение архивного чата ещё не восстановлено; перезапустите Enki и повторите обновление.");
          continue;
        }
        regular(directory, key, name);
      }
    } else if (key === SESSION_LAYOUT.piCli) {
      for (const id of listDirectory(directory)) {
        if (!SESSION_LAYOUT.piCliSession.test(id)) throw new Error(UNEXPECTED_ENTRY);
        for (const name of listDirectory(path.join(directory, id))) regular(path.join(directory, id), `${key}/${id}`, name);
      }
    } else throw new Error(UNEXPECTED_ENTRY);
  }
  return files;
}

/** Parent directories of `files` below `root`, deepest first, then `root`. */
function parents(root: string, files: string[]): string[] {
  const set = new Set<string>();
  for (const file of files) for (let dir = path.posix.dirname(file); dir !== "."; dir = path.posix.dirname(dir)) set.add(dir);
  return [...[...set].sort((a, b) => b.split("/").length - a.split("/").length).map(dir => path.join(root, ...dir.split("/"))), root];
}

/** Copy every session file next to the SQLite backup and write its manifest.
 * Throws (never a partial success) on unexpected entries or limits. */
export function snapshotSessions(data: string, id: string): SessionSnapshot {
  const live = path.join(data, DATA_LAYOUT.sessions), directory = backupDirectory(data, id), target = path.join(directory, DATA_LAYOUT.sessions);
  const files = liveSessionFiles(live), entries: Entry[] = []; let bytes = 0;
  fs.mkdirSync(target, { mode: 0o700 });
  for (const relative of files) {
    const parts = relative.split("/"), copy = path.join(target, ...parts);
    fs.mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(live, ...parts), copy, fs.constants.COPYFILE_EXCL); fs.chmodSync(copy, 0o600); fsyncFile(copy);
    const size = fs.statSync(copy).size; bytes += size;
    if (entries.length >= SNAPSHOT_LIMITS.files || bytes > SNAPSHOT_LIMITS.bytes) throw new Error("Сессии превышают предел копии обновления.");
    entries.push({ path: relative, sha256: sha256File(copy), bytes: size });
  }
  for (const dir of parents(target, files)) syncDirectory(dir);
  // Schema 1 stays byte-compatible for shard-only stores; nested Pi CLI paths need 2.
  const schema = files.some(file => !validSessionPath(file, 1)) ? 2 : 1;
  const text = JSON.stringify({ schema, files: entries }) + "\n", manifest = fs.openSync(path.join(directory, "sessions.json"), "wx", 0o600);
  try { fs.writeFileSync(manifest, text); fs.fsyncSync(manifest); } finally { fs.closeSync(manifest); }
  return { manifestSha256: createHash("sha256").update(text).digest("hex"), files: entries.length, bytes };
}

export function validSnapshot(value: unknown): value is SessionSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join() === "bytes,files,manifestSha256" && typeof v.manifestSha256 === "string" && /^[a-f0-9]{64}$/.test(v.manifestSha256)
    && Number.isSafeInteger(v.files) && (v.files as number) >= 0 && Number.isSafeInteger(v.bytes) && (v.bytes as number) >= 0;
}

/** Every regular file below a snapshot copy root; links/other kinds fail. */
function copiedFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of listDirectory(root)) {
    const full = path.join(root, name), stat = fs.lstatSync(full), relative = prefix ? `${prefix}/${name}` : name;
    if (stat.isDirectory()) out.push(...copiedFiles(full, relative));
    else if (stat.isFile()) out.push(relative);
    else throw new Error("Paired session snapshot has unlisted files");
  }
  return out;
}

/** Authenticate manifest (hash from the paired receipt), exact entry set and
 * every copy's size/hash; the snapshot directory must contain nothing else. */
export function verifySessionSnapshot(data: string, id: string, expected: SessionSnapshot): Entry[] {
  if (!validSnapshot(expected)) throw new Error("Invalid paired session snapshot receipt");
  const directory = backupDirectory(data, id), manifestFile = path.join(directory, "sessions.json");
  if (!fs.lstatSync(manifestFile).isFile() || fs.statSync(manifestFile).size > SNAPSHOT_LIMITS.manifest) throw new Error("Paired session manifest is invalid");
  const text = fs.readFileSync(manifestFile);
  if (createHash("sha256").update(text).digest("hex") !== expected.manifestSha256) throw new Error("Paired session manifest authentication failed");
  const parsed = JSON.parse(text.toString("utf8")) as { schema?: unknown; files?: unknown };
  if ((parsed?.schema !== 1 && parsed?.schema !== 2) || !Array.isArray(parsed.files) || Object.keys(parsed).length !== 2) throw new Error("Paired session manifest is invalid");
  const schema: 1 | 2 = parsed.schema === 2 ? 2 : 1, entries = parsed.files as Entry[], seen = new Set<string>(), root = path.join(directory, DATA_LAYOUT.sessions); let bytes = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Paired session manifest is invalid");
    if (Object.keys(entry).sort().join() !== "bytes,path,sha256" || typeof entry.path !== "string" || !validSessionPath(entry.path, schema) || seen.has(entry.path)
      || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error("Paired session manifest is invalid");
    seen.add(entry.path); bytes += entry.bytes;
    const copy = path.join(root, ...entry.path.split("/"));
    if (!fs.lstatSync(copy).isFile() || fs.statSync(copy).size !== entry.bytes || sha256File(copy) !== entry.sha256) throw new Error("Paired session snapshot integrity failed");
  }
  if (entries.length !== expected.files || bytes !== expected.bytes) throw new Error("Paired session snapshot does not match its receipt");
  for (const file of copiedFiles(root)) if (!seen.has(file)) throw new Error("Paired session snapshot has unlisted files");
  return entries;
}

/** Installer only, with the start AND lifetime leases held (no runtime can
 * write): stage verified copies, move the live session store into `preserved`
 * (never deleted or merged), then rename the staged store into place. Empty
 * continuation staging directories are recreated by startup recovery. */
export function restoreSessionSnapshot(data: string, id: string, expected: SessionSnapshot, preserved: string): void {
  const entries = verifySessionSnapshot(data, id, expected), source = path.join(backupDirectory(data, id), DATA_LAYOUT.sessions);
  const staging = path.join(data, `.restore-sessions-${randomUUID()}`), live = path.join(data, DATA_LAYOUT.sessions);
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    for (const entry of entries) {
      const parts = entry.path.split("/"), copy = path.join(staging, ...parts);
      fs.mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(source, ...parts), copy, fs.constants.COPYFILE_EXCL); fs.chmodSync(copy, 0o600); fsyncFile(copy);
      if (sha256File(copy) !== entry.sha256) throw new Error("Paired session snapshot changed during restoration");
    }
    for (const dir of parents(staging, entries.map(entry => entry.path))) syncDirectory(dir);
    fs.mkdirSync(preserved, { recursive: true, mode: 0o700 });
    const aside = path.join(preserved, DATA_LAYOUT.sessions), moved = exists(live);
    if (moved) { fs.renameSync(live, aside); syncDirectory(preserved); }
    try { fs.renameSync(staging, live); }
    catch (error) { if (moved && !exists(live)) fs.renameSync(aside, live); throw error; }
    syncDirectory(data);
  } finally { if (exists(staging)) fs.rmSync(staging, { recursive: true, force: true }); }
}
