/** Read-only archive DTO additions. Merge these additive fields into the final wire contract. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
/** SQLite integers/blobs remain lossless and JSON-serializable in raw records. */
export type ArchiveCell = null | number | string | { encoding: "int64" | "base64"; value: string };
export interface ArchiveDiagnostic {
  severity: "error" | "warning";
  code: string;
  table: string;
  rowId: string | null;
  sessionID: string | null;
  column?: string;
  message: string;
}
export interface ArchiveJsonField { raw: ArchiveCell; valid: boolean; value: JsonValue | null }
export interface ArchiveRecord {
  table: string;
  id: string | null;
  sessionID: string | null;
  type: string | null;
  seq: number | null;
  row: Record<string, ArchiveCell>;
  json: Record<string, ArchiveJsonField>;
}
export interface LegacyAnnotation {
  format: "v1" | "v2";
  sourceTable: "message" | "part" | "session_message";
  sourceType: string;
  sourceId: string;
  seq?: number;
  render: "chat" | "metadata";
  /** Historical observations never authorize a new prompt/tool/input execution. */
  authority: "archive-only";
  context: "historical-chat" | "marker-only";
  raw: JsonObject;
}
export interface ToolStateDTO {
  status: "pending" | "running" | "completed" | "error";
  input?: unknown;
  output?: string;
  title?: string;
  metadata?: unknown;
  time?: { start?: number; end?: number };
  error?: string;
  /** V2 originals: don't replace content/structured/result with a flattened output string. */
  content?: JsonValue[];
  attachments?: JsonValue[];
  structured?: JsonObject;
  result?: JsonValue;
  outputPaths?: string[];
  raw?: JsonObject;
}
export interface MessagePartDTO {
  id: string; sessionID: string; messageID: string; type: string;
  mime?: string; filename?: string; url?: string; text?: string;
  tool?: string; callID?: string; state?: ToolStateDTO;
  synthetic?: boolean; ignored?: boolean; metadata?: Record<string, unknown> | null;
  legacy?: LegacyAnnotation;
  /** Unknown fields and nested data survive on a part, with SQL identity overriding JSON identity. */
  [key: string]: unknown;
}
export interface MessageInfoDTO {
  id: string; sessionID: string; role: "user" | "assistant";
  time: { created: number; completed?: number | null };
  error?: unknown; providerID?: string; modelID?: string; variant?: string | null;
  cost?: number;
  tokens?: { total?: number; input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  finish?: string | null; summary?: boolean; parentID?: string;
  timingKey?: string; timingSource?: "live" | "entry";
  legacy?: LegacyAnnotation;
}
export interface MessageDTO { info: MessageInfoDTO; parts: MessagePartDTO[] }
export interface LegacySession {
  id: string; directory: string; title: string; parentId: string | null;
  created: number; updated: number; archived: number | null; permission: unknown;
  metadata?: JsonValue; revert?: JsonValue; model?: JsonValue; agent?: string | null;
  projectId?: string | null; workspaceId?: string | null;
}
export interface ArchiveInput {
  id: string;
  admittedSeq: number;
  promotedSeq: number | null;
  delivery: string;
  pending: boolean;
  /** Raw prompt remains data: it is never projected as a completed user message. */
  record: ArchiveRecord;
}
export interface ArchiveProjection {
  sessionID: string;
  format: "v1" | "v2";
  complete: boolean;
  messages: MessageDTO[];
  records: ArchiveRecord[];
  pendingInputs: ArchiveInput[];
  diagnostics: ArchiveDiagnostic[];
}
export interface ArchiveSessionDetails {
  session: LegacySession;
  record: ArchiveRecord;
  project: ArchiveRecord | null;
  contextEpoch: ArchiveRecord | null;
  inputs: ArchiveInput[];
  v1Shadow: { messages: ArchiveRecord[]; parts: ArchiveRecord[] };
  related: Record<string, ArchiveRecord[]>;
  diagnostics: ArchiveDiagnostic[];
}

/** Minimal validated metadata for bounded continuation, without shadows/inbox payloads. */
export interface ArchiveContinuationMetadata {
  session: LegacySession;
  format: "v1" | "v2";
  contextEpoch: ArchiveRecord | null;
  pendingInputs: number;
}
