import type { SQLOutputValue } from "node:sqlite";
import type { ArchiveCell, ArchiveDiagnostic, ArchiveRecord, JsonObject, JsonValue } from "./protocol.ts";

export type Row = Record<string, SQLOutputValue>;
export type IssueSink = (issue: ArchiveDiagnostic) => void;
export const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
export const text = (value: unknown): string | null => typeof value === "string" ? value : null;
export function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint" && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return null;
}
export function whole(value: unknown): number | null {
  const n = number(value);
  return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
}
export function cell(value: SQLOutputValue): ArchiveCell {
  if (typeof value === "bigint") return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value) : { encoding: "int64", value: value.toString() };
  if (value instanceof Uint8Array) return { encoding: "base64", value: Buffer.from(value).toString("base64") };
  return value;
}
function json(value: unknown): value is JsonValue {
  const pending: unknown[] = [value];
  while (pending.length) {
    const next = pending.pop();
    if (next === null || typeof next === "string" || typeof next === "boolean") continue;
    if (typeof next === "number") { if (!Number.isFinite(next)) return false; continue; }
    if (Array.isArray(next)) { for (const item of next) pending.push(item); continue; }
    if (object(next)) { for (const item of Object.values(next)) pending.push(item); continue; }
    return false;
  }
  return true;
}
export function diagnostic(record: Pick<ArchiveRecord, "table" | "id" | "sessionID">, code: string,
  message: string, severity: "error" | "warning" = "error", column?: string): ArchiveDiagnostic {
  return { severity, code, table: record.table, rowId: record.id, sessionID: record.sessionID,
    ...(column === undefined ? {} : { column }), message };
}

/** SQL identity and raw JSON are separate. Invalid JSON never becomes an empty object. */
export function record(table: string, row: Row, fields: readonly string[], issue: IssueSink): ArchiveRecord {
  const value: ArchiveRecord = { table, id: Object.hasOwn(row, "id") ? text(row.id) : text(row.session_id),
    sessionID: table === "session" ? text(row.id) : text(row.session_id), type: text(row.type),
    seq: whole(row.seq), row: Object.fromEntries(Object.entries(row).map(([key, item]) => [key, cell(item)])), json: {} };
  for (const key of fields) {
    if (!(key in row)) continue;
    const raw = cell(row[key]);
    if (row[key] === null) { value.json[key] = { raw, valid: true, value: null }; continue; }
    if (typeof row[key] !== "string") {
      value.json[key] = { raw, valid: false, value: null };
      issue(diagnostic(value, "JSON_INVALID", "JSON-поле архива имеет неверный SQL-тип.", "error", key));
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(row[key]);
      if (!json(parsed)) throw new Error("Nonfinite JSON");
      value.json[key] = { raw, valid: true, value: parsed };
    } catch {
      value.json[key] = { raw, valid: false, value: null };
      issue(diagnostic(value, "JSON_INVALID", "JSON-поле архива повреждено; исходные байты сохранены.", "error", key));
    }
  }
  return value;
}
export function body(value: ArchiveRecord, key: string, issue: IssueSink): JsonObject | null {
  const field = value.json[key];
  if (!field?.valid) return null;
  if (!object(field.value)) {
    issue(diagnostic(value, "JSON_OBJECT", "Ожидался JSON-объект записи архива.", "error", key));
    return null;
  }
  return field.value;
}
export function identities(value: ArchiveRecord, payload: JsonObject, authoritative: Record<string, string>, issue: IssueSink): void {
  for (const [key, expected] of Object.entries(authoritative)) {
    if (payload[key] !== undefined && payload[key] !== expected)
      issue(diagnostic(value, "JSON_ID_OVERRIDDEN", `JSON-поле ${key} отличается от SQL identity; используется SQL.`, "warning", key));
  }
}
