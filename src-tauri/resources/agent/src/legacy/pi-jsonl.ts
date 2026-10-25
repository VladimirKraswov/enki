// Strict, dependency-free archive validation. Never imports or invokes Pi SDK.
// The SDK 0.85.1 loader skips malformed lines and rewrites old versions: it is
// deliberately not a reader for an owner's original transcript.
import { createHash } from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectValue = { [key: string]: Json };
export interface PiDocument {
  header: ObjectValue;
  entries: ObjectValue[];
  version: 1 | 2 | 3;
  sessionId: string;
  cwd: string;
  leafId: string | null;
  counts: Record<string, number>;
}
export class PiArchiveError extends Error {
  constructor(readonly code: string, readonly line: number) {
    super(`История Pi не прошла проверку: ${code}, строка ${line}. Оригинал сохранён.`);
    this.name = "PiArchiveError";
  }
}
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
export function validPiId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && ID.test(value);
}
export function absoluteDirectory(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 32768
    && !/[\u0000-\u001f]/.test(value) && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
}
export function object(value: unknown): value is ObjectValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function fail(code: string, line: number): never { throw new PiArchiveError(code, line); }
function text(value: Json | undefined): value is string { return typeof value === "string"; }
function nonempty(value: Json | undefined): value is string { return text(value) && value.length > 0; }
function number(value: Json | undefined): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function timestamp(value: Json | undefined): boolean {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
}
function blocks(value: Json | undefined, allowed: readonly string[], line: number): void {
  if (!Array.isArray(value)) fail("invalid_content", line);
  for (const block of value) {
    if (!object(block) || !text(block.type) || !allowed.includes(block.type)) fail("invalid_content_block", line);
    switch (block.type) {
      case "text": if (!text(block.text)) fail("invalid_text", line); break;
      case "thinking": if (!text(block.thinking)) fail("invalid_thinking", line); break;
      case "image":
        if (!nonempty(block.mimeType) || !block.mimeType.startsWith("image/") || !text(block.data)
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(block.data)) fail("invalid_image", line);
        break;
      case "toolCall":
        if (!nonempty(block.id) || !nonempty(block.name) || !object(block.arguments)) fail("invalid_tool_call", line);
        break;
    }
  }
}
function userContent(value: Json | undefined, line: number): void {
  if (!text(value)) blocks(value, ["text", "image"], line);
}
function usage(value: Json | undefined, line: number): void {
  if (!object(value) || !["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(key => number(value[key]))) fail("invalid_usage", line);
  const cost = value.cost;
  if (!object(cost) || !["input", "output", "cacheRead", "cacheWrite", "total"].every(key => number(cost[key]))) fail("invalid_usage", line);
}
function message(value: Json | undefined, version: number, line: number): void {
  if (!object(value) || !text(value.role) || !number(value.timestamp)) fail("invalid_message", line);
  switch (value.role) {
    case "user": userContent(value.content, line); return;
    case "assistant":
      blocks(value.content, ["text", "thinking", "toolCall"], line);
      if (!nonempty(value.api) || !nonempty(value.provider) || !nonempty(value.model)
        || !["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].includes(String(value.stopReason)))
        fail("invalid_assistant", line);
      usage(value.usage, line); return;
    case "toolResult":
      blocks(value.content, ["text", "image"], line);
      if (!nonempty(value.toolCallId) || !nonempty(value.toolName) || typeof value.isError !== "boolean") fail("invalid_tool_result", line);
      return;
    case "bashExecution":
      if (!text(value.command) || !text(value.output) || typeof value.cancelled !== "boolean" || typeof value.truncated !== "boolean"
        || !(value.exitCode === undefined || value.exitCode === null || Number.isInteger(value.exitCode))) fail("invalid_bash_record", line);
      return;
    case "hookMessage":
    case "custom":
      // The only SDK-defined v2 role migration. Do not promote arbitrary roles.
      if (value.role === "hookMessage" && version > 2) fail("old_role_in_v3", line);
      if (!nonempty(value.customType) || typeof value.display !== "boolean") fail("invalid_custom_message", line);
      userContent(value.content, line); return;
    default: fail("unsupported_role", line);
  }
}
function entryShape(entry: ObjectValue, version: number, line: number): void {
  if (!timestamp(entry.timestamp) || !text(entry.type)) fail("invalid_entry", line);
  switch (entry.type) {
    case "message": message(entry.message, version, line); break;
    case "thinking_level_change": if (!nonempty(entry.thinkingLevel)) fail("invalid_thinking_level", line); break;
    case "model_change": if (!nonempty(entry.provider) || !nonempty(entry.modelId)) fail("invalid_model", line); break;
    case "compaction":
      if (!text(entry.summary) || !number(entry.tokensBefore)) fail("invalid_compaction", line);
      if (version === 1) {
        if (!Number.isInteger(entry.firstKeptEntryIndex) || Number(entry.firstKeptEntryIndex) < 1) fail("invalid_compaction_index", line);
      } else if (!validPiId(entry.firstKeptEntryId)) fail("invalid_compaction_reference", line);
      break;
    case "branch_summary": if (!nonempty(entry.fromId) || !text(entry.summary)) fail("invalid_branch_summary", line); break;
    case "custom": if (!nonempty(entry.customType)) fail("invalid_custom_entry", line); break;
    case "custom_message":
      if (!nonempty(entry.customType) || typeof entry.display !== "boolean") fail("invalid_custom_message", line);
      userContent(entry.content, line); break;
    case "label": if (!validPiId(entry.targetId) || !(entry.label === undefined || text(entry.label))) fail("invalid_label", line); break;
    case "session_info": if (!(entry.name === undefined || text(entry.name))) fail("invalid_session_info", line); break;
    default: fail("unsupported_entry_type", line);
  }
  if (entry.usage !== undefined) usage(entry.usage, line);
}
/** Checks every nonempty physical line, not just the selected SDK leaf. */
export function validatePiBytes(bytes: Uint8Array, expected: { id?: string; cwd?: string } = {}): PiDocument {
  if (!bytes.byteLength || bytes.byteLength > MAX_TRANSCRIPT_BYTES) fail("transcript_size", 1);
  let raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("invalid_utf8", 1); }
  const records: Array<{ value: ObjectValue; line: number }> = [];
  for (const [offset, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) fail("line_size", offset + 1);
    let value: unknown;
    try { value = JSON.parse(line); } catch { fail("malformed_json", offset + 1); }
    if (!object(value)) fail("nonobject_json", offset + 1);
    records.push({ value, line: offset + 1 });
  }
  const first = records.shift();
  if (!first || first.value.type !== "session") fail("missing_header", 1);
  const header = first.value, version = header.version ?? 1;
  if (version !== 1 && version !== 2 && version !== 3) fail("unsupported_version", first.line);
  if (!validPiId(header.id) || !absoluteDirectory(header.cwd) || !timestamp(header.timestamp)) fail("invalid_header", first.line);
  if (header.parentSession !== undefined && (!text(header.parentSession) || !absoluteDirectory(header.parentSession))) fail("invalid_parent_session", first.line);
  if (expected.id !== undefined && header.id !== expected.id) fail("session_identity_mismatch", first.line);
  if (expected.cwd !== undefined && header.cwd !== expected.cwd) fail("directory_identity_mismatch", first.line);
  const entries: ObjectValue[] = [], positions = new Map<string, number>();
  const counts: Record<string, number> = {};
  for (const [index, record] of records.entries()) {
    const entry = record.value;
    entryShape(entry, version, record.line);
    if (version >= 2) {
      if (!validPiId(entry.id) || !(entry.parentId === null || validPiId(entry.parentId))) fail("invalid_entry_identity", record.line);
      if (entry.id === header.id || positions.has(entry.id)) fail("duplicate_entry_id", record.line);
      if (entry.parentId !== null && !positions.has(entry.parentId)) fail("missing_or_forward_parent", record.line);
      positions.set(entry.id, index);
    } else if (entry.id !== undefined || entry.parentId !== undefined) fail("unexpected_v1_identity", record.line);
    counts[String(entry.type)] = (counts[String(entry.type)] ?? 0) + 1;
    entries.push(entry);
  }
  function ancestor(reference: string, current: number): boolean {
    if (version === 1) return false;
    let cursor = entries[current].parentId;
    while (typeof cursor === "string") {
      if (cursor === reference) return true;
      const index = positions.get(cursor);
      if (index === undefined) return false;
      cursor = entries[index].parentId;
    }
    return false;
  }
  for (const [index, entry] of entries.entries()) {
    const line = records[index].line;
    if (entry.type === "compaction") {
      if (version === 1) { if (Number(entry.firstKeptEntryIndex) > index) fail("compaction_not_ancestor", line); }
      else if (!ancestor(String(entry.firstKeptEntryId), index)) fail("compaction_not_ancestor", line);
    }
    if (entry.type === "label" && (positions.get(String(entry.targetId)) ?? Infinity) >= index) fail("label_target_missing", line);
    if (entry.type === "branch_summary" && (positions.get(String(entry.fromId)) ?? Infinity) >= index) fail("branch_target_missing", line);
    if (object(entry.message) && entry.message.role === "toolResult") {
      const result = entry.message;
      const found = entries.some((candidate, before) => before < index && (version === 1 || ancestor(String(candidate.id), index))
        && candidate.type === "message" && object(candidate.message) && candidate.message.role === "assistant"
        && Array.isArray(candidate.message.content) && candidate.message.content.some(block => object(block)
          && block.type === "toolCall" && block.id === result.toolCallId && block.name === result.toolName));
      if (!found) fail("tool_result_not_on_branch", line);
    }
  }
  return { header, entries, version, sessionId: header.id, cwd: header.cwd,
    leafId: entries.length && version >= 2 ? String(entries.at(-1)?.id) : null, counts };
}

/** Deterministic v1 tree IDs; v2 hook role is the exact upstream migration. */
export function runtimePiBytes(document: PiDocument, runtimeId: string, origin: string): { bytes: Buffer; entryMap: Record<string, string> } {
  if (!validPiId(runtimeId)) fail("invalid_runtime_id", 1);
  const entryMap: Record<string, string> = Object.create(null);
  const entries = document.entries.map((entry, index): ObjectValue => {
    const key = document.version === 1 ? `line:${index + 2}` : String(entry.id);
    const id = document.version === 1 ? createHash("sha256").update(origin).update("\0").update(document.sessionId).update("\0").update(key).digest("hex").slice(0, 32) : String(entry.id);
    entryMap[key] = id;
    return { ...entry, id, parentId: document.version === 1 ? index ? entryMap[`line:${index + 1}`] : null : entry.parentId,
      ...(object(entry.message) && entry.message.role === "hookMessage" ? { message: { ...entry.message, role: "custom" } } : {}) };
  });
  if (document.version === 1) for (const entry of entries) if (entry.type === "compaction") {
    entry.firstKeptEntryId = entries[Number(entry.firstKeptEntryIndex) - 1].id;
    delete entry.firstKeptEntryIndex;
  }
  const header = { ...document.header, version: 3, id: runtimeId };
  const bytes = Buffer.from([header, ...entries].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  validatePiBytes(bytes, { id: runtimeId, cwd: document.cwd });
  return { bytes, entryMap };
}
