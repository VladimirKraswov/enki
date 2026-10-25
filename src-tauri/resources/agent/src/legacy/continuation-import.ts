// Durable continuation publication. The SDK seed is an explicit trusted port;
// this module never loads a provider, starts an agent or mutates an archive.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson, isId } from "../protocol.ts";
import { text, type Database } from "../store/db.ts";
import type { SessionCatalog, SessionRecord } from "../sessions/catalog.ts";
import type { SeedMessage } from "../sdk/adapter.ts";
import { buildContinuation, type ContinuationOptions, type ContinuationReader } from "./continuation.ts";
import { cleanupIssue, directory, HASH, JOB, readStable, shaBytes, syncDirectory, syncFile } from "./files.ts";
import { validatePiBytes } from "./pi-jsonl.ts";

export type ContinuationSeed = (cwd: string, sessionDir: string, id: string,
  intro: { customType: string; text: string; details: unknown }, messages: SeedMessage[]) => { file: string; entryIds: string[] };
interface Detail {
  version: 1; root: string; source: string; archive: string; target: string;
  final: string; sha256?: string; entryIds?: string[]; lastPhase?: string; cleanup?: string[];
}
export interface ContinueOptions extends Omit<ContinuationOptions, "archive"> {
  /** A caller-selected local cwd. Historical cwd is never authority. */
  directory: string;
}
const active = new WeakSet<Database>();
function detail(raw: string): Detail {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Журнал продолжения повреждён.");
  const d = value as Partial<Detail>;
  if (d.version !== 1 || typeof d.root !== "string" || !HASH.test(d.root) || !isId(d.source) || typeof d.archive !== "string" || !HASH.test(d.archive)
    || typeof d.target !== "string" || !JOB.test(d.target) || d.final !== `${d.target}.jsonl`
    || d.sha256 !== undefined && !HASH.test(d.sha256) || d.entryIds !== undefined && (!Array.isArray(d.entryIds) || !d.entryIds.every(isId)))
    throw new Error("Привязка журнала продолжения повреждена.");
  return d as Detail;
}
export class ContinuationImporter {
  private readonly sessions: string;
  private readonly staging: string;
  private readonly root: string;
  constructor(private readonly db: Database, private readonly catalog: SessionCatalog, sessions: string,
    staging: string, private readonly seed: ContinuationSeed) {
    this.sessions = directory(sessions, true); this.staging = directory(staging, true); this.root = shaBytes(Buffer.from(this.sessions));
    if (this.sessions === this.staging) throw new Error("Хранилище сессий и staging продолжений должны различаться.");
  }
  private writeJournal(job: string, state: string, value: Detail): void {
    this.db.run("INSERT INTO migration_journal(id,kind,state,detail,started,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,detail=excluded.detail,updated=excluded.updated",
      job, "continuation", state, JSON.stringify(value), Date.now(), Date.now());
  }
  private targetFile(d: Detail): string { return path.join(this.sessions, d.final); }
  private verifyTarget(d: Detail): void {
    if (!d.sha256) throw new Error("Журнал не содержит проверенный SHA256 продолжения.");
    const bytes = readStable(this.targetFile(d), 8 * 1024 * 1024);
    if (shaBytes(bytes) !== d.sha256) throw new Error("Файл продолжения повреждён или изменён без регистрации.");
    validatePiBytes(bytes, { id: d.target });
  }
  /** Scoped startup recovery before workers/admission; does not execute any transcript. */
  recover(): void {
    if (active.has(this.db)) throw new Error("Продолжение ещё создаётся; восстановление недоступно.");
    for (const row of this.db.all("SELECT id,state,detail FROM migration_journal WHERE kind='continuation' AND state<>'rolled_back'")) {
      const job = text(row, "id"); if (!JOB.test(job)) throw new Error("Неверный job ID продолжения.");
      const d = detail(text(row, "detail")); if (d.root !== this.root) continue;
      const raw = this.db.get("SELECT origin,session_file FROM sessions WHERE id=?", d.target);
      if (raw) {
        const origin: unknown = JSON.parse(text(raw, "origin"));
        if (!origin || typeof origin !== "object" || !("kind" in origin) || origin.kind !== "continuation"
          || !("from" in origin) || origin.from !== d.source || !("archive" in origin) || origin.archive !== d.archive || text(raw, "session_file") !== this.targetFile(d))
          throw new Error("Identity продолжения принадлежит другой записи.");
        // A registered session may legitimately have appended after commit; its
        // immutable seed SHA is not the hash of an active conversation now.
        const source = this.db.get("SELECT origin FROM sessions WHERE id=?", d.source), sourceOrigin: unknown = source ? JSON.parse(text(source, "origin")) : null;
        if (!sourceOrigin || typeof sourceOrigin !== "object" || !("continuedBy" in sourceOrigin) || sourceOrigin.continuedBy !== d.target)
          throw new Error("Каталог продолжения не согласован с источником.");
        this.writeJournal(job, "committed", d);
      } else {
        if (fs.existsSync(this.targetFile(d))) { this.verifyTarget(d); fs.rmSync(this.targetFile(d)); syncDirectory(this.sessions); }
        this.writeJournal(job, "rolled_back", d);
      }
      const staged = path.join(this.staging, job);
      if (fs.existsSync(staged)) { directory(staged); fs.rmSync(staged, { recursive: true }); syncDirectory(this.staging); }
    }
  }
  async continue(record: SessionRecord, reader: ContinuationReader, options: ContinueOptions): Promise<SessionRecord> {
    if (active.has(this.db)) throw new Error("Перенос продолжения уже выполняется.");
    active.add(this.db);
    try { return await this.continueOwned(record, reader, options); }
    finally { active.delete(this.db); }
  }
  private async continueOwned(record: SessionRecord, reader: ContinuationReader, options: ContinueOptions): Promise<SessionRecord> {
    if (record.origin.kind !== "opencode") throw new Error("Продолжить можно только архивный чат OpenCode.");
    const selectedDirectory = directory(options.directory), current = this.catalog.get(record.id);
    if (!current || canonicalJson(current.origin) !== canonicalJson(record.origin)) throw new Error("Источник продолжения изменился; откройте чат заново.");
    if (record.origin.continuedBy) {
      const existing = this.catalog.get(record.origin.continuedBy);
      if (!existing) throw new Error("Предыдущее продолжение удалено. Оно не будет восстановлено автоматически.");
      if (existing.origin.kind !== "continuation" || existing.origin.from !== record.id || !HASH.test(existing.origin.archive))
        throw new Error("Привязка существующего продолжения повреждена.");
      return existing;
    }
    const origin = record.origin, plan = await buildContinuation(reader, origin.legacyId, { ...options, archive: origin.archive });
    const job = randomUUID(), id = randomUUID(), stage = path.join(this.staging, job);
    const d: Detail = { version: 1, root: this.root, source: record.id, archive: origin.archive, target: id, final: `${id}.jsonl` };
    let phase = "prepared", published = false, committed = false;
    this.writeJournal(job, phase, d);
    try {
      fs.mkdirSync(stage, { mode: 0o700 });
      const seeded = this.seed(selectedDirectory, stage, id, { customType: "enki-legacy-continuation", text: plan.contextNote,
        details: { version: 1, archive: origin.archive, legacyId: origin.legacyId, source: record.id, cutover: plan.cutover, omittedGroups: plan.omittedGroups, omittedParts: plan.omittedParts, pendingInputs: plan.pendingInputs } }, plan.messages);
      if (directory(path.dirname(seeded.file)) !== directory(stage)) throw new Error("SDK создал продолжение вне его staging.");
      const bytes = readStable(seeded.file, 8 * 1024 * 1024), parsed = validatePiBytes(bytes, { id, cwd: selectedDirectory });
      const entries = parsed.entries.filter(entry => entry.type === "message");
      if (seeded.entryIds.length !== plan.messages.length || canonicalJson(entries.map(entry => entry.id)) !== canonicalJson(seeded.entryIds))
        throw new Error("SDK entry mapping продолжения не совпал с проверенным планом.");
      for (let i = 0; i < entries.length; i++) if (canonicalJson(entries[i].message) !== canonicalJson(plan.messages[i])) throw new Error("SDK изменил содержимое перенесённой записи.");
      d.sha256 = shaBytes(bytes); d.entryIds = seeded.entryIds; syncFile(seeded.file); syncDirectory(stage);
      phase = "publishing"; this.writeJournal(job, phase, d);
      // Both paths are app-owned; a random UUID plus exclusive no-overwrite
      // link prevents replacement of any existing session, including on POSIX.
      fs.linkSync(seeded.file, this.targetFile(d)); published = true; syncDirectory(this.sessions);
      phase = "published"; this.writeJournal(job, phase, d);
      let created!: SessionRecord;
      this.db.transaction(() => {
        const latest = this.catalog.get(record.id);
        if (!latest || canonicalJson(latest.origin) !== canonicalJson(origin)) throw new Error("Источник изменился во время переноса; повторите из свежего архива.");
        created = this.catalog.insert({ id, directory: selectedDirectory, title: record.title, created: Date.now(), updated: Date.now(), archived: null,
          permission: latest.permission, parentId: null, sessionFile: this.targetFile(d), origin: { kind: "continuation", from: record.id, archive: origin.archive }, workshop: latest.workshop, model: null });
        this.catalog.update(record.id, { origin: { ...origin, continuedBy: id }, workshop: false, touch: false });
        for (const [index, ref] of plan.refs.entries()) if (ref.message)
          this.db.run("INSERT INTO legacy_map(archive_id,legacy_session,legacy_message,legacy_part,pi_session,pi_entry) VALUES(?,?,?,?,?,?)", origin.archive, origin.legacyId, ref.message, ref.part, id, seeded.entryIds[index]);
        this.writeJournal(job, "committed", d); this.db.afterCommit(() => { committed = true; });
      });
      fs.rmSync(stage, { recursive: true }); syncDirectory(this.staging);
      return created;
    } catch (error) {
      // Observer/cleanup failure after COMMIT must not remove a live session.
      let durable = committed;
      try { durable ||= this.db.get("SELECT state FROM migration_journal WHERE id=?", job)?.state === "committed"; }
      catch { throw error; /* uncertain DB state: preserve owned files for recovery */ }
      if (durable) {
        const existing = this.catalog.get(id);
        if (existing?.origin.kind === "continuation" && existing.origin.from === record.id && existing.origin.archive === origin.archive && existing.sessionFile === this.targetFile(d)) return existing;
        throw error;
      }
      const cleanup: string[] = [];
      if (published) try { this.verifyTarget(d); fs.rmSync(this.targetFile(d)); syncDirectory(this.sessions); } catch (failure) { cleanup.push(cleanupIssue("published", failure)); }
      try { if (fs.existsSync(stage)) { directory(stage); fs.rmSync(stage, { recursive: true }); syncDirectory(this.staging); } } catch (failure) { cleanup.push(cleanupIssue("staging", failure)); }
      try { this.writeJournal(job, "failed", { ...d, lastPhase: phase, cleanup }); } catch { /* preserve the actual import failure */ }
      throw error;
    }
  }
}
