// Durable Pi session entries → Enki message DTOs.
//
// Entry ids are the message ids, so live events, history pages, forks and the
// command ledger all name the same object. Nothing is truncated: compaction and
// branch summaries are shown as summary messages while the summarized entries
// stay in the branch.

import type { MessageDTO, MessageInfoDTO, MessagePartDTO, ToolStateDTO } from "../protocol.ts";
import { splitArchiveText } from "../policy/archive.ts";
import { isSteeringText, visiblePromptText } from "../policy/prompt.ts";
import type { SdkAssistantMessage, SdkEntry, SdkMessage, SdkToolResultMessage } from "./adapter.ts";

export const partId = (messageID: string, index: number): string => `${messageID}#${index}`;

type Block = { type: string; [key: string]: unknown };

export function blocksOf(message: { content?: unknown }): Block[] {
  const content = message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content.filter((b) => b && typeof b === "object") as Block[]) : [];
}

export function toolOutputText(blocks: readonly { type: string; text?: unknown }[] | undefined): string {
  if (!blocks?.length) return "";
  return blocks
    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : b.type === "image" ? "[изображение]" : ""))
    .filter(Boolean)
    .join("\n");
}

export function tokensOf(usage: SdkAssistantMessage["usage"] | undefined): MessageInfoDTO["tokens"] {
  if (!usage) return undefined;
  return {
    input: usage.input,
    output: usage.output,
    reasoning: usage.reasoning,
    total: usage.totalTokens,
    cache: { read: usage.cacheRead, write: usage.cacheWrite },
  };
}

export function finishOf(message: SdkAssistantMessage): string | null {
  const reason = message.stopReason;
  if (!reason || reason === "stop") return reason ?? null;
  return reason === "toolUse" ? "tool-calls" : reason;
}

const ATTACHED = /\n\n<attached_file name=("(?:[^"\\]|\\.)*") unsupported_as_instructions="true">\n([\s\S]*?)\n<\/attached_file>/g;

/** Text attachments are flattened into the prompt; rebuild them as file cards. */
export function splitAttachedFiles(text: string): { text: string; files: Array<{ name: string; content: string }> } {
  const files: Array<{ name: string; content: string }> = [];
  const visible = text.replace(ATTACHED, (original, name: string, content: string) => {
    try { files.push({ name: JSON.parse(name) as string, content }); return ""; }
    catch { return original; }
  });
  return { text: files.length ? visible : text, files };
}

function base64Utf8(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export function userParts(sessionID: string, id: string, message: { content?: unknown }): MessagePartDTO[] {
  const parts: MessagePartDTO[] = [];
  blocksOf(message).forEach((block, index) => {
    const base = { id: partId(id, index), sessionID, messageID: id };
    if (block.type === "text" && typeof block.text === "string") {
      const steering = isSteeringText(block.text, sessionID);
      const attached = splitAttachedFiles(visiblePromptText(block.text, sessionID));
      const split = splitArchiveText(attached.text);
      parts.push({ ...base, type: "text", text: split.text, ...(steering ? { metadata: { arvelaSteering: 1 } } : {}) });
      split.references.forEach((reference, n) => parts.push({
        ...base, id: `${base.id}-archive-${n}`, type: "text", synthetic: true,
        text: "", metadata: { arvelaAttachment: reference },
      }));
      attached.files.forEach((file, n) => parts.push({
        ...base, id: `${base.id}-file-${n}`, type: "file", mime: "text/plain", filename: file.name,
        url: `data:text/plain;base64,${base64Utf8(file.content)}`,
      }));
    } else if (block.type === "image" && typeof block.data === "string") {
      const mime = typeof block.mimeType === "string" ? block.mimeType : "image/png";
      parts.push({ ...base, type: "file", mime, filename: "изображение", url: `data:${mime};base64,${block.data}` });
    }
  });
  return parts;
}

export function assistantParts(sessionID: string, id: string, message: SdkAssistantMessage, created: number,
  tools?: Map<string, MessagePartDTO>): MessagePartDTO[] {
  const parts: MessagePartDTO[] = [];
  blocksOf(message).forEach((block, index) => {
    const base = { id: partId(id, index), sessionID, messageID: id };
    if (block.type === "text") parts.push({ ...base, type: "text", text: String(block.text ?? "") });
    else if (block.type === "thinking") parts.push({ ...base, type: "reasoning", text: String(block.thinking ?? "") });
    else if (block.type === "toolCall") {
      const part: MessagePartDTO = {
        ...base, type: "tool", tool: String(block.name ?? ""), callID: String(block.id ?? ""),
        state: { status: "running", input: block.arguments, time: { start: created } },
      };
      if (tools && typeof block.id === "string") tools.set(block.id, part);
      parts.push(part);
    }
  });
  return parts;
}

export function assistantInfo(sessionID: string, id: string, message: SdkAssistantMessage, created: number): MessageInfoDTO {
  return {
    id, sessionID, role: "assistant", timingSource: "entry",
    time: { created, completed: created },
    providerID: message.provider,
    modelID: message.model,
    ...(message.providerThinkingLevel ? { variant: message.providerThinkingLevel } : {}),
    tokens: tokensOf(message.usage),
    cost: message.usage?.cost?.total,
    finish: finishOf(message),
    ...(message.stopReason === "error"
      ? { error: { name: "ProviderError", message: message.errorMessage || "Модель завершила ответ ошибкой." } }
      : message.stopReason === "aborted" ? { error: { name: "MessageAbortedError", message: "Ответ остановлен." } } : {}),
  };
}

export function toolResultState(previous: ToolStateDTO | undefined, result: SdkToolResultMessage, ended: number): ToolStateDTO {
  const output = toolOutputText(blocksOf(result));
  const details = boundedDetails(result.details);
  return {
    ...previous,
    status: result.isError ? "error" : "completed",
    output,
    ...(result.isError ? { error: output || "Ошибка инструмента" } : {}),
    ...(details !== undefined ? { metadata: details } : {}),
    time: { ...(previous?.time ?? {}), end: ended },
  };
}

/** Tool details can be large (diffs, MCP payloads); keep a bounded copy only. */
export function boundedDetails(details: unknown): unknown {
  if (details === undefined) return undefined;
  try {
    const text = JSON.stringify(details);
    return text.length <= 65_536 ? (JSON.parse(text) as unknown) : { truncated: true, bytes: text.length };
  } catch { return undefined; }
}

const entryTime = (entry: SdkEntry): number => Date.parse(entry.timestamp) || 0;

function role(message: SdkMessage): string {
  return (message as { role?: string }).role ?? "";
}

/** Convert one branch (root → leaf) into the UI history shape. */
export function entriesToMessages(sessionID: string, entries: readonly SdkEntry[]): MessageDTO[] {
  const out: MessageDTO[] = [];
  const tools = new Map<string, MessagePartDTO>();
  for (const entry of entries) {
    const created = entryTime(entry);
    if (entry.type === "message") {
      const message = entry.message;
      const kind = role(message);
      if (kind === "toolResult") {
        const result = message as SdkToolResultMessage;
        const part = tools.get(result.toolCallId);
        if (part) part.state = toolResultState(part.state, result, created);
        continue;
      }
      if (kind === "user") {
        const user = message as { content?: unknown; timestamp?: number };
        out.push({
          info: { id: entry.id, sessionID, role: "user", timingSource: "entry",
            ...(typeof user.timestamp === "number" ? { timingKey: `pi:user:${user.timestamp}` } : {}),
            time: { created } },
          parts: userParts(sessionID, entry.id, user),
        });
        continue;
      }
      if (kind === "assistant") {
        const assistant = message as SdkAssistantMessage;
        out.push({ info: assistantInfo(sessionID, entry.id, assistant, created), parts: assistantParts(sessionID, entry.id, assistant, created, tools) });
        continue;
      }
      if (kind === "bashExecution") {
        const bash = message as { command?: string; output?: string; exitCode?: number; cancelled?: boolean };
        out.push({
          info: { id: entry.id, sessionID, role: "assistant", time: { created, completed: created } },
          parts: [{ id: partId(entry.id, 0), sessionID, messageID: entry.id, type: "tool", tool: "bash", callID: entry.id, synthetic: true,
            state: { status: bash.cancelled || (bash.exitCode ?? 0) !== 0 ? "error" : "completed", input: { command: bash.command }, output: String(bash.output ?? "") } }],
        });
        continue;
      }
      if (kind === "custom") {
        const custom = message as { display?: boolean; content?: unknown; customType?: string };
        if (!custom.display) continue;
        out.push({
          info: { id: entry.id, sessionID, role: "assistant", time: { created, completed: created } },
          parts: [{ id: partId(entry.id, 0), sessionID, messageID: entry.id, type: "text", text: toolOutputText(blocksOf(custom)),
            metadata: { piCustomType: custom.customType ?? "custom" } }],
        });
      }
      continue;
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      out.push({
        info: { id: entry.id, sessionID, role: "assistant", summary: true, time: { created, completed: created }, finish: "stop" },
        parts: [{ id: partId(entry.id, 0), sessionID, messageID: entry.id, type: "text", text: entry.summary,
          metadata: entry.type === "compaction" ? { piCompaction: { tokensBefore: entry.tokensBefore, firstKeptEntryId: entry.firstKeptEntryId } } : { piBranchSummary: { fromId: entry.fromId } } }],
      });
      continue;
    }
    if (entry.type === "custom_message" && entry.display) {
      out.push({
        info: { id: entry.id, sessionID, role: "assistant", time: { created, completed: created } },
        parts: [{ id: partId(entry.id, 0), sessionID, messageID: entry.id, type: "text",
          text: typeof entry.content === "string" ? entry.content : toolOutputText(entry.content),
          metadata: { piCustomType: entry.customType } }],
      });
    }
  }
  return out;
}

/** History pages are cut from the end, like the previous engines' APIs. */
export function pageMessages(all: MessageDTO[], limit: number, before?: string): { messages: MessageDTO[]; before?: string } {
  const end = before ? Math.max(0, all.findIndex((m) => m.info.id === before)) : all.length;
  const start = Math.max(0, end - Math.max(1, Math.min(limit, 1000)));
  const page = all.slice(start, end);
  return { messages: page, before: start > 0 ? page[0]?.info.id : undefined };
}

/** Exactly the entries for which entriesToMessages emits a message (its id is the entry id). */
function emitsMessage(entry: SdkEntry): boolean {
  if (entry.type === "message") {
    const kind = role(entry.message);
    if (kind === "user" || kind === "assistant" || kind === "bashExecution") return true;
    return kind === "custom" && !!(entry.message as { display?: boolean }).display;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") return true;
  return entry.type === "custom_message" && !!entry.display;
}

/**
 * pageMessages(entriesToMessages(entries), limit, before) without converting
 * (or cloning, via `copy`) anything outside the page: old attachment data
 * URLs, tool metadata and text far before the page are never touched. Tool
 * results AFTER the page that complete one of its tool calls are still applied,
 * so call/result linkage is identical to the full conversion.
 */
export function entriesPage(sessionID: string, entries: readonly SdkEntry[], limit: number, before?: string,
  copy: (slice: SdkEntry[]) => SdkEntry[] = (slice) => slice): { messages: MessageDTO[]; before?: string } {
  const emitted: number[] = [];
  for (let index = 0; index < entries.length; index++) if (emitsMessage(entries[index])) emitted.push(index);
  const end = before ? Math.max(0, emitted.findIndex((index) => entries[index].id === before)) : emitted.length;
  const start = Math.max(0, end - Math.max(1, Math.min(limit, 1000)));
  if (start >= end) return { messages: [] };
  const from = emitted[start], to = end < emitted.length ? emitted[end] : entries.length;
  const slice = copy(entries.slice(from, to));
  const messages = entriesToMessages(sessionID, slice);
  if (to < entries.length) {
    const calls = new Set<string>();
    for (const message of messages) for (const part of message.parts) if (part.type === "tool" && part.callID) calls.add(part.callID);
    const late = entries.slice(to).filter((entry) => entry.type === "message" && role(entry.message) === "toolResult"
      && calls.has((entry.message as SdkToolResultMessage).toolCallId));
    if (late.length) {
      const completed = new Map(entriesToMessages(sessionID, [...slice, ...copy(late)]).map((message) => [message.info.id, message]));
      for (let index = 0; index < messages.length; index++) messages[index] = completed.get(messages[index].info.id) ?? messages[index];
    }
  }
  return { messages, before: start > 0 ? messages[0]?.info.id : undefined };
}
