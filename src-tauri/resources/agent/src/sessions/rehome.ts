// Canonical Enki session store: one transcript shard per real directory.
//
// A project folder can be named through an alias — the former app-data link, a
// renamed repository, the same volume mounted elsewhere. Runtimes used to key a
// shard by the literal string, so one real folder owned several shards and a
// chat whose row kept the other spelling lost write access to its own history
// («Историю можно изменять только в рабочем хранилище Enki»). This migrator runs
// on every start before any worker opens a session: it gives each misplaced
// Enki transcript its canonical shard and replaces the alias in the durable rows
// of that chat (metadata, queue, timers, receipts, journal) in one transaction.
//
// Durability: each move is journaled in migration_journal (kind `session-shard`)
// with the transcript's SHA256; the file is hard-linked into its canonical place
// and only then does one transaction repoint the metadata, so the previous path
// stays valid until the commit. An unfinished journal row is settled by the next
// start — a crash can neither drop a transcript nor point two chats at one file.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalDirectory, canonicalExisting, ownedSessionPath, sessionDirFor, SESSION_LAYOUT, type RuntimePaths } from "../platform/paths.ts";
import { syncOwnedDirectory, syncOwnedFile } from "../platform/owned-sync.ts";
import { text, type Database } from "../store/db.ts";
import type { SessionCatalog, SessionRecord } from "./catalog.ts";

const KIND = "session-shard";
/** Durable state that repeats the folder a chat belongs to. */
const DIRECTORY_TABLES = ["queue", "schedules", "commands", "events"] as const;

interface Plan {
  version: 1; session: string; directory: string; previousDirectory: string;
  /** Current and intended transcript path; both empty while the chat has none. */
  from: string; to: string;
  sha256?: string;
}
export interface ShardReport { moved: string[]; rewritten: string[]; skipped: Array<{ session: string; reason: string }>; }

function shaFile(file: string): string {
  const hash = createHash("sha256"), descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(256 * 1024);
    for (;;) { const read = fs.readSync(descriptor, buffer); if (!read) break; hash.update(buffer.subarray(0, read)); }
  } finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
}

const sameFile = (a: string, b: string): boolean => { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; } };

export class SessionShards {
  constructor(private readonly db: Database, private readonly catalog: SessionCatalog, private readonly paths: RuntimePaths) {}

  /** Where new work for a folder belongs: the canonical directory's shard. */
  private shardOf(directory: string): string { return sessionDirFor(this.paths, canonicalDirectory(directory)); }

  /** Alias → canonical map of every folder named in this store. */
  private aliases(): Map<string, string> {
    const named = new Set<string>();
    for (const row of this.db.all("SELECT directory FROM sessions WHERE deleted IS NULL")) named.add(text(row, "directory"));
    for (const table of DIRECTORY_TABLES)
      for (const row of this.db.all(`SELECT DISTINCT directory FROM ${table}`)) named.add(text(row, "directory"));
    const map = new Map<string, string>();
    for (const directory of named) {
      const canonical = canonicalExisting(directory);
      if (canonical && canonical !== directory) map.set(directory, canonical);
    }
    return map;
  }

  private writeJournal(job: string, state: string, plan: Plan): void {
    this.db.run("INSERT INTO migration_journal(id,kind,state,detail,started,updated) VALUES(?,?,?,?,?,?)"
      + " ON CONFLICT(id) DO UPDATE SET state=excluded.state,detail=excluded.detail,updated=excluded.updated",
      job, KIND, state, JSON.stringify(plan), Date.now(), Date.now());
  }

  /** Journaled moves this start must still settle or redo. */
  private open(): Array<{ job: string; plan: Plan }> {
    const found = new Map<string, { job: string; plan: Plan }>();
    for (const row of this.db.all("SELECT id,state,detail FROM migration_journal WHERE kind=? ORDER BY started", KIND)) {
      const detail = text(row, "detail"); if (!detail) continue;
      let value: unknown; try { value = JSON.parse(detail); } catch { continue; }
      const plan = value as Partial<Plan>;
      if (!plan || plan.version !== 1 || typeof plan.session !== "string" || typeof plan.directory !== "string"
        || typeof plan.previousDirectory !== "string" || typeof plan.from !== "string"
        || (plan.to !== null && typeof plan.to !== "string")) continue;
      const state = text(row, "state");
      if (state !== "committed" && state !== "rolled_back" && state !== "failed") found.set(plan.session, { job: text(row, "id"), plan: plan as Plan });
    }
    return [...found.values()];
  }

  /** Metadata repoint plus every durable copy of the folder, in one transaction. */
  private repoint(plan: Plan): void {
    this.db.transaction(() => {
      this.catalog.rehome(plan.session, plan.directory, plan.to || null);
      for (const table of DIRECTORY_TABLES)
        this.db.run(`UPDATE ${table} SET directory=? WHERE directory=?`, plan.directory, plan.previousDirectory);
    });
  }

  private unlink(file: string): void { fs.rmSync(file); syncOwnedDirectory(path.dirname(file)); }

  /** Settle the moves a previous start left unfinished. Never executes a transcript. */
  recover(): void {
    for (const { job, plan } of this.open()) {
      const current = this.catalog.get(plan.session);
      const target = plan.to !== "" && fs.existsSync(plan.to);
      const source = plan.from !== "" && fs.existsSync(plan.from);
      if (current?.sessionFile === plan.to) {
        if (source && !sameFile(plan.from, plan.to)) this.unlink(plan.from);
        this.writeJournal(job, "committed", plan);
      } else if (current?.sessionFile === plan.from) {
        if (!target) { this.writeJournal(job, "rolled_back", plan); continue; }
        if (shaFile(plan.to) !== plan.sha256) { this.writeJournal(job, "failed", plan); throw new Error("Перенесённая история не совпала с проверенной записью журнала."); }
        if (source) { this.unlink(plan.to); this.writeJournal(job, "rolled_back", plan); }
        else { this.repoint(plan); this.writeJournal(job, "committed", plan); }
      } else this.writeJournal(job, "rolled_back", plan);
    }
  }

  /** One pass: settle journals, repoint aliases, move misplaced transcripts, prune empty shards. */
  migrate(): ShardReport {
    const report: ShardReport = { moved: [], rewritten: [], skipped: [] };
    this.recover();
    const aliases = this.aliases();
    const pending = new Set(this.open().map((item) => item.plan.session));
    for (const record of this.catalog.all()) {
      const directory = aliases.get(record.directory) ?? record.directory;
      const file = record.sessionFile;
      const renamed = directory !== record.directory;
      if (record.origin.kind === "pi-cli") continue;                       // an adopted Pi CLI copy keeps its own root
      if (!file) { this.relocate({ version: 1, session: record.id, directory, previousDirectory: record.directory, from: "", to: "" }, report); continue; }
      if (pending.has(record.id)) { report.skipped.push({ session: record.id, reason: "перенос этой истории не завершён" }); continue; }
      if (!fs.existsSync(file)) { report.skipped.push({ session: record.id, reason: "файл истории недоступен на этом компьютере" }); continue; }
      if (!ownedSessionPath(this.paths, file)) { report.skipped.push({ session: record.id, reason: "история принадлежит внешнему файлу" }); continue; }
      const shard = this.shardOf(directory);
      const misplaced = path.dirname(file) !== shard;
      if (!misplaced && !renamed) continue;
      this.relocate({ version: 1, session: record.id, directory, previousDirectory: record.directory, from: file,
        to: misplaced ? path.join(shard, path.basename(file)) : file, sha256: misplaced ? shaFile(file) : undefined }, report);
    }
    for (const [alias, canonical] of this.aliases())
      this.db.transaction(() => { for (const table of DIRECTORY_TABLES) this.db.run(`UPDATE ${table} SET directory=? WHERE directory=?`, canonical, alias); });
    this.prune();
    return report;
  }

  /** Journal → link → commit → remove the previous copy. Adds to `report`. */
  private relocate(plan: Plan, report: ShardReport): void {
    if (plan.session !== "" && plan.directory === plan.previousDirectory && plan.from === plan.to) return;
    const job = randomUUID();
    this.writeJournal(job, "prepared", plan);
    const moved = plan.from !== plan.to && plan.from !== "";
    if (moved) {
      const shard = path.dirname(plan.to);
      fs.mkdirSync(shard, { recursive: true, mode: 0o700 });
      if (fs.existsSync(plan.to)) {
        if (shaFile(plan.to) !== plan.sha256) {
          this.writeJournal(job, "rolled_back", plan);
          report.skipped.push({ session: plan.session, reason: "в канонической папке уже лежит другая история" });
          return;
        }
      } else {
        fs.linkSync(plan.from, plan.to);
        syncOwnedFile(plan.to); syncOwnedDirectory(shard);
        if (shaFile(plan.to) !== plan.sha256) throw new Error("Каноническая копия истории не совпала с источником.");
      }
      this.writeJournal(job, "linked", plan);
    }
    this.repoint(plan);
    if (moved && fs.existsSync(plan.from) && !sameFile(plan.from, plan.to)) this.unlink(plan.from);
    this.writeJournal(job, "committed", plan);
    if (moved) report.moved.push(plan.session);
    if (plan.directory !== plan.previousDirectory) report.rewritten.push(plan.session);
  }

  /** Remove shards no live chat owns and that hold no regular file. */
  private prune(): void {
    const owned = new Set(this.catalog.all().filter((r: SessionRecord) => !!r.sessionFile)
      .map((r: SessionRecord) => path.basename(path.dirname(r.sessionFile!))));
    for (const name of fs.readdirSync(this.paths.sessions)) {
      if (!SESSION_LAYOUT.shard.test(name) || owned.has(name)) continue;
      const dir = path.join(this.paths.sessions, name);
      let link: fs.Stats; try { link = fs.lstatSync(dir); } catch { continue; }
      if (!link.isDirectory() || link.isSymbolicLink() || this.holdsFile(dir)) continue;
      fs.rmSync(dir, { recursive: true });
      syncOwnedDirectory(this.paths.sessions);
    }
  }

  private holdsFile(dir: string): boolean {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() || entry.isSymbolicLink()) return true;
      if (entry.isDirectory() && this.holdsFile(path.join(dir, entry.name))) return true;
    }
    return false;
  }

  /** What the journal says this store has been through (operator evidence). */
  summary(): { moved: number; rewritten: number; failed: number; open: number } {
    const moved = new Set<string>(), rewritten = new Set<string>(); let failed = 0;
    for (const row of this.db.all("SELECT state,detail FROM migration_journal WHERE kind=?", KIND)) {
      const state = text(row, "state");
      let plan: Plan | null = null; try { plan = JSON.parse(text(row, "detail")) as Plan; } catch { continue; }
      if (state === "committed" && plan?.session) {
        if (plan.from !== plan.to && plan.to) moved.add(plan.session);
        if (plan.directory !== plan.previousDirectory) rewritten.add(plan.session);
      }
      if (state === "failed") failed++;
    }
    return { moved: moved.size, rewritten: rewritten.size, failed, open: this.open().length };
  }
}
