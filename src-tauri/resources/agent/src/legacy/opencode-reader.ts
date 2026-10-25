// Read ONLY an app-owned, consistent SQLite archive snapshot. No source paths,
// attachment URLs, pending inputs, shell entries or project commands are executed.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ArchiveDiagnostic, ArchiveInput, ArchiveProjection, ArchiveRecord, ArchiveSessionDetails,
  ArchiveContinuationMetadata, JsonValue, LegacySession, MessageDTO, MessagePartDTO } from "./protocol.ts";
import { body, diagnostic, record, text, whole, type Row } from "./records.ts";
import { v1Message, v1Part, v2Message } from "./projection.ts";
export type { LegacySession } from "./protocol.ts";

const requirements = {
  session: ["id", "directory", "title", "time_created", "time_updated"],
  message: ["id", "session_id", "time_created", "time_updated", "data"],
  part: ["id", "message_id", "session_id", "time_created", "time_updated", "data"],
  session_message: ["id", "session_id", "type", "seq", "time_created", "time_updated", "data"],
  session_input: ["id", "session_id", "prompt", "delivery", "admitted_seq", "promoted_seq", "time_created"],
  session_context_epoch: ["session_id", "baseline", "snapshot", "baseline_seq"],
  project: ["id"], todo: ["session_id", "position"], project_directory: ["project_id", "directory"], permission: ["project_id"],
} as const;
type Table = keyof typeof requirements;
const jsonFields: Record<Table, readonly string[]> = {
  session: ["data", "metadata", "revert", "permission", "model", "summary_diffs"],
  message: ["data"], part: ["data"], session_message: ["data"], session_input: ["prompt"],
  session_context_epoch: ["snapshot"], project: ["sandboxes", "commands"],
  todo: [], project_directory: [], permission: [],
};
const TABLES = Object.keys(requirements) as Table[];

/** Trusted construction seam for fault-injection tests; never a wire/model option. */
export type ReadonlySqliteConnection = Pick<DatabaseSync, "prepare" | "exec" | "close">;
export interface ReadonlySqliteOptions {
  readonly readOnly: true;
  readonly enableForeignKeyConstraints: false;
}
export type ReadonlySqliteFactory = (file: string, options: ReadonlySqliteOptions) => ReadonlySqliteConnection;
export interface OpenCodeArchiveReaderOptions { connect?: ReadonlySqliteFactory }
const openReadonlySqlite: ReadonlySqliteFactory = (file, options) => new DatabaseSync(file, options);

export class ArchiveDataError extends Error {
  constructor(readonly issues: readonly ArchiveDiagnostic[]) {
    const first = issues.find(issue => issue.severity === "error") ?? issues[0];
    super(first ? `Архив OpenCode: ${first.table}/${first.rowId ?? "?"}: ${first.message} (${first.code}).`
      : "Архив OpenCode имеет неподдерживаемый формат.");
    this.name = "ArchiveDataError";
  }
}
function unique(issues: ArchiveDiagnostic[]): ArchiveDiagnostic[] {
  const found = new Set<string>();
  return issues.filter(issue => { const key = JSON.stringify(issue); if (found.has(key)) return false; found.add(key); return true; });
}

export class OpenCodeArchiveReader {
  private readonly db: ReadonlySqliteConnection;
  private readonly columns = new Map<Table, Set<string>>();
  private closed = false;

  constructor(readonly file: string, options: OpenCodeArchiveReaderOptions = {}) {
    const db = (options.connect ?? openReadonlySqlite)(file, { readOnly: true, enableForeignKeyConstraints: false });
    this.db = db;
    try {
      // Connection-local settings/transaction only. No DDL, migrations, journal
      // mode changes, checkpoint, VACUUM or writes to the source archive.
      db.exec("PRAGMA query_only=ON; BEGIN DEFERRED");
      for (const table of TABLES) {
        const exists = this.all("SELECT type FROM sqlite_schema WHERE name=?", table)[0];
        if (!exists) continue;
        if (exists.type !== "table") throw new Error(`Архив OpenCode: ${table} должен быть обычной таблицей.`);
        const columns = new Set(this.all(`PRAGMA table_info("${table}")`).map(row => String(row.name)));
        this.columns.set(table, columns);
        for (const key of requirements[table]) if (!columns.has(key))
          throw new Error(`Архив OpenCode не содержит ${table}.${key}; формат не распознан.`);
      }
      if (!this.has("session") || !this.has("session_message") && !(this.has("message") && this.has("part")))
        throw new Error("Архив OpenCode не содержит распознаваемой V1/V2 истории.");
      if (this.has("message") !== this.has("part")) throw new Error("Архив OpenCode содержит неполную пару message/part.");
    } catch (error) {
      // DatabaseSync's constructor may succeed before schema validation fails.
      // Do not leak its file descriptor or leave an archive read transaction.
      try { db.close(); } catch { /* retain the original actionable schema error */ }
      this.closed = true;
      throw error;
    }
  }
  private ensureOpen(): void { if (this.closed) throw new Error("Архив OpenCode уже закрыт."); }
  private has(table: Table, column?: string): boolean { return column === undefined ? this.columns.has(table) : this.columns.get(table)?.has(column) ?? false; }
  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    this.ensureOpen();
    const statement = this.db.prepare(sql);
    statement.setReadBigInts(true);
    return statement.all(...params);
  }
  private *scan(sql: string, ...params: SQLInputValue[]): Generator<Row> {
    this.ensureOpen();
    const statement = this.db.prepare(sql);
    statement.setReadBigInts(true);
    for (const row of statement.iterate(...params)) yield row;
  }
  private source(table: Table, row: Row, issues: ArchiveDiagnostic[]): ArchiveRecord {
    const source = record(table, row, jsonFields[table], issue => issues.push(issue));
    if (["session", "message", "part", "session_message", "session_input", "project"].includes(table) && !text(row.id))
      issues.push(diagnostic(source, "ROW_INVALID", "Отсутствует или повреждена SQL identity записи."));
    if (["message", "part", "session_message", "session_input", "session_context_epoch", "todo"].includes(table) && !text(row.session_id))
      issues.push(diagnostic(source, "ROW_INVALID", "Отсутствует SQL session_id записи."));
    for (const key of ["time_created", "time_updated"] as const) if (this.has(table, key) && whole(row[key]) === null)
      issues.push(diagnostic(source, "ROW_INVALID", `Некорректное SQL-поле ${key}.`, "error", key));
    return source;
  }
  private row(sessionID: string): Row {
    const row = this.all('SELECT * FROM "session" WHERE id=?', sessionID)[0];
    if (!row) throw new Error("Сессия не найдена в архиве OpenCode.");
    return row;
  }
  private format(sessionID: string): "v1" | "v2" {
    if (this.has("session_message") && this.all("SELECT 1 FROM session_message WHERE session_id=? LIMIT 1", sessionID).length) return "v2";
    if (this.has("session_input") && this.all("SELECT 1 FROM session_input WHERE session_id=? LIMIT 1", sessionID).length) return "v2";
    if (this.has("session_context_epoch") && this.all("SELECT 1 FROM session_context_epoch WHERE session_id=? LIMIT 1", sessionID).length) return "v2";
    return this.has("message") ? "v1" : "v2";
  }
  private session(row: Row, issues: ArchiveDiagnostic[]): { session: LegacySession; record: ArchiveRecord } {
    const source = this.source("session", row, issues);
    const id = text(row.id), directory = text(row.directory), title = text(row.title);
    const created = whole(row.time_created), updated = whole(row.time_updated);
    if (!id || directory === null || title === null || created === null || updated === null)
      issues.push(diagnostic(source, "ROW_INVALID", "Некорректная identity, каталог, заголовок или время сессии."));
    const parsed = (key: string): JsonValue | undefined => source.json[key]?.valid ? source.json[key].value : undefined;
    const result: LegacySession = { id: id ?? "", directory: directory ?? "", title: title ?? "Чат OpenCode",
      parentId: text(row.parent_id), created: created ?? 0, updated: updated ?? 0, archived: row.time_archived == null ? null : whole(row.time_archived),
      permission: parsed("permission") ?? null, projectId: text(row.project_id), workspaceId: text(row.workspace_id), agent: text(row.agent),
      ...(parsed("metadata") === undefined ? {} : { metadata: parsed("metadata") }),
      ...(parsed("revert") === undefined ? {} : { revert: parsed("revert") }),
      ...(parsed("model") === undefined ? {} : { model: parsed("model") }) };
    if (row.time_archived != null && result.archived === null) issues.push(diagnostic(source, "ROW_INVALID", "Некорректное время архивации сессии."));
    return { session: result, record: source };
  }

  /** Original raw table counts stay compatible; transcriptMessages excludes V1 shadows/inbox. */
  counts(): Record<string, number> {
    const count = (table: Table): number => this.has(table) ? whole(this.all(`SELECT COUNT(*) AS n FROM "${table}"`)[0]?.n) ?? 0 : 0;
    let transcriptMessages = 0;
    for (const row of this.scan('SELECT id FROM "session" ORDER BY id')) {
      const id = text(row.id);
      if (!id) continue;
      const table = this.format(id) === "v2" ? "session_message" : "message";
      if (this.has(table)) transcriptMessages += whole(this.all(`SELECT COUNT(*) AS n FROM "${table}" WHERE session_id=?`, id)[0]?.n) ?? 0;
    }
    return { sessions: count("session"), messages: count("message"), parts: count("part"),
      session_messages: count("session_message"), session_inputs: count("session_input"),
      context_epochs: count("session_context_epoch"), transcriptMessages };
  }
  sessions(): LegacySession[] {
    const issues: ArchiveDiagnostic[] = [];
    const result = this.all('SELECT * FROM "session" ORDER BY time_created, id').map(row => this.session(row, issues).session);
    if (issues.some(issue => issue.severity === "error")) throw new ArchiveDataError(issues);
    return result;
  }

  private *relationshipIssues(sessionID?: string): Generator<ArchiveDiagnostic> {
    const filter = sessionID === undefined ? "" : " WHERE t.session_id=?";
    const params = sessionID === undefined ? [] : [sessionID];
    for (const table of ["message", "part", "session_message", "session_input", "session_context_epoch", "todo"] as const) {
      if (!this.has(table)) continue;
      for (const row of this.scan(`SELECT t.* FROM "${table}" t LEFT JOIN "session" s ON s.id=t.session_id${filter ? `${filter} AND` : " WHERE"} s.id IS NULL`, ...params)) {
        const source = record(table, row, [], () => {});
        yield diagnostic(source, "FK_SESSION", "Запись ссылается на отсутствующую сессию.");
      }
    }
    if (this.has("part") && this.has("message")) {
      const where = sessionID === undefined ? "" : " AND (p.session_id=? OR m.session_id=?)";
      const bindings = sessionID === undefined ? [] : [sessionID, sessionID];
      for (const row of this.scan(`SELECT p.*,m.id AS __parent_id,m.session_id AS __parent_session FROM part p LEFT JOIN message m ON m.id=p.message_id WHERE (m.id IS NULL OR p.session_id<>m.session_id)${where}`, ...bindings)) {
        const source = record("part", row, [], () => {});
        yield diagnostic(source, row.__parent_id == null ? "ORPHAN_PART" : "FK_MISMATCH", "Часть не принадлежит указанному сообщению/сессии.");
      }
    }
    if (this.has("project") && this.has("session", "project_id")) {
      const where = sessionID === undefined ? "" : " AND s.id=?";
      for (const row of this.scan(`SELECT s.* FROM "session" s LEFT JOIN project p ON p.id=s.project_id WHERE p.id IS NULL${where}`, ...params))
        yield diagnostic(record("session", row, [], () => {}), "FK_PROJECT", "Сессия ссылается на отсутствующий проект.");
    }
    for (const table of ["session_message", "session_input"] as const) {
      if (!this.has(table)) continue;
      const keys = table === "session_message" ? ["seq"] : ["admitted_seq", "promoted_seq"];
      for (const key of keys) for (const row of this.scan(`SELECT session_id,${key},MIN(id) AS id FROM "${table}" WHERE ${key} IS NOT NULL${sessionID === undefined ? "" : " AND session_id=?"} GROUP BY session_id,${key} HAVING COUNT(*)>1`, ...params))
        yield diagnostic(record(table, row, [], () => {}), "SEQ_DUPLICATE", "Нарушена уникальность последовательности архива.");
    }
    for (const table of ["session", "message", "part", "session_message", "session_input"] as const) {
      if (!this.has(table)) continue;
      const condition = sessionID === undefined ? "" : ` WHERE ${table === "session" ? "id" : "session_id"}=?`;
      for (const row of this.scan(`SELECT id${table === "session" ? "" : ",MIN(session_id) AS session_id"} FROM "${table}"${condition} GROUP BY id HAVING COUNT(*)>1`, ...params))
        yield diagnostic(record(table, row, [], () => {}), "ID_DUPLICATE", "SQL identity архива не уникальна.");
    }
  }
  private *inputRecords(sessionID: string, issues: ArchiveDiagnostic[]): Generator<ArchiveInput> {
    if (!this.has("session_input")) return;
    for (const row of this.scan("SELECT * FROM session_input WHERE session_id=? ORDER BY admitted_seq,id", sessionID)) {
      const source = this.source("session_input", row, issues);
      const id = text(row.id), admittedSeq = whole(row.admitted_seq), promotedSeq = row.promoted_seq === null ? null : whole(row.promoted_seq);
      if (!id || admittedSeq === null || row.promoted_seq !== null && promotedSeq === null || row.delivery !== "queue" && row.delivery !== "steer") {
        issues.push(diagnostic(source, "ROW_INVALID", "Некорректная запись inbox V2.")); continue;
      }
      const prompt = body(source, "prompt", issue => issues.push(issue));
      if (prompt && typeof prompt.text !== "string") issues.push(diagnostic(source, "ROW_INVALID", "У архивного inbox prompt отсутствует текст."));
      if (promotedSeq !== null) {
        const target = this.has("session_message") ? this.all("SELECT id,type FROM session_message WHERE session_id=? AND seq=?", sessionID, promotedSeq) : [];
        if (target.length !== 1 || target[0].id !== id || target[0].type !== "user") issues.push(diagnostic(source, "INPUT_PROMOTION_MISMATCH", "Promoted inbox не соответствует V2 user projection."));
      }
      yield { id, admittedSeq, promotedSeq, delivery: row.delivery, pending: promotedSeq === null, record: source };
    }
  }
  private inputs(sessionID: string, issues: ArchiveDiagnostic[]): ArchiveInput[] { return [...this.inputRecords(sessionID, issues)]; }
  private prerequisites(sessionID: string): ArchiveDiagnostic[] {
    const issues = [...this.relationshipIssues(sessionID)];
    this.session(this.row(sessionID), issues);
    for (const _input of this.inputRecords(sessionID, issues)) { /* validate without retaining inbox payloads */ }
    if (this.has("session_context_epoch")) for (const row of this.scan("SELECT * FROM session_context_epoch WHERE session_id=?", sessionID)) {
      const source = this.source("session_context_epoch", row, issues);
      if (whole(row.baseline_seq) === null || typeof row.baseline !== "string") issues.push(diagnostic(source, "ROW_INVALID", "Некорректный context epoch V2."));
      body(source, "snapshot", issue => issues.push(issue));
    }
    return issues;
  }
  private projectPage(sessionID: string, format: "v1" | "v2", rows: Row[], issues: ArchiveDiagnostic[]): { records: ArchiveRecord[]; messages: MessageDTO[] } {
    const table = format === "v1" ? "message" : "session_message";
    const records = rows.map(row => this.source(table, row, issues));
    const messages: MessageDTO[] = [];
    const ids = rows.map(row => text(row.id)).filter((id): id is string => id !== null);
    const parts = new Map<string, MessagePartDTO[]>();
    if (format === "v1" && ids.length) {
      for (const row of this.scan(`SELECT * FROM part WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY time_created,id`, ...ids)) {
        const source = this.source("part", row, issues); records.push(source);
        const messageID = text(row.message_id);
        if (row.session_id !== sessionID || !messageID || !ids.includes(messageID)) {
          issues.push(diagnostic(source, "FK_MISMATCH", "Часть принадлежит другой сессии/сообщению.")); continue;
        }
        const item = v1Part(source, sessionID, messageID, issue => issues.push(issue));
        if (item) { const list = parts.get(messageID) ?? []; list.push(item); parts.set(messageID, list); }
      }
    }
    const seqs = new Set<number>();
    for (const source of records.filter(item => item.table === table)) {
      if (!source.id || source.sessionID !== sessionID || whole(source.row.time_created) === null || whole(source.row.time_updated) === null
        || format === "v2" && (source.seq === null || typeof source.type !== "string" || !source.type)) {
        issues.push(diagnostic(source, "ROW_INVALID", "Повреждена SQL identity/type/seq сообщения.")); continue;
      }
      if (source.seq !== null && seqs.has(source.seq)) issues.push(diagnostic(source, "SEQ_DUPLICATE", "Повторяется seq V2 сообщения."));
      if (source.seq !== null) seqs.add(source.seq);
      const projected = format === "v2" ? v2Message(source, issue => issues.push(issue))
        : v1Message(source, parts.get(source.id) ?? [], issue => issues.push(issue));
      if (projected) messages.push(projected);
    }
    return { records, messages };
  }

  /** Strict bounded read: corrupt/unsupported chat records fail, never silently truncate. */
  *messagePages(sessionID: string, options: { pageSize?: number } = {}): Generator<MessageDTO[]> {
    const pageSize = options.pageSize ?? 256;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 512) throw new Error("Размер страницы должен быть от 1 до 512.");
    const prerequisites = this.prerequisites(sessionID);
    if (prerequisites.some(issue => issue.severity === "error")) throw new ArchiveDataError(prerequisites);
    const format = this.format(sessionID), table = format === "v1" ? "message" : "session_message";
    const order = format === "v1" ? "time_created,id" : "seq,id";
    let offset = 0, lastSeq: number | null = null;
    for (;;) {
      const rows = this.has(table) ? this.all(`SELECT * FROM "${table}" WHERE session_id=? ORDER BY ${order} LIMIT ? OFFSET ?`, sessionID, pageSize, offset) : [];
      if (!rows.length) break;
      const issues: ArchiveDiagnostic[] = [];
      if (format === "v2") for (const row of rows) {
        const seq = whole(row.seq);
        if (seq !== null && lastSeq !== null && seq <= lastSeq) issues.push(diagnostic(record(table, row, [], () => {}), "SEQ_DUPLICATE", "V2 seq не возрастает строго."));
        if (seq !== null) lastSeq = seq;
      }
      const page = this.projectPage(sessionID, format, rows, issues);
      if (issues.some(issue => issue.severity === "error")) throw new ArchiveDataError(issues);
      yield page.messages;
      offset += rows.length;
    }
  }
  messages(sessionID: string): MessageDTO[] { return [...this.messagePages(sessionID)].flat(); }

  /** A UI tail page of a previously validated immutable archive. Only headers
   * outside this page are read; old tool outputs/attachments are not decoded.
   * The optional cursor projection is trusted host code, never archive code. */
  historyPage(sessionID: string, limit: number, before?: string, cursorId: (id: string) => string = id => id): { messages: MessageDTO[]; before?: string } {
    if (!Number.isSafeInteger(limit)) throw new Error("Некорректный размер страницы.");
    limit = Math.max(1, Math.min(limit, 1000));
    const issues = [...this.relationshipIssues(sessionID)];
    this.session(this.row(sessionID), issues);
    if (issues.some(issue => issue.severity === "error")) throw new ArchiveDataError(issues);
    const format = this.format(sessionID), table = format === "v1" ? "message" : "session_message";
    if (!this.has(table)) return { messages: [] };
    const key = format === "v1" ? "time_created" : "seq";
    let boundary: Row | undefined;
    if (before) {
      // Wire ids are intentionally one-way. Resolve them using small SQL
      // headers, without materializing the historical message bodies.
      for (const row of this.scan(`SELECT id,${key} FROM "${table}" WHERE session_id=?`, sessionID)) {
        if (typeof row.id === "string" && cursorId(row.id) === before) { boundary = row; break; }
      }
      if (!boundary) return { messages: [] };
    }
    const where = boundary ? ` AND (${key}<? OR (${key}=? AND id<?))` : "";
    const values: SQLInputValue[] = boundary ? [boundary[key] as SQLInputValue, boundary[key] as SQLInputValue, boundary.id as SQLInputValue] : [];
    // The extra header determines has-more without reading an extra payload.
    const headers = this.all(`SELECT id FROM "${table}" WHERE session_id=?${where} ORDER BY ${key} DESC,id DESC LIMIT ?`, sessionID, ...values, limit + 1);
    const ids = headers.slice(0, limit).map(row => String(row.id));
    if (!ids.length) return { messages: [] };
    const rows = this.all(`SELECT * FROM "${table}" WHERE session_id=? AND id IN (${ids.map(() => "?").join(",")}) ORDER BY ${key},id`, sessionID, ...ids);
    const page = this.projectPage(sessionID, format, rows, issues);
    if (issues.some(issue => issue.severity === "error")) throw new ArchiveDataError(issues);
    return { messages: page.messages, ...(headers.length > limit ? { before: cursorId(String(rows[0].id)) } : {}) };
  }

  continuationMetadata(sessionID: string): ArchiveContinuationMetadata {
    const issues = this.prerequisites(sessionID);
    const selected = this.session(this.row(sessionID), issues);
    const epoch = this.has("session_context_epoch") ? this.all("SELECT * FROM session_context_epoch WHERE session_id=?", sessionID)[0] : undefined;
    const contextEpoch = epoch ? this.source("session_context_epoch", epoch, issues) : null;
    if (issues.some(issue => issue.severity === "error")) throw new ArchiveDataError(issues);
    const pendingInputs = this.has("session_input")
      ? whole(this.all("SELECT COUNT(*) AS n FROM session_input WHERE session_id=? AND promoted_seq IS NULL", sessionID)[0]?.n) ?? 0 : 0;
    return { session: selected.session, format: this.format(sessionID), contextEpoch, pendingInputs };
  }

  /** Lossless archive UI fallback. Callers MUST check complete before conversion. */
  archiveProjection(sessionID: string): ArchiveProjection {
    const issues = this.prerequisites(sessionID), format = this.format(sessionID);
    const table = format === "v1" ? "message" : "session_message", order = format === "v1" ? "time_created,id" : "seq,id";
    const result: { records: ArchiveRecord[]; messages: MessageDTO[] } = { records: [], messages: [] };
    for (let offset = 0; this.has(table); offset += 512) {
      const rows = this.all(`SELECT * FROM "${table}" WHERE session_id=? ORDER BY ${order} LIMIT 512 OFFSET ?`, sessionID, offset);
      if (!rows.length) break;
      const page = this.projectPage(sessionID, format, rows, issues);
      for (const item of page.messages) result.messages.push(item);
      for (const item of page.records) result.records.push(item);
    }
    // Broken FK rows are still available to the archive panel, never attached
    // to a foreign message or silently lost just because they cannot render.
    if (format === "v1" && this.has("part")) {
      const represented = new Set(result.records.filter(item => item.table === "part").map(item => item.id));
      for (const row of this.scan("SELECT * FROM part WHERE session_id=? ORDER BY time_created,id", sessionID)) {
        if (!represented.has(text(row.id))) result.records.push(this.source("part", row, issues));
      }
    }
    const inputs = this.inputs(sessionID, issues);
    return { sessionID, format, complete: !issues.some(issue => issue.severity === "error"),
      messages: result.messages, records: result.records, pendingInputs: inputs.filter(input => input.pending), diagnostics: unique(issues) };
  }
  details(sessionID: string): ArchiveSessionDetails {
    const issues = this.prerequisites(sessionID);
    const selected = this.session(this.row(sessionID), issues);
    const records = (table: Table, where: string, ...params: SQLInputValue[]): ArchiveRecord[] => this.has(table)
      ? this.all(`SELECT * FROM "${table}" WHERE ${where}`, ...params).map(row => this.source(table, row, issues)) : [];
    const projectId = text(selected.record.row.project_id);
    const project = projectId ? records("project", "id=?", projectId)[0] ?? null : null;
    const format = this.format(sessionID);
    return { ...selected, project, contextEpoch: records("session_context_epoch", "session_id=?", sessionID)[0] ?? null,
      inputs: this.inputs(sessionID, issues), v1Shadow: format === "v2" ? {
        messages: records("message", "session_id=? ORDER BY time_created,id", sessionID),
        parts: records("part", "session_id=? ORDER BY time_created,id", sessionID),
      } : { messages: [], parts: [] }, related: {
        todo: records("todo", "session_id=? ORDER BY position", sessionID),
        project_directory: projectId ? records("project_directory", "project_id=? ORDER BY directory", projectId) : [],
        permission: projectId ? records("permission", "project_id=?", projectId) : [],
      }, diagnostics: unique(issues) };
  }

  /** Stream every issue over every known row, including V1 shadows and inbox. No transcript buffering. */
  *validationIssues(sessionID?: string): Generator<ArchiveDiagnostic> {
    yield* this.relationshipIssues(sessionID);
    for (const table of TABLES) {
      if (!this.has(table)) continue;
      if (sessionID !== undefined && !this.has(table, "session_id") && table !== "session") continue;
      const where = sessionID === undefined ? "" : ` WHERE ${table === "session" ? "id" : "session_id"}=?`;
      for (const row of this.scan(`SELECT * FROM "${table}"${where}`, ...(sessionID === undefined ? [] : [sessionID]))) {
        const issues: ArchiveDiagnostic[] = [];
        const source = this.source(table, row, issues);
        if (table === "session") this.session(row, issues);
        else if (table === "message") v1Message(source, [], issue => issues.push(issue));
        else if (table === "part" && text(row.session_id) && text(row.message_id)) v1Part(source, String(row.session_id), String(row.message_id), issue => issues.push(issue));
        else if (table === "session_message") {
          if (whole(row.seq) === null || !text(row.type)) issues.push(diagnostic(source, "ROW_INVALID", "Некорректные type/seq V2 projection."));
          v2Message(source, issue => issues.push(issue));
        } else if (table === "session_input") {
          const prompt = body(source, "prompt", issue => issues.push(issue));
          if (!text(row.id) || whole(row.admitted_seq) === null || row.promoted_seq !== null && whole(row.promoted_seq) === null
            || row.delivery !== "queue" && row.delivery !== "steer" || prompt && typeof prompt.text !== "string")
            issues.push(diagnostic(source, "ROW_INVALID", "Некорректная запись inbox V2."));
        }
        else if (table === "session_context_epoch") {
          if (whole(row.baseline_seq) === null || typeof row.baseline !== "string") issues.push(diagnostic(source, "ROW_INVALID", "Некорректный context epoch V2."));
          body(source, "snapshot", issue => issues.push(issue));
        }
        yield* unique(issues);
      }
    }
    // Cross-row promotion validation stays streaming; do not buffer a million
    // pending inputs just to validate a large archive before commit.
    if (this.has("session_input") && this.has("session_message")) {
      const where = sessionID === undefined ? "" : " AND i.session_id=?";
      for (const row of this.scan(`SELECT i.* FROM session_input i LEFT JOIN session_message m ON m.session_id=i.session_id AND m.seq=i.promoted_seq WHERE i.promoted_seq IS NOT NULL AND (m.id IS NULL OR m.id<>i.id OR m.type<>'user')${where}`, ...(sessionID === undefined ? [] : [sessionID])))
        yield diagnostic(record("session_input", row, [], () => {}), "INPUT_PROMOTION_MISMATCH", "Promoted inbox не соответствует V2 user projection.");
    }
  }
  validate(): ArchiveDiagnostic[] { return unique([...this.validationIssues()]); }
  diagnostics(sessionID?: string): ArchiveDiagnostic[] {
    if (sessionID !== undefined) this.row(sessionID);
    return unique([...this.validationIssues(sessionID)]);
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}
