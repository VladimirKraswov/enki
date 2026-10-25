// Enki-owned session metadata. The Pi SDK owns the transcript tree; this table
// owns what Pi does not: project directory, title, archive state, access rules,
// provenance (native, Pi CLI copy, legacy OpenCode archive, continuation) and
// the Мастерская designation.

import type { ModelRef, PermissionRule, SessionDTO, SessionOrigin } from "../protocol.ts";
import { isModelRef } from "../protocol.ts";
import { integer, json, optionalInteger, optionalText, text, type Database, type Row } from "../store/db.ts";
import type { EventJournal } from "../store/events.ts";

export interface SessionRecord {
  id: string;
  directory: string;
  title: string;
  created: number;
  updated: number;
  archived: number | null;
  permission: PermissionRule[] | null;
  parentId: string | null;
  sessionFile: string | null;
  origin: SessionOrigin;
  workshop: boolean;
  model: ModelRef | null;
}

function isRules(value: unknown): value is PermissionRule[] {
  return Array.isArray(value) && value.length <= 256 && value.every((rule) =>
    rule && typeof rule === "object" && typeof rule.permission === "string" && rule.permission.length <= 200
    && typeof rule.pattern === "string" && rule.pattern.length <= 2000 && ["allow", "ask", "deny"].includes(rule.action));
}

const HASH = /^[a-f0-9]{64}$/;
const boundedText = (value: unknown, max: number): value is string => typeof value === "string" && !!value && value.length <= max && !/[\u0000-\u001f]/.test(value);
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);

/** Every subtype field is checked; an unknown or partial provenance is never "pi". */
export function isOrigin(value: unknown): value is SessionOrigin {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const keys = (allowed: string[]) => Object.keys(o).every((key) => allowed.includes(key));
  switch (o.kind) {
    case "pi": return keys(["kind"]);
    case "opencode":
      return keys(["kind", "archive", "legacyId", "sourceOrigin", "readOnly", "continuedBy"]) && typeof o.archive === "string" && HASH.test(o.archive)
        && boundedText(o.legacyId, 512) && o.readOnly === true && optional(o.sourceOrigin, (v) => boundedText(v, 512))
        && optional(o.continuedBy, (v) => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v));
    case "pi-cli":
      return keys(["kind", "source", "sourceOrigin", "legacyId", "archive", "runtimeId"]) && boundedText(o.source, 4096)
        && boundedText(o.sourceOrigin, 512) && boundedText(o.legacyId, 512) && typeof o.archive === "string" && HASH.test(o.archive)
        && typeof o.runtimeId === "string" && /^pi-legacy-[a-f0-9]{48}$/.test(o.runtimeId);
    case "continuation":
      return keys(["kind", "from", "archive"]) && typeof o.from === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(o.from)
        && typeof o.archive === "string" && HASH.test(o.archive);
    case "quarantined": return keys(["kind", "readOnly", "reason"]) && o.readOnly === true && boundedText(o.reason, 500);
    default: return false;
  }
}

function originOf(row: Row): SessionOrigin {
  const raw = row.origin;
  if (raw === undefined || raw === null) return { kind: "pi" };
  try {
    const value: unknown = JSON.parse(String(raw));
    if (isOrigin(value)) return value;
  } catch { /* reported below */ }
  return { kind: "quarantined", readOnly: true, reason: "Происхождение чата не прошло проверку; он открыт только для чтения." };
}

export const validRules = isRules;

function recordOf(row: Row): SessionRecord {
  return {
    id: text(row, "id"),
    directory: text(row, "directory"),
    title: text(row, "title"),
    created: integer(row, "created"),
    updated: integer(row, "updated"),
    archived: optionalInteger(row, "archived"),
    permission: json(row, "permission", isRules),
    parentId: optionalText(row, "parent_id"),
    sessionFile: optionalText(row, "session_file"),
    origin: originOf(row),
    workshop: integer(row, "workshop") === 1,
    model: json(row, "model", isModelRef),
  };
}

export function sessionDTO(record: SessionRecord): SessionDTO {
  return {
    id: record.id,
    directory: record.directory,
    title: record.title,
    projectID: "enki",
    ...(record.parentId ? { parentID: record.parentId } : {}),
    ...(record.permission ? { permission: record.permission } : {}),
    ...(record.model ? { model: { id: record.model.modelID, providerID: record.model.providerID, variant: record.model.variant ?? null } } : {}),
    origin: record.origin,
    ...(record.workshop ? { workshop: true } : {}),
    time: { created: record.created, updated: record.updated, ...(record.archived ? { archived: record.archived } : {}) },
  };
}

export interface SessionPatch {
  title?: string;
  permission?: PermissionRule[] | null;
  archived?: number | null;
  workshop?: boolean;
  model?: ModelRef | null;
  sessionFile?: string;
  origin?: SessionOrigin;
  touch?: boolean;
}

export class SessionCatalog {
  constructor(private readonly db: Database, private readonly journal: EventJournal) {}

  get(id: string): SessionRecord | null {
    const row = this.db.get("SELECT * FROM sessions WHERE id=? AND deleted IS NULL", id);
    return row ? recordOf(row) : null;
  }

  list(directory: string, limit = 200): SessionRecord[] {
    return this.db.all("SELECT * FROM sessions WHERE directory=? AND deleted IS NULL ORDER BY updated DESC LIMIT ?", directory, Math.max(1, Math.min(limit, 2000))).map(recordOf);
  }

  /** Cross-directory listing, newest first, with an opaque numeric cursor. */
  recent(options: { archived: boolean; cursor?: number; limit?: number; search?: string; directory?: string }): { records: SessionRecord[]; cursor: number | null } {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 200));
    const params: Array<string | number> = [];
    let sql = "SELECT * FROM sessions WHERE deleted IS NULL AND parent_id IS NULL AND " + (options.archived ? "archived IS NOT NULL" : "archived IS NULL");
    if (options.cursor !== undefined) { sql += " AND updated < ?"; params.push(options.cursor); }
    if (options.directory) { sql += " AND directory = ?"; params.push(options.directory); }
    if (options.search?.trim()) { sql += " AND title LIKE ? ESCAPE '\\'"; params.push(`%${options.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
    sql += " ORDER BY updated DESC LIMIT ?";
    params.push(limit + 1);
    const rows = this.db.all(sql, ...params).map(recordOf);
    const page = rows.slice(0, limit);
    return { records: page, cursor: rows.length > limit ? page[page.length - 1].updated : null };
  }

  all(): SessionRecord[] {
    return this.db.all("SELECT * FROM sessions WHERE deleted IS NULL").map(recordOf);
  }

  insert(record: SessionRecord): SessionRecord {
    if (!isOrigin(record.origin) || record.origin.kind === "quarantined") throw new Error("Некорректное происхождение сессии.");
    this.db.run("INSERT INTO sessions(id,directory,title,created,updated,archived,permission,parent_id,session_file,origin,workshop,model) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      record.id, record.directory, record.title, record.created, record.updated, record.archived,
      record.permission ? JSON.stringify(record.permission) : null, record.parentId, record.sessionFile,
      JSON.stringify(record.origin), record.workshop ? 1 : 0, record.model ? JSON.stringify(record.model) : null);
    this.journal.append(record.directory, record.id, { type: "session.created", properties: { info: sessionDTO(record) } });
    return record;
  }

  update(id: string, patch: SessionPatch): SessionRecord {
    const current = this.get(id);
    if (!current) throw new Error("Сессия не найдена.");
    if (patch.origin !== undefined && (!isOrigin(patch.origin) || patch.origin.kind === "quarantined" || current.origin.kind === "quarantined"))
      throw new Error("Происхождение сессии нельзя заменить непроверенным значением.");
    const next: SessionRecord = {
      ...current,
      ...(patch.title !== undefined ? { title: patch.title.trim().slice(0, 300) || current.title } : {}),
      ...(patch.permission !== undefined ? { permission: patch.permission } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived || null } : {}),
      ...(patch.workshop !== undefined ? { workshop: patch.workshop } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.sessionFile !== undefined ? { sessionFile: patch.sessionFile } : {}),
      ...(patch.origin !== undefined ? { origin: patch.origin } : {}),
      updated: patch.touch === false ? current.updated : Date.now(),
    };
    // The stored origin column changes only through an explicit, validated
    // patch; a quarantined row keeps its raw (unverified) provenance bytes.
    this.db.run("UPDATE sessions SET title=?,updated=?,archived=?,permission=?,session_file=?,origin=COALESCE(?,origin),workshop=?,model=? WHERE id=?",
      next.title, next.updated, next.archived, next.permission ? JSON.stringify(next.permission) : null, next.sessionFile,
      patch.origin !== undefined ? JSON.stringify(patch.origin) : null, next.workshop ? 1 : 0, next.model ? JSON.stringify(next.model) : null, id);
    this.journal.append(next.directory, id, { type: "session.updated", properties: { sessionID: id, info: sessionDTO(next) } });
    return next;
  }

  /** Metadata tombstone; the transcript file is moved to trash by the caller. */
  remove(id: string): SessionRecord | null {
    const current = this.get(id);
    if (!current) return null;
    this.db.run("UPDATE sessions SET deleted=? WHERE id=?", Date.now(), id);
    this.journal.append(current.directory, id, { type: "session.deleted", properties: { sessionID: id, info: sessionDTO(current) } });
    return current;
  }

  touch(id: string): void {
    this.db.run("UPDATE sessions SET updated=? WHERE id=?", Date.now(), id);
  }

  directories(): string[] {
    return this.db.all("SELECT directory, MAX(updated) AS updated FROM sessions WHERE deleted IS NULL GROUP BY directory ORDER BY updated DESC").map((row) => text(row, "directory"));
  }
}
