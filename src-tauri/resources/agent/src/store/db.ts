// Runtime-owned SQLite database (node:sqlite, WAL, synchronous FULL).
//
// The runtime is the only writer. The Pi SDK stores the conversation tree in its
// own JSONL files; this database holds Enki metadata (projects, titles, archive
// state, permissions), the command ledger, the event journal, the durable queue,
// schedules, the tool execution journal and the legacy import journal.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { SCHEMA_VERSION } from "../protocol.ts";

/** Values this runtime binds; a subset of node:sqlite's accepted input values. */
export type SqlValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, unknown>;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sessions(
      id TEXT PRIMARY KEY,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      archived INTEGER,
      permission TEXT,
      parent_id TEXT,
      session_file TEXT,
      origin TEXT NOT NULL DEFAULT '{"kind":"pi"}',
      workshop INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      deleted INTEGER
    );
    CREATE INDEX sessions_directory ON sessions(directory, updated);
    CREATE TABLE commands(
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      session_id TEXT NOT NULL,
      directory TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      entry_id TEXT,
      error TEXT,
      source TEXT,
      source_id TEXT,
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL
    );
    CREATE INDEX commands_session ON commands(session_id, created);
    CREATE TABLE events(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      time INTEGER NOT NULL,
      directory TEXT,
      session_id TEXT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX events_session ON events(session_id, seq);
    CREATE TABLE queue(
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      directory TEXT NOT NULL,
      position REAL NOT NULL,
      text TEXT NOT NULL,
      attachments TEXT,
      model TEXT NOT NULL,
      state TEXT NOT NULL,
      error TEXT,
      queued_at INTEGER NOT NULL,
      command_id TEXT
    );
    CREATE INDEX queue_session ON queue(session_id, position);
    CREATE TABLE queue_state(
      session_id TEXT PRIMARY KEY,
      armed INTEGER NOT NULL,
      paused_reason TEXT,
      stop_epoch INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE schedules(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, directory TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX schedules_session ON schedules(session_id);
    CREATE TABLE attachments(
      id TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      owner TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE INDEX attachments_owner ON attachments(owner);
    CREATE TABLE executions(
      session_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      command_id TEXT,
      state TEXT NOT NULL,
      started INTEGER NOT NULL,
      ended INTEGER,
      PRIMARY KEY(session_id, tool_call_id)
    );
    CREATE TABLE permission_grants(
      session_id TEXT NOT NULL,
      permission TEXT NOT NULL,
      pattern TEXT NOT NULL,
      created INTEGER NOT NULL,
      PRIMARY KEY(session_id, permission, pattern)
    );
    CREATE TABLE legacy_archives(id TEXT PRIMARY KEY, kind TEXT NOT NULL, manifest TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE legacy_map(
      archive_id TEXT NOT NULL,
      legacy_session TEXT NOT NULL,
      legacy_message TEXT NOT NULL,
      legacy_part TEXT NOT NULL,
      pi_session TEXT NOT NULL,
      pi_entry TEXT NOT NULL,
      PRIMARY KEY(archive_id, legacy_session, legacy_message, legacy_part, pi_session)
    );
    CREATE TABLE migration_journal(id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, started INTEGER NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE hub_leases(owner TEXT PRIMARY KEY, body TEXT NOT NULL);
  `,
  2: `
    ALTER TABLE commands ADD COLUMN payload TEXT;
  `,
  // Pre-2.0 UI-owned work (queues, timers, lost-ACK sends) handed to this
  // runtime. One row per exact source item; the immutable payload is kept
  // until the user resolves it, whatever happened to its publication.
  3: `
    CREATE TABLE cutover_items(
      id TEXT PRIMARY KEY,
      installation TEXT NOT NULL,
      workspace TEXT NOT NULL,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      legacy_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      state TEXT NOT NULL,
      target_session TEXT,
      target_item TEXT,
      detail TEXT,
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      UNIQUE(installation, workspace, source, kind, legacy_id)
    );
    CREATE INDEX cutover_workspace ON cutover_items(installation, workspace, updated);
  `,
};

interface TransactionHooks {
  commit: Array<() => void>;
  rollback: Array<() => void>;
}

export class Database {
  readonly db: DatabaseSync;
  private readonly transactions: TransactionHooks[] = [];
  private readonly pendingCommit: Array<() => void> = [];
  private flushingCommit = false;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  private migrate(): void {
    const version: Row | undefined = this.db.prepare("PRAGMA user_version").get();
    const current = Number(version?.user_version ?? 0);
    if (current > SCHEMA_VERSION)
      throw new Error(`Runtime database schema ${current} is newer than this runtime (${SCHEMA_VERSION}). Roll back is not allowed; install the newer runtime.`);
    for (let version = current + 1; version <= SCHEMA_VERSION; version++) {
      const sql = MIGRATIONS[version];
      if (!sql) throw new Error(`Missing runtime schema migration ${version}`);
      this.transaction(() => {
        this.db.exec(sql);
        this.db.exec(`PRAGMA user_version=${version}`);
      });
    }
  }

  /**
   * Explicit BEGIN IMMEDIATE; nested callers use savepoints. Hooks run only
   * after the outer COMMIT, never from rolled-back work. Publishing outside the
   * SQL try/catch also means an observer failure cannot roll back a committed
   * command or mask its durable acceptance.
   */
  transaction<T>(work: () => T): T {
    const depth = this.transactions.length;
    const savepoint = `enki_transaction_${depth}`;
    this.db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    const hooks: TransactionHooks = { commit: [], rollback: [] };
    this.transactions.push(hooks);
    let result: T;
    try {
      result = work();
      this.db.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
    } catch (error) {
      try {
        if (depth === 0) this.db.exec("ROLLBACK");
        else {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }
      } catch { /* Preserve the original work/commit failure. */ }
      this.transactions.pop();
      for (const hook of hooks.rollback) {
        try { hook(); } catch { /* Rollback invalidation must not mask SQL failure. */ }
      }
      throw error;
    }
    this.transactions.pop();
    const parent = this.transactions.at(-1);
    if (parent) {
      for (const hook of hooks.commit) parent.commit.push(hook);
      for (const hook of hooks.rollback) parent.rollback.push(hook);
    } else this.flushCommit(hooks.commit);
    return result;
  }

  /** Publish only when the current outer transaction commits. */
  afterCommit(work: () => void): void {
    const current = this.transactions.at(-1);
    if (current) current.commit.push(work);
    else this.flushCommit([work]);
  }

  /** Invalidate transaction-local caches if this transaction later rolls back. */
  afterRollback(work: () => void): void {
    this.transactions.at(-1)?.rollback.push(work);
  }

  private flushCommit(hooks: Array<() => void>): void {
    for (const hook of hooks) this.pendingCommit.push(hook);
    if (this.flushingCommit) return;
    this.flushingCommit = true;
    let firstFailure: unknown;
    let failed = false;
    let cursor = 0;
    try {
      // Reentrant subscribers may append more events. Queue their hooks behind
      // every event of this commit so observers still receive monotonic seqs.
      while (cursor < this.pendingCommit.length) {
        const hook = this.pendingCommit[cursor++];
        try { hook(); }
        catch (error) { if (!failed) { firstFailure = error; failed = true; } }
      }
    } finally {
      this.pendingCommit.splice(0, cursor);
      this.flushingCommit = false;
    }
    if (failed) throw firstFailure;
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const result = this.db.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get(sql: string, ...params: SqlValue[]): Row | undefined {
    const row: Row | undefined = this.db.prepare(sql).get(...params);
    return row;
  }

  all(sql: string, ...params: SqlValue[]): Row[] {
    const rows: Row[] = this.db.prepare(sql).all(...params);
    return rows;
  }

  close(): void {
    this.db.close();
  }
}

export const text = (row: Row | undefined, key: string): string => {
  const value = row?.[key];
  return typeof value === "string" ? value : "";
};
export const optionalText = (row: Row | undefined, key: string): string | null => {
  const value = row?.[key];
  return typeof value === "string" ? value : null;
};
export const integer = (row: Row | undefined, key: string): number => {
  const value = row?.[key];
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0;
};
export const optionalInteger = (row: Row | undefined, key: string): number | null => {
  const value = row?.[key];
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : null;
};

/** Parse JSON written by this runtime; corrupt rows surface, never pass silently. */
export function json<T>(row: Row | undefined, key: string, validate: (value: unknown) => value is T): T | null {
  const raw = optionalText(row, key);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!validate(value)) throw new Error(`Corrupt runtime record field ${key}`);
  return value;
}

// ---------------------------------------------------------- single writer

export interface LockOwner { pid: number; instance: string; startedAt: number }

/**
 * A separate persistent SQLite file is the OS-backed ownership primitive.
 * Keeping this connection's EXCLUSIVE transaction open excludes other runtime
 * processes AND other connections in the same process. The OS releases it on
 * crash; the lock file is never unlinked or replaced. PID/JSON metadata is not
 * authority and an empty/partially-written metadata file cannot be stolen.
 */
export function acquireWriterLock(dir: string, owner: LockOwner): () => void {
  const file = path.join(dir, "runtime.lock");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lease = new DatabaseSync(path.join(dir, "writer-lock.sqlite"));
  try {
    lease.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch (error) {
    lease.close();
    const sqliteCode = typeof error === "object" && error !== null && "errcode" in error ? Number(error.errcode) : 0;
    if (sqliteCode === 5 || sqliteCode === 6)
      throw new Error(`Enki Runtime already owns ${dir}. A second writer is not started.`, { cause: error });
    throw error;
  }
  let fd: number | undefined;
  try {
    // Only the EXCLUSIVE lease owner may replace this diagnostic metadata.
    // Never reclaim ownership by deleting a lock based on a PID probe.
    try { fs.unlinkSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(owner));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
      fd = undefined;
    }
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { lease.exec("ROLLBACK"); } finally { lease.close(); }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      try {
        const current = JSON.parse(fs.readFileSync(file, "utf8")) as LockOwner;
        if (current.instance === owner.instance) fs.unlinkSync(file);
      } catch { /* Diagnostic file replaced or removed; never delete another identity. */ }
    } finally {
      try { lease.exec("ROLLBACK"); } finally { lease.close(); }
    }
  };
}
