// Read-only importer of former Pi CLI transcripts into writable Enki sessions
// (SESSION_LAYOUT.piCli). The source file is never modified; an immutable
// archive copy plus journal makes every publication restart-safe.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson, type PermissionRule } from "../protocol.ts";
import { SESSION_LAYOUT } from "../platform/paths.ts";
import { validRules, type SessionCatalog } from "../sessions/catalog.ts";
import { text, type Database } from "../store/db.ts";
import { absoluteDirectory, MAX_TRANSCRIPT_BYTES, object, runtimePiBytes, validatePiBytes, validPiId } from "./pi-jsonl.ts";
import { cleanupIssue, directory, HASH, identity, JOB, readStable, shaBytes, shaFile, syncDirectory, unchanged, validOrigin, writeOwned } from "./files.ts";

export interface PiCliMeta {
  id: string; directory: string; title: string; created: number; updated: number;
  archived?: number; permission?: PermissionRule[];
}
/** Same shape as the protocol's pi-cli SessionOrigin member. */
export interface PiCliOrigin {
  kind: "pi-cli"; source: string; sourceOrigin: string; legacyId: string;
  archive: string; runtimeId: string;
}
export interface PiManifest {
  version: 1; kind: "pi-cli"; id: string; job: string; importer: "enki-pi-cli/1";
  createdAt: number;
  source: { path: string; origin: string; sessionId: string; cwd: string; sha256: string; size: number; version: number };
  runtime: { id: string; seedSha256: string; seedSize: number; entryMap: Record<string, string>; leafId: string | null };
  counts: Record<string, number>;
}
interface Detail { version: 1; origin: string; legacyId: string; runtimeId: string; archive?: string; lastPhase?: string; cleanup?: string[]; errorCode?: string }
export interface PiImportResult { id: string; archive: string; created: boolean; skipped: "already-imported" | "tombstone" | null }
export interface PiImportRoots { archives: string; staging: string; sessions: string }
const active = new WeakSet<Database>();

export function legacyPiSessionId(origin: string, id: string): string {
  return `pi-legacy-${createHash("sha256").update(origin).update("\0").update(id).digest("hex").slice(0, 48)}`;
}
export function legacyPiDigest(directory: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(directory)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, "0");
}
function archiveId(origin: string, legacyId: string, hash: string): string {
  return createHash("sha256").update(origin).update("\0").update(legacyId).update("\0").update(hash).digest("hex");
}
function manifestOf(value: unknown): PiManifest {
  if (!object(value) || value.version !== 1 || value.kind !== "pi-cli" || value.importer !== "enki-pi-cli/1"
    || typeof value.id !== "string" || !HASH.test(value.id) || typeof value.job !== "string" || !JOB.test(value.job)
    || !object(value.source) || !object(value.runtime) || !object(value.counts)) throw new Error("Формат архива Pi не распознан.");
  const s = value.source, r = value.runtime;
  if (typeof s.path !== "string" || !absoluteDirectory(s.path) || typeof s.origin !== "string" || !validOrigin(s.origin)
    || !validPiId(s.sessionId) || !absoluteDirectory(s.cwd) || typeof s.sha256 !== "string" || !HASH.test(s.sha256)
    || !Number.isSafeInteger(s.size) || Number(s.size) < 1 || Number(s.size) > MAX_TRANSCRIPT_BYTES || ![1, 2, 3].includes(Number(s.version))
    || r.id !== legacyPiSessionId(s.origin, s.sessionId) || typeof r.seedSha256 !== "string" || !HASH.test(r.seedSha256)
    || !Number.isSafeInteger(r.seedSize) || Number(r.seedSize) < 1 || !object(r.entryMap)
    || !Object.values(r.entryMap).every(validPiId) || !(r.leafId === null || validPiId(r.leafId))
    || !Object.values(value.counts).every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
    || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0 || archiveId(s.origin, s.sessionId, s.sha256) !== value.id)
    throw new Error("Привязка архива Pi к источнику повреждена.");
  return value as unknown as PiManifest;
}
function detailOf(raw: string): Detail {
  const value: unknown = JSON.parse(raw);
  if (!object(value) || value.version !== 1 || typeof value.origin !== "string" || !validOrigin(value.origin)
    || !validPiId(value.legacyId) || value.runtimeId !== legacyPiSessionId(value.origin, value.legacyId)
    || value.archive !== undefined && (typeof value.archive !== "string" || !HASH.test(value.archive))) throw new Error("Журнал импорта Pi повреждён.");
  return value as unknown as Detail;
}

/** Runtime is sole DB/JSONL writer under the final host's OS lease. */
export class PiCliImporter {
  private readonly roots: PiImportRoots;
  constructor(private readonly db: Database, private readonly catalog: SessionCatalog, roots: PiImportRoots) {
    this.roots = { archives: directory(roots.archives, true), staging: directory(roots.staging, true), sessions: directory(roots.sessions, true) };
    const values = Object.values(this.roots);
    for (const [index, a] of values.entries()) for (const b of values.slice(index + 1))
      if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) throw new Error("Архив, staging и рабочие сессии должны быть раздельными каталогами.");
  }
  private archiveDir(id: string): string { if (!HASH.test(id)) throw new Error("Неверный архив Pi."); return path.join(this.roots.archives, id); }
  runtimeFile(id: string): string { if (!SESSION_LAYOUT.piCliSession.test(id)) throw new Error("Неверная runtime identity Pi."); return path.join(this.roots.sessions, id, SESSION_LAYOUT.piCliTranscript); }
  archiveFile(id: string): string { return path.join(this.archiveDir(id), "original.jsonl"); }
  private journal(job: string, state: string, detail: Detail): void {
    this.db.run("INSERT INTO migration_journal(id,kind,state,detail,started,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,detail=excluded.detail,updated=excluded.updated",
      job, "pi-cli", state, JSON.stringify(detail), Date.now(), Date.now());
  }
  private verify(id: string, expected: { origin?: string; job?: string } = {}): PiManifest {
    const root = directory(this.archiveDir(id)), manifest = manifestOf(JSON.parse(readStable(path.join(root, "manifest.json"), 16 * 1024 * 1024).toString("utf8")));
    const original = readStable(this.archiveFile(id), MAX_TRANSCRIPT_BYTES);
    if (manifest.id !== id || manifest.source.sha256 !== shaBytes(original) || manifest.source.size !== original.length
      || expected.origin !== undefined && expected.origin !== manifest.source.origin || expected.job !== undefined && expected.job !== manifest.job)
      throw new Error("Сохранённый архив Pi изменён.");
    const parsed = validatePiBytes(original, { id: manifest.source.sessionId, cwd: manifest.source.cwd });
    const seed = runtimePiBytes(parsed, manifest.runtime.id, manifest.source.origin);
    if (seed.bytes.length !== manifest.runtime.seedSize || shaBytes(seed.bytes) !== manifest.runtime.seedSha256
      || canonicalJson(seed.entryMap) !== canonicalJson(manifest.runtime.entryMap) || canonicalJson(parsed.counts) !== canonicalJson(manifest.counts)
      || manifest.runtime.leafId !== (parsed.version === 1 ? Object.values(seed.entryMap).at(-1) ?? null : parsed.leafId))
      throw new Error("Рабочая проекция архива Pi не совпадает с манифестом.");
    const trusted = this.db.get("SELECT kind,manifest FROM legacy_archives WHERE id=?", id);
    if (trusted && (trusted.kind !== "pi-cli" || canonicalJson(manifestOf(JSON.parse(text(trusted, "manifest")))) !== canonicalJson(manifest)))
      throw new Error("Манифест Pi не совпадает с доверенным реестром.");
    return manifest;
  }
  private verifyWorking(manifest: PiManifest, exact: boolean): void {
    const file = this.runtimeFile(manifest.runtime.id), root = directory(path.dirname(file));
    const owner: unknown = JSON.parse(readStable(path.join(root, SESSION_LAYOUT.piCliOwnership), 1024 * 1024).toString("utf8"));
    if (!object(owner) || owner.archive !== manifest.id || owner.job !== manifest.job || owner.runtimeId !== manifest.runtime.id)
      throw new Error("Рабочая копия Pi принадлежит другому импорту.");
    const bytes = readStable(file, MAX_TRANSCRIPT_BYTES);
    const source = validatePiBytes(readStable(this.archiveFile(manifest.id), MAX_TRANSCRIPT_BYTES));
    const seed = runtimePiBytes(source, manifest.runtime.id, manifest.source.origin).bytes;
    if (exact ? shaBytes(bytes) !== manifest.runtime.seedSha256 : bytes.length < seed.length || !bytes.subarray(0, seed.length).equals(seed))
      throw new Error("Существующая рабочая копия Pi повреждена; она не будет перезаписана.");
    validatePiBytes(bytes, { id: manifest.runtime.id, cwd: manifest.source.cwd });
  }
  private prior(id: string, origin: string, legacyId: string): { tombstone: boolean; manifest: PiManifest } | null {
    const row = this.db.get("SELECT origin,deleted,session_file FROM sessions WHERE id=?", id);
    if (!row) return null;
    const value: unknown = JSON.parse(text(row, "origin"));
    if (!object(value) || value.kind !== "pi-cli" || value.sourceOrigin !== origin || value.legacyId !== legacyId
      || value.runtimeId !== id || typeof value.archive !== "string" || !HASH.test(value.archive)) throw new Error("Identity Pi занята другой сессией.");
    const manifest = this.verify(value.archive, { origin });
    if (manifest.runtime.id !== id || manifest.source.sessionId !== legacyId || row.session_file !== this.runtimeFile(id)) throw new Error("Источник существующей сессии Pi не совпадает.");
    return { tombstone: row.deleted !== undefined && row.deleted !== null, manifest };
  }
  /** Never runs a conversation, tool, SDK or ambient resource discovery. */
  async import(source: string, meta: PiCliMeta, options: { origin: string }): Promise<PiImportResult> {
    if (active.has(this.db)) throw new Error("Импорт Pi ещё выполняется.");
    active.add(this.db);
    try { return await this.importOwned(source, meta, options); }
    finally { active.delete(this.db); }
  }
  private async importOwned(source: string, meta: PiCliMeta, options: { origin: string }): Promise<PiImportResult> {
    if (!path.isAbsolute(source) || !validOrigin(options.origin) || !validPiId(meta.id) || !absoluteDirectory(meta.directory)
      || ![meta.created, meta.updated].every(n => Number.isSafeInteger(n) && n >= 0) || typeof meta.title !== "string"
      || meta.archived !== undefined && (!Number.isSafeInteger(meta.archived) || meta.archived < 0)
      || meta.permission !== undefined && !validRules(meta.permission)) throw new Error("Метаданные импорта Pi не прошли проверку.");
    if (this.db.get("SELECT id FROM migration_journal WHERE kind='pi-cli' AND state IN ('staging','snapshotted','verified','publishing')")) throw new Error("Сначала завершите восстановление прежнего импорта Pi.");
    const canonical = fs.realpathSync(source), origin = options.origin, id = legacyPiSessionId(origin, meta.id), job = randomUUID();
    // Canonicalizing is not permission to read through a file symlink.
    if (fs.lstatSync(source).isSymbolicLink()) throw new Error("Источник Pi не может быть символической ссылкой.");
    const staging = path.join(this.roots.staging, job), runtimeDir = path.dirname(this.runtimeFile(id));
    let detail: Detail = { version: 1, origin, legacyId: meta.id, runtimeId: id }, publishedArchive = false, publishedWorking = false;
    this.journal(job, "staging", detail);
    try {
      fs.mkdirSync(staging, { mode: 0o700 });
      const archiveStage = path.join(staging, "archive"), workingStage = path.join(staging, "working");
      fs.mkdirSync(archiveStage, { mode: 0o700 }); fs.mkdirSync(workingStage, { mode: 0o700 });
      const bytes = readStable(canonical, MAX_TRANSCRIPT_BYTES), snapshot = path.join(archiveStage, "original.jsonl");
      writeOwned(snapshot, bytes, true);
      const before = identity(snapshot), sourceHash = shaBytes(bytes), contentId = archiveId(origin, meta.id, sourceHash);
      detail = { ...detail, archive: contentId };
      this.journal(job, "snapshotted", detail);
      // Yield only after the immutable copy exists; tests exercise real late replacement.
      await new Promise<void>(resolve => setImmediate(resolve));
      const parsed = validatePiBytes(readStable(snapshot, MAX_TRANSCRIPT_BYTES), { id: meta.id, cwd: meta.directory });
      unchanged(snapshot, before, sourceHash);
      const prior = this.prior(id, origin, meta.id);
      if (prior) {
        if (!prior.tombstone) {
          this.verifyWorking(prior.manifest, false);
          if (prior.manifest.id !== contentId) throw new Error("После первого импорта оригинал Pi изменился. Автоматическое слияние с рабочей сессией запрещено.");
        }
        fs.rmSync(staging, { recursive: true }); this.journal(job, "committed", { ...detail, archive: prior.manifest.id });
        return { id, archive: prior.manifest.id, created: false, skipped: prior.tombstone ? "tombstone" : "already-imported" };
      }
      if (fs.existsSync(runtimeDir)) throw new Error("Рабочий путь Pi уже существует без доверенной регистрации.");
      const runtime = runtimePiBytes(parsed, id, origin);
      const manifest: PiManifest = { version: 1, kind: "pi-cli", id: contentId, job, importer: "enki-pi-cli/1", createdAt: Date.now(),
        source: { path: canonical, origin, sessionId: meta.id, cwd: meta.directory, sha256: sourceHash, size: bytes.length, version: parsed.version },
        runtime: { id, seedSha256: shaBytes(runtime.bytes), seedSize: runtime.bytes.length, entryMap: runtime.entryMap,
          leafId: parsed.version === 1 ? Object.values(runtime.entryMap).at(-1) ?? null : parsed.leafId }, counts: parsed.counts };
      writeOwned(path.join(archiveStage, "manifest.json"), JSON.stringify(manifest, null, 2), true);
      writeOwned(path.join(workingStage, SESSION_LAYOUT.piCliTranscript), runtime.bytes, false);
      writeOwned(path.join(workingStage, SESSION_LAYOUT.piCliOwnership), JSON.stringify({ archive: contentId, job, runtimeId: id }), true);
      syncDirectory(archiveStage); syncDirectory(workingStage); syncDirectory(staging);
      unchanged(snapshot, before, sourceHash);
      this.journal(job, "verified", detail);
      if (fs.existsSync(this.archiveDir(contentId))) throw new Error("Архив Pi уже существует без завершённого журнала.");
      this.journal(job, "publishing", detail);
      fs.renameSync(archiveStage, this.archiveDir(contentId)); publishedArchive = true; syncDirectory(this.roots.archives);
      fs.renameSync(workingStage, runtimeDir); publishedWorking = true; syncDirectory(this.roots.sessions);
      this.db.transaction(() => {
        this.db.run("INSERT INTO legacy_archives(id,kind,manifest,created) VALUES(?,?,?,?)", contentId, "pi-cli", JSON.stringify(manifest), manifest.createdAt);
        const provenance: PiCliOrigin = { kind: "pi-cli", source: canonical, sourceOrigin: origin, legacyId: meta.id, archive: contentId, runtimeId: id };
        this.catalog.insert({ id, directory: meta.directory, title: meta.title || "Чат Pi", created: meta.created, updated: meta.updated,
          archived: meta.archived ?? null, permission: meta.permission ?? null, parentId: null,
          sessionFile: this.runtimeFile(id), origin: provenance, workshop: false, model: null });
        this.journal(job, "committed", detail);
      });
      fs.rmSync(staging, { recursive: true });
      return { id, archive: contentId, created: true, skipped: null };
    } catch (error) {
      let committed = false, inspected = false, lastPhase = "unknown";
      const cleanup: string[] = [];
      try { lastPhase = text(this.db.get("SELECT state FROM migration_journal WHERE id=?", job), "state");
        committed = !!detail.archive && !!this.db.get("SELECT id FROM legacy_archives WHERE id=?", detail.archive); inspected = true; }
      catch (cause) { cleanup.push(cleanupIssue("inspect", cause)); }
      if (inspected && !committed && detail.archive && (publishedArchive || publishedWorking)) {
        try { this.removePublished(detail, job, publishedWorking); } catch (cause) { cleanup.push(cleanupIssue("published", cause)); }
      }
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch (cause) { cleanup.push(cleanupIssue("staging", cause)); }
      try { this.journal(job, committed ? cleanup.length ? "cleanup_pending" : "committed" : "failed", { ...detail, lastPhase, cleanup, errorCode: error instanceof Error ? error.name : "ERROR" }); } catch { /* original failure wins */ }
      throw error;
    }
  }
  private removePublished(detail: Detail, job: string, workingMayExist = true): void {
    if (!detail.archive) return;
    const archive = this.archiveDir(detail.archive), runtimeDir = path.dirname(this.runtimeFile(detail.runtimeId));
    // Do not delete a writable session without proving exact, uncommitted seed.
    if (workingMayExist && fs.existsSync(runtimeDir)) {
      const manifest = this.verify(detail.archive, { origin: detail.origin, job });
      this.verifyWorking(manifest, true);
      fs.rmSync(runtimeDir, { recursive: true }); syncDirectory(this.roots.sessions);
    }
    if (fs.existsSync(archive)) { this.verify(detail.archive, { origin: detail.origin, job }); fs.rmSync(archive, { recursive: true }); syncDirectory(this.roots.archives); }
  }
  recover(): void {
    if (active.has(this.db)) throw new Error("Импорт Pi ещё выполняется; восстановление подождёт.");
    for (const row of this.db.all("SELECT id,detail FROM migration_journal WHERE kind='pi-cli' AND state NOT IN ('committed','rolled_back')")) {
      const job = text(row, "id");
      if (!JOB.test(job)) throw new Error("Неизвестная версия журнала Pi; требуется отдельная миграция.");
      const detail = detailOf(text(row, "detail"));
      if (detail.archive && this.db.get("SELECT id FROM legacy_archives WHERE id=?", detail.archive)) {
        const manifest = this.verify(detail.archive, { origin: detail.origin });
        const prior = this.prior(detail.runtimeId, detail.origin, detail.legacyId);
        if (!prior || prior.manifest.id !== manifest.id) throw new Error("Архив Pi зарегистрирован без своей сессии.");
        if (!prior.tombstone) this.verifyWorking(manifest, false);
        fs.rmSync(path.join(this.roots.staging, job), { recursive: true, force: true });
        this.journal(job, "committed", detail);
      } else {
        this.removePublished(detail, job);
        fs.rmSync(path.join(this.roots.staging, job), { recursive: true, force: true });
        this.journal(job, "rolled_back", detail);
      }
    }
  }
}
