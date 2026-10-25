// Explicit OpenCode history import into an immutable app-owned archive (wired
// by core/runtime.ts; journaled, recovered at startup before any worker).
// An online SQLite read snapshot includes committed WAL frames. Originals are
// never renamed, rewritten, checkpointed or opened for writing.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { LegacyArchiveDTO, SessionOrigin } from "../protocol.ts";
import { canonicalJson } from "../protocol.ts";
import { text, type Database, type Row } from "../store/db.ts";
import { validRules, type SessionCatalog, type SessionRecord } from "../sessions/catalog.ts";
import { ArchiveDataError, OpenCodeArchiveReader, type LegacySession } from "./opencode-reader.ts";
import { syncOwnedDirectory as syncDirectory, syncOwnedFile as syncFile } from "../platform/owned-sync.ts";

export const IMPORTER = "enki-opencode-import/2";
const HASH = /^[a-f0-9]{64}$/;
const JOB = /^[a-f0-9-]{36}$/;
// A runtime Database has one writer owner. This also fences a second importer
// instance using that same owner while async backup/validation yields.
const activeImports = new WeakSet<Database>();

export interface ArchiveManifest {
  id: string;
  kind: "opencode";
  importer: string;
  createdAt: number;
  job: string;
  source: { path: string; origin: string; acquisition: "sqlite-read-snapshot" };
  snapshot: { file: "snapshot.sqlite"; sha256: string; size: number };
  counts: Record<string, number>;
  sessions: number;
}

interface JournalDetail { version: 2; origin?: string; archive?: string; error?: string; lastPhase?: string; cleanup?: string[] }
export interface ImportResult { archive: LegacyArchiveDTO; created: boolean; imported: number; updated: number }

function shaFile(file: string): string {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
}

function manifestOf(value: unknown): ArchiveManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Манифест архива повреждён.");
  const m = value as Partial<ArchiveManifest>;
  if (typeof m.id !== "string" || !HASH.test(m.id) || m.kind !== "opencode"
    || typeof m.job !== "string" || !JOB.test(m.job)
    || m.source?.acquisition !== "sqlite-read-snapshot" || typeof m.source.origin !== "string" || !validOrigin(m.source.origin)
    || typeof m.source.path !== "string" || m.snapshot?.file !== "snapshot.sqlite"
    || typeof m.snapshot.sha256 !== "string" || !HASH.test(m.snapshot.sha256) || !Number.isSafeInteger(m.snapshot.size) || m.snapshot.size < 1
    || !Number.isSafeInteger(m.sessions) || (m.sessions ?? -1) < 0 || !m.counts || typeof m.counts !== "object" || Array.isArray(m.counts)
    || !Object.values(m.counts).every(count => Number.isSafeInteger(count) && count >= 0)
    || !Number.isSafeInteger(m.createdAt) || (m.createdAt ?? -1) < 0 || typeof m.importer !== "string")
    throw new Error("Манифест архива имеет неизвестный формат.");
  if (archiveIdentity(m.source.origin, m.snapshot.sha256) !== m.id)
    throw new Error("Идентификатор архива не соответствует источнику и SHA256 снимка.");
  return m as ArchiveManifest;
}

function dto(m: ArchiveManifest): LegacyArchiveDTO {
  return { id: m.id, kind: m.kind, createdAt: m.createdAt, source: m.source.path,
    sha256: m.snapshot.sha256, counts: m.counts, importer: m.importer, sessions: m.sessions };
}

function journalDetail(raw: string): JournalDetail | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const d = value as Partial<JournalDetail>;
    return d.version === 2 && (d.archive === undefined || typeof d.archive === "string" && HASH.test(d.archive))
      && (d.origin === undefined || typeof d.origin === "string" && validOrigin(d.origin)) ? d as JournalDetail : null;
  } catch { return null; }
}

function validOrigin(origin: string): boolean { return !!origin && origin.length <= 512 && !/[\u0000-\u001f]/.test(origin); }
function archiveIdentity(origin: string, snapshotSha: string): string {
  return createHash("sha256").update(origin).update("\0").update(snapshotSha).digest("hex");
}
function snapshotIdentity(file: string): fs.BigIntStats {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Снимок истории подменён или имеет неверный тип.");
  return stat;
}
function unchangedSnapshot(file: string, before: fs.BigIntStats, expectedSha: string): void {
  const after = snapshotIdentity(file);
  if ((["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const).some(key => before[key] !== after[key])
    || shaFile(file) !== expectedSha)
    throw new Error("Снимок истории изменён или подменён во время проверки; импорт отменён.");
}
function cleanupIssue(action: string, error: unknown): string {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : "ERROR";
  return `${action}:${code}`;
}

/** Identity belongs to the source installation, not a content hash or old id. */
export function legacySessionId(origin: string, legacyId: string): string {
  return `legacy-${createHash("sha256").update(origin).update("\0").update(legacyId).digest("hex").slice(0, 48)}`;
}

/** Returns only after SQLite's consistent read view has been backed up. */
export async function snapshotSource(source: string, destination: string): Promise<void> {
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Источник истории должен быть обычной базой SQLite.");
  const reader = new DatabaseSync(source, { readOnly: true });
  try {
    reader.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN;");
    // Establish the read transaction before backup starts; a concurrent writer
    // can append to WAL, but cannot change this reader's logical snapshot.
    reader.prepare("SELECT COUNT(*) AS n FROM sqlite_schema").get();
    await backup(reader, destination, { rate: 256 });
    reader.exec("ROLLBACK;");
  } finally { reader.close(); }
  fs.chmodSync(destination, 0o600);
  const check = new DatabaseSync(destination, { readOnly: true });
  try {
    const integrity = check.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok")
      throw new Error("Согласованная копия истории не прошла integrity_check.");
    const foreign = check.prepare("PRAGMA foreign_key_check").all();
    if (foreign.length) throw new Error("В истории есть потерянные ссылки; импорт остановлен без изменения оригинала.");
  } finally { check.close(); }
  syncFile(destination);
}

export class OpenCodeImporter {
  constructor(private readonly db: Database, private readonly catalog: SessionCatalog,
    private readonly legacyDir: string, private readonly stagingDir: string) {}

  archiveFile(id: string): string {
    if (!HASH.test(id)) throw new Error("Некорректный архив.");
    return path.join(this.legacyDir, id, "snapshot.sqlite");
  }

  archives(): LegacyArchiveDTO[] {
    return this.db.all("SELECT manifest FROM legacy_archives WHERE kind='opencode' ORDER BY created")
      .map((row) => dto(manifestOf(JSON.parse(text(row, "manifest")))));
  }

  /** Read-only identity bridge for a saved pre-2.0 pointer. The source path is
   * supervisor-owned, never a client option. Exact SQL lookup is independent of
   * paged UI catalogs; a second match is ambiguity, never a title preference. */
  resolveSession(sourceDb: string, legacyId: string, directory: string): SessionRecord {
    let canonical: string;
    try { canonical = fs.realpathSync(sourceDb); }
    catch { throw new Error("Источник истории OpenCode пока недоступен. Повторите импорт; прежняя привязка мастерской сохранена."); }
    const origin = createHash("sha256").update(canonical).digest("hex");
    let matches: Row[];
    try {
      matches = this.db.all(`SELECT s.id FROM sessions s JOIN legacy_archives a ON a.id=json_extract(s.origin,'$.archive')
        WHERE s.deleted IS NULL AND s.directory=? AND json_extract(s.origin,'$.kind')='opencode'
        AND json_extract(s.origin,'$.legacyId')=? AND a.kind='opencode' AND json_extract(a.manifest,'$.source.origin')=? LIMIT 2`,
        directory, legacyId, origin);
    } catch { throw new Error("Реестр импортированной истории пока недоступен. Прежняя привязка мастерской сохранена."); }
    if (!matches.length) throw new Error("Сохранённая мастерская ещё не найдена в импортированной истории этого компьютера. Повторите импорт; пустой чат не создавался.");
    if (matches.length !== 1) throw new Error("Найдено несколько архивов сохранённой мастерской. Прежняя привязка сохранена; требуется проверка истории.");
    const candidate = this.catalog.get(text(matches[0], "id"));
    if (!candidate || candidate.id !== legacySessionId(origin, legacyId) || candidate.directory !== directory
      || candidate.origin.kind !== "opencode" || candidate.origin.legacyId !== legacyId
      || candidate.origin.sourceOrigin !== undefined && candidate.origin.sourceOrigin !== origin)
      throw new Error("Происхождение сохранённой мастерской не совпало с источником. Прежняя привязка сохранена.");
    try {
      const manifest = this.verifiedManifest(candidate.origin.archive, { origin });
      if (manifest.source.path !== canonical) throw new Error("Source mismatch");
    } catch {
      throw new Error("Архив сохранённой мастерской не прошёл проверку. Повторите импорт истории; прежняя привязка сохранена.");
    }
    return candidate;
  }

  private journal(job: string, state: string, detail: JournalDetail): void {
    this.db.run("INSERT INTO migration_journal(id,kind,state,detail,started,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,detail=excluded.detail,updated=excluded.updated",
      job, "opencode", state, JSON.stringify(detail), Date.now(), Date.now());
  }

  private verifiedManifest(id: string, expected: { origin?: string; job?: string } = {}): ArchiveManifest {
    if (!HASH.test(id)) throw new Error("Некорректный архив.");
    const directory = path.join(this.legacyDir, id);
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Каталог архива подменён ссылкой или имеет неверный тип.");
    const file = this.archiveFile(id), manifestFile = path.join(directory, "manifest.json");
    const snapshotStat = fs.lstatSync(file), manifestStat = fs.lstatSync(manifestFile);
    if (!snapshotStat.isFile() || !manifestStat.isFile() || snapshotStat.isSymbolicLink() || manifestStat.isSymbolicLink())
      throw new Error("Файлы архива подменены ссылками или имеют неверный тип.");
    const manifest = manifestOf(JSON.parse(fs.readFileSync(manifestFile, "utf8")));
    if (manifest.id !== id || snapshotStat.size !== manifest.snapshot.size || shaFile(file) !== manifest.snapshot.sha256)
      throw new Error("Сохранённый архив повреждён; оригинал истории не изменён.");
    if (expected.origin !== undefined && manifest.source.origin !== expected.origin || expected.job !== undefined && manifest.job !== expected.job)
      throw new Error("Источник или задание сохранённого архива не совпадает с журналом.");
    const trusted = this.db.get("SELECT kind,manifest FROM legacy_archives WHERE id=?", id);
    if (trusted && (text(trusted, "kind") !== "opencode"
      || canonicalJson(manifestOf(JSON.parse(text(trusted, "manifest")))) !== canonicalJson(manifest)))
      throw new Error("Метаданные архива не совпадают с доверенным реестром.");
    return manifest;
  }

  /** Crash recovery removes only a directory proven to belong to this job. */
  recover(): void {
    if (activeImports.has(this.db)) throw new Error("Импорт истории ещё выполняется; восстановление сейчас недоступно.");
    for (const row of this.db.all("SELECT id,detail FROM migration_journal WHERE kind='opencode' AND state NOT IN ('committed','rolled_back')")) {
      const job = text(row, "id");
      if (!JOB.test(job)) continue; // Older importer records need their own reader.
      const detail = journalDetail(text(row, "detail"));
      if (!detail) continue;
      if (detail.archive) {
        const committed = this.db.get("SELECT id FROM legacy_archives WHERE id=?", detail.archive);
        if (committed) {
          this.verifiedManifest(detail.archive, { origin: detail.origin });
          this.journal(job, "committed", detail);
          fs.rmSync(path.join(this.stagingDir, job), { recursive: true, force: true });
          continue;
        }
        const final = path.join(this.legacyDir, detail.archive);
        if (fs.existsSync(final)) {
          this.verifiedManifest(detail.archive, { origin: detail.origin, job });
          fs.rmSync(final, { recursive: true });
          syncDirectory(this.legacyDir);
        }
      }
      fs.rmSync(path.join(this.stagingDir, job), { recursive: true, force: true });
      this.journal(job, "rolled_back", detail);
    }
  }

  /** origin identifies a known remote installation when its DB was transported. */
  async import(sourceDb: string, options: { origin?: string } = {}): Promise<ImportResult> {
    if (activeImports.has(this.db)) throw new Error("Импорт истории уже выполняется.");
    activeImports.add(this.db);
    try { return await this.importOwned(sourceDb, options); }
    finally { activeImports.delete(this.db); }
  }

  private async importOwned(sourceDb: string, options: { origin?: string }): Promise<ImportResult> {
    if (!path.isAbsolute(sourceDb)) throw new Error("Укажите абсолютный путь к базе OpenCode.");
    if (this.db.get("SELECT id FROM migration_journal WHERE kind='opencode' AND state IN ('staging','snapshotted','verified','publishing')"))
      throw new Error("Импорт истории уже выполняется.");
    const canonical = fs.realpathSync(sourceDb);
    const origin = options.origin ?? createHash("sha256").update(canonical).digest("hex");
    if (!validOrigin(origin)) throw new Error("Некорректный источник истории.");
    const job = randomUUID(), staging = path.join(this.stagingDir, job);
    let contentId: string | undefined;
    let published = false;
    this.journal(job, "staging", { version: 2, origin });
    try {
      fs.mkdirSync(staging, { mode: 0o700 });
      const snapshot = path.join(staging, "snapshot.sqlite");
      await snapshotSource(canonical, snapshot);
      fs.chmodSync(snapshot, 0o400);
      const snapshotBefore = snapshotIdentity(snapshot);
      const snapshotSha = shaFile(snapshot);
      contentId = archiveIdentity(origin, snapshotSha);
      const detail: JournalDetail = { version: 2, origin, archive: contentId };
      const current = this.db.get("SELECT manifest FROM legacy_archives WHERE id=?", contentId);
      if (current) {
        const verified = this.verifiedManifest(contentId, { origin });
        fs.rmSync(staging, { recursive: true });
        this.journal(job, "committed", detail);
        return { archive: dto(verified), created: false, imported: 0, updated: 0 };
      }
      this.journal(job, "snapshotted", detail);
      const reader = new OpenCodeArchiveReader(snapshot);
      let sessions: LegacySession[];
      let counts: Record<string, number>;
      try {
        // Check all known raw tables too: corrupt inactive shadows/inbox must
        // not become a successful complete archive merely because chat reads.
        for (const issue of reader.validationIssues())
          if (issue.severity === "error") throw new ArchiveDataError([issue]);
        sessions = reader.sessions();
        // Consume every page before publish; no transcript-sized array.
        for (const session of sessions) {
          for (const _page of reader.messagePages(session.id))
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        counts = reader.counts();
      } finally { reader.close(); }
      unchangedSnapshot(snapshot, snapshotBefore, snapshotSha);
      const manifest: ArchiveManifest = { id: contentId, kind: "opencode", importer: IMPORTER,
        createdAt: Date.now(), job, source: { path: canonical, origin, acquisition: "sqlite-read-snapshot" },
        snapshot: { file: "snapshot.sqlite", sha256: snapshotSha, size: Number(snapshotBefore.size) },
        counts, sessions: sessions.length };
      const manifestFile = path.join(staging, "manifest.json");
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: "wx" });
      syncFile(manifestFile); syncDirectory(staging);
      fs.chmodSync(manifestFile, 0o400);
      unchangedSnapshot(snapshot, snapshotBefore, snapshotSha);
      this.journal(job, "verified", detail);
      const final = path.join(this.legacyDir, contentId);
      if (fs.existsSync(final)) throw new Error("Незавершённый архив уже существует; выполните восстановление перед повтором.");
      this.journal(job, "publishing", detail);
      fs.renameSync(staging, final); published = true; syncDirectory(this.legacyDir);
      const archiveId = contentId;
      let imported = 0, updated = 0;
      this.db.transaction(() => {
        this.db.run("INSERT INTO legacy_archives(id,kind,manifest,created) VALUES(?,?,?,?)", archiveId, "opencode", JSON.stringify(manifest), manifest.createdAt);
        for (const session of sessions) {
          const id = legacySessionId(origin, session.id);
          const rawPrior = this.db.get("SELECT origin,deleted FROM sessions WHERE id=?", id);
          if (rawPrior) {
            const priorOrigin: unknown = JSON.parse(text(rawPrior, "origin"));
            if (!priorOrigin || typeof priorOrigin !== "object" || !("kind" in priorOrigin) || priorOrigin.kind !== "opencode"
              || !("legacyId" in priorOrigin) || priorOrigin.legacyId !== session.id || !("archive" in priorOrigin)
              || typeof priorOrigin.archive !== "string" || !HASH.test(priorOrigin.archive)
              || !("readOnly" in priorOrigin) || priorOrigin.readOnly !== true)
              throw new Error("Идентификатор импортированной истории занят другой сессией.");
            const priorArchive = this.db.get("SELECT manifest FROM legacy_archives WHERE id=? AND kind='opencode'", priorOrigin.archive);
            const priorManifest = priorArchive ? manifestOf(JSON.parse(text(priorArchive, "manifest"))) : null;
            if (!priorManifest || priorManifest.id !== priorOrigin.archive || priorManifest.source.origin !== origin)
              throw new Error("Источник существующей импортированной истории не совпадает.");
            // get() deliberately hides tombstones. The raw identity still owns
            // this namespace; never resurrect it or insert the same PK again.
            if (rawPrior.deleted !== null && rawPrior.deleted !== undefined) continue;
          }
          const prior = this.catalog.get(id);
          const source: SessionOrigin = { kind: "opencode", archive: archiveId, legacyId: session.id, readOnly: true };
          if (prior) {
            if (prior.origin.kind !== "opencode" || prior.origin.legacyId !== session.id)
              throw new Error("Идентификатор импортированной истории занят другой сессией.");
            this.catalog.update(id, { origin: { ...source, ...(prior.origin.continuedBy ? { continuedBy: prior.origin.continuedBy } : {}) }, touch: false });
            updated++;
          } else {
            this.catalog.insert({ id, directory: session.directory, title: session.title,
              created: session.created, updated: session.updated, archived: session.archived,
              permission: validRules(session.permission) ? session.permission : null,
              parentId: session.parentId ? legacySessionId(origin, session.parentId) : null,
              sessionFile: null, origin: source, workshop: false, model: null });
            imported++;
          }
        }
        this.journal(job, "committed", detail);
      });
      return { archive: dto(manifest), created: true, imported, updated };
    } catch (error) {
      const cleanup: string[] = [];
      let lastPhase = "unknown", committed = false, inspected = false;
      try {
        lastPhase = text(this.db.get("SELECT state FROM migration_journal WHERE id=?", job), "state") || "unknown";
        committed = !!contentId && !!this.db.get("SELECT id FROM legacy_archives WHERE id=?", contentId);
        inspected = true;
      } catch (inspectionError) { cleanup.push(cleanupIssue("inspect", inspectionError)); }
      try { fs.rmSync(staging, { recursive: true, force: true }); }
      catch (cleanupError) { cleanup.push(cleanupIssue("staging", cleanupError)); }
      if (published && contentId && inspected && !committed) {
        try {
          this.verifiedManifest(contentId, { origin, job });
          fs.rmSync(path.join(this.legacyDir, contentId), { recursive: true }); syncDirectory(this.legacyDir);
        } catch (cleanupError) { cleanup.push(cleanupIssue("archive", cleanupError)); }
      }
      try { this.journal(job, committed ? "committed" : "failed", { version: 2, origin, ...(contentId ? { archive: contentId } : {}),
        lastPhase, ...(cleanup.length ? { cleanup } : {}), error: error instanceof Error ? error.message.slice(0, 500) : "Импорт остановлен." }); }
      catch { /* Preserve the original failure; durable previous phase recovers. */ }
      throw error;
    }
  }
}
