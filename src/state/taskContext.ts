import type { MessagePart } from "../api/types";
import { archiveReference } from '../attachments/archive';
import type { SessionChatState } from "./chatReducer";
import { normalizeLocalPath, isAbsoluteLocalPath, pathIsWithin } from "../util/paths";

/** How a result path appeared in the transcript. A pointer into history, not proof the file exists. */
export type ResultOrigin = "write" | "edit" | "patch" | "link";
export interface ContextFile {
  key: string; name: string; messageID: string; path?: string; mime?: string; url?: string;
  origin?: ResultOrigin; at?: number;
}
export interface ContextSnapshot { sources: ContextFile[]; results: ContextFile[] }
/** A child session that a `task` tool call in this chat reported starting. */
export interface SubagentRun { sessionID: string; messageID: string; status: "pending" | "running" | "completed" | "error" }

/**
 * Bidirectional overrides and control characters can disguise a name
 * ("report\u202Efdp.exe" displays as "reportexe.pdf"). Show them as replacement marks.
 */
export function safeLabel(value: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "\uFFFD").trim();
  if (!clean) return "Без имени";
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const validPath = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim() && value.length <= 4096 && !/[\0\r\n]/.test(value);

/** An explicit local-file link target, without line anchors; remote URLs and prose are not files. */
export function linkedPath(target: string): string | null {
  let value = target.trim();
  if (/^file:\/\//i.test(value)) {
    try { value = decodeURIComponent(new URL(value).pathname); } catch { return null; }
    if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1); // file:///C:/x → C:/x
  } else if (value.includes("%")) {
    try { value = decodeURIComponent(value); } catch { /* a literal percent sign */ }
  }
  value = value.replace(/#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/, "").replace(/(?::\d+){1,2}$/, "");
  return validPath(value) && isAbsoluteLocalPath(value) ? value : null;
}

interface PartFacts {
  file?: { name: string; mime?: string };
  outputs: { path: string; origin: ResultOrigin }[];
  subagent?: { sessionID: string; status: SubagentRun["status"] };
}
// Parts are replaced, never mutated, when they change. Caching per part object keeps
// a streaming delta from re-scanning every earlier answer with regular expressions.
const facts = new WeakMap<MessagePart, PartFacts>();
const LINK = /\[[^\]\n]*\]\(<?([^\n)]+?)>?\)/g;
function partFacts(p: MessagePart): PartFacts {
  const cached = facts.get(p);
  if (cached) return cached;
  const out: PartFacts = { outputs: [] };
  if (p.type === "file") out.file = { name: safeLabel(p.filename || "Вложение"), mime: p.mime };
  if (p.type === "patch") {
    const files = (p as MessagePart & { files?: unknown }).files;
    if (Array.isArray(files)) for (const file of files) if (validPath(file)) out.outputs.push({ path: file, origin: "patch" });
  }
  if (p.type === "tool" && p.state?.status === "completed" && ["write", "edit", "apply_patch"].includes(p.tool || "")) {
    const input = p.state.input as Record<string, unknown> | undefined;
    const path = input?.filePath ?? input?.path;
    if (validPath(path)) out.outputs.push({ path, origin: p.tool === "write" ? "write" : p.tool === "edit" ? "edit" : "patch" });
  }
  if (p.type === "tool" && p.tool === "task" && p.state) {
    const metadata = p.state.metadata as Record<string, unknown> | undefined;
    const id = metadata?.sessionId ?? metadata?.sessionID;
    if (typeof id === "string" && id) out.subagent = { sessionID: id, status: p.state.status };
  }
  if (p.type === "text" && p.text)
    for (const match of p.text.matchAll(LINK)) {
      const path = linkedPath(match[1]);
      if (path) out.outputs.push({ path, origin: "link" });
    }
  facts.set(p, out);
  return out;
}

function eachPart(chat: SessionChatState, visit: (part: MessagePart, facts: PartFacts, role: string | undefined, at: number | undefined) => void) {
  for (const id of chat.messageOrder) {
    const message = chat.messages[id];
    for (const pid of chat.partsByMessage[id] || []) {
      const p = chat.parts[pid];
      if (p && !p.ignored) visit(p, partFacts(p), message?.role, message?.time?.created);
    }
  }
}

/**
 * Derive actual inputs/outputs from the loaded transcript, newest first, without
 * following links or reading files. Sources are files the user attached; results
 * are completed file writes and explicit local-file links in answers.
 */
export function sessionContext(chat?: SessionChatState): ContextSnapshot {
  const sources: ContextFile[] = [], results = new Map<string, ContextFile>();
  if (!chat) return { sources, results: [] };
  eachPart(chat, (p, f, role, at) => {
    if (f.file && role === "user") sources.push({ key: p.id, name: f.file.name, mime: f.file.mime, url: p.url, messageID: p.messageID, at });
    const archive = !p.ignored && role === 'user' ? archiveReference(p.metadata?.arvelaAttachment) : undefined;
    if (archive) sources.push({key: p.id, name: safeLabel(archive.name), mime: 'application/zip', url: archive.url, messageID: p.messageID, at});
    if (role !== "assistant") return;
    for (const { path: raw, origin } of f.outputs) {
      const path = normalizeLocalPath(raw);
      // Re-inserting moves a path to its latest mention.
      results.delete(path);
      results.set(path, { key: path, path, name: safeLabel(path.split("/").filter(Boolean).pop() || path), messageID: p.messageID, origin, at });
    }
  });
  return { sources: sources.reverse(), results: [...results.values()].reverse() };
}

/**
 * Only `sessionContext(chat).sources` (files the user attached), visiting user
 * messages only: assistant parts (tool output, long answers) are not scanned,
 * so an open attachment viewer stays cheap while chats stream.
 */
export function sessionSources(chat?: SessionChatState): ContextFile[] {
  const sources: ContextFile[] = [];
  if (!chat) return sources;
  for (const id of chat.messageOrder) {
    const message = chat.messages[id];
    if (message?.role !== "user") continue;
    for (const pid of chat.partsByMessage[id] || []) {
      const p = chat.parts[pid];
      if (!p || p.ignored) continue;
      const f = partFacts(p), at = message.time?.created;
      if (f.file) sources.push({ key: p.id, name: f.file.name, mime: f.file.mime, url: p.url, messageID: p.messageID, at });
      const archive = archiveReference(p.metadata?.arvelaAttachment);
      if (archive) sources.push({ key: p.id, name: safeLabel(archive.name), mime: 'application/zip', url: archive.url, messageID: p.messageID, at });
    }
  }
  return sources.reverse();
}

/** Child sessions this chat's `task` calls reported. Other children (forks, …) are not subagents. */
export function subagentRuns(chat?: SessionChatState): Map<string, SubagentRun> {
  const runs = new Map<string, SubagentRun>();
  if (!chat) return runs;
  eachPart(chat, (p, f, role) => {
    if (f.subagent && role === "assistant") runs.set(f.subagent.sessionID, { ...f.subagent, messageID: p.messageID });
  });
  return runs;
}

export function projectFile(path: string, directory: string): string | null {
  const root = normalizeLocalPath(directory), clean = normalizeLocalPath(path);
  if (clean.split("/").some(segment => segment === ".." || segment === ".")) return null;
  const absolute = isAbsoluteLocalPath(clean) ? clean : normalizeLocalPath(`${root}/${clean}`);
  if (!pathIsWithin(absolute, root) || absolute === root) return null;
  return absolute.slice(root.length + (root.endsWith("/") ? 0 : 1));
}
