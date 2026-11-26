// Bounded transcript access. Confirming a save or listing a chat must never
// re-read a multi-hundred-megabyte JSONL: the same few newest entries are all
// that matters, and a session that grew large must stay usable instead of
// failing with "history has a wrong type or is too large".
import fs from "node:fs";

/** Files up to this size keep the exhaustive, strictly validated parse. */
export const FULL_READ_BUDGET = 8 * 1024 * 1024;
const HEADER_BUDGET = 64 * 1024;
/** First lines used for a title when the transcript is too large to read whole. */
export const HEAD_BUDGET = 256 * 1024;
/** Newest lines used to confirm a save or to prove the tail still parses. */
export const TAIL_BUDGET = 2 * 1024 * 1024;

export interface TailScan {
  /** Complete lines of the tail, oldest → newest. */
  lines: string[];
  /** The read started in the middle of the file, so older entries are absent. */
  truncated: boolean;
  size: number;
}

function open(file: string): { fd: number; size: number } {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("История Pi не является обычным файлом.");
    return { fd, size: stat.size };
  } catch (error) { fs.closeSync(fd); throw error; }
}

function readAt(fd: number, start: number, length: number): string {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(fd, buffer, offset, length - offset, start + offset);
    if (!read) break;
    offset += read;
  }
  return buffer.subarray(0, offset).toString("utf8");
}

/** First line (the session header) without reading the file. */
export function readHeaderLine(file: string): string | null {
  const { fd, size } = open(file);
  try { return readAt(fd, 0, Math.min(size, HEADER_BUDGET)).split("\n")[0] ?? null; }
  finally { fs.closeSync(fd); }
}

/** Oldest complete lines after the header, bounded by `budget` bytes. */
export function scanHead(file: string, budget = HEAD_BUDGET): string[] {
  const { fd } = open(file);
  try {
    const text = readAt(fd, 0, budget);
    const lines = text.split("\n");
    // The last line may be cut by the budget; the first is the session header.
    if (text.length === budget) lines.pop();
    return lines.filter(line => line.trim());
  } finally { fs.closeSync(fd); }
}

/** Newest complete lines of one transcript, bounded by `budget` bytes. */
export function scanTail(file: string, budget = FULL_READ_BUDGET): TailScan {
  const { fd, size } = open(file);
  try {
    const start = Math.max(0, size - Math.max(1024, budget));
    let text = readAt(fd, start, size - start);
    let truncated = start > 0;
    if (truncated) {
      // Drop the partial first line created by starting mid-file.
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : text.slice(newline + 1);
    }
    // A torn last line is the write in flight; it is not an entry yet.
    const lastBreak = text.lastIndexOf("\n");
    if (lastBreak !== text.length - 1) text = lastBreak === -1 ? "" : text.slice(0, lastBreak + 1);
    return { lines: text.split("\n").filter(line => line.trim()), truncated, size };
  } finally { fs.closeSync(fd); }
}

/**
 * Durable ids among the newest lines. Throws only when a complete line in the
 * scanned tail is not a JSON object: a partially written line is skipped above.
 */
export function confirmEntries(file: string, wanted: Set<string>, budget = FULL_READ_BUDGET): Set<string> {
  const found = new Set<string>();
  if (!wanted.size) return found;
  for (const line of scanTail(file, budget).lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error("Строка истории Pi повреждена."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Строка истории Pi повреждена.");
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && wanted.has(id)) found.add(id);
  }
  return found;
}
