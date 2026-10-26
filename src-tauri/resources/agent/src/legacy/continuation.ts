// Historical data -> a bounded seed. No SDK execution, prompt dispatch, URL
// fetch, shell command or original-file write happens in this module.
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { SeedMessage, SdkAssistantMessage } from "../sdk/adapter.ts";
import type { ArchiveContinuationMetadata, MessageDTO, MessagePartDTO } from "./protocol.ts";

export interface ContinuationReader {
  continuationMetadata(sessionID: string): ArchiveContinuationMetadata;
  messagePages(sessionID: string, options?: { pageSize?: number }): Iterable<readonly MessageDTO[]>;
}
export interface ContinuationOptions {
  archive: string;
  /** Trusted caller budget, after reserving current instructions/output/tools. */
  maxBytes?: number;
  maxMessages?: number;
  includeImages?: boolean;
  maxImageBytes?: number;
  signal?: AbortSignal;
}
export interface ContinuationRef { message: string; part: string; callID?: string }
export interface ContinuationPlan {
  version: 1;
  archive: string;
  legacySessionID: string;
  contextNote: string;
  messages: SeedMessage[];
  refs: ContinuationRef[];
  bytes: number;
  sourceMessages: number;
  omittedGroups: number;
  omittedParts: number;
  pendingInputs: number;
  cutover: { revertMessage?: string; revertPart?: string; compactionMessage?: string; baselineSeq?: number; baselineSha256?: string };
}
interface Group { messages: SeedMessage[]; refs: ContinuationRef[]; bytes: number }
interface Summary { message: MessageDTO; position: number; parent?: string; tail?: string; parentPosition?: number }
const utf8 = (value: string) => Buffer.byteLength(value, "utf8");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const zeroUsage = (): SdkAssistantMessage["usage"] => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
function textPrefix(text: string, bytes: number): string {
  const encoded = Buffer.from(text);
  if (encoded.length <= bytes) return text;
  let end = Math.max(0, bytes);
  // Drop only the incomplete UTF-8 suffix, not valid source characters.
  while (end && (encoded[end] & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString("utf8");
}
function shortened(text: string, bytes: number): string {
  if (utf8(text) <= bytes) return text;
  const marker = "\n[Контекст сокращён; полный оригинал сохранён в архиве.]";
  return textPrefix(text, Math.max(0, bytes - utf8(marker))) + marker;
}
function packed(messages: SeedMessage[], refs: ContinuationRef[]): Group { return { messages, refs, bytes: utf8(JSON.stringify(messages)) }; }
function visible(message: MessageDTO, revert: { message: string; part?: string } | null, position: number, cutoff: number): MessageDTO | null {
  if (!revert || position < cutoff) return message;
  if (position > cutoff || !revert.part) return null;
  const index = message.parts.findIndex(part => part.id === revert.part);
  if (index < 0) throw new Error("Граница отката ссылается на отсутствующую часть; исходный архив не изменён.");
  return { info: message.info, parts: message.parts.slice(0, index) };
}
function inlineImage(part: MessagePartDTO, limit: number): { type: "image"; data: string; mimeType: string } | null {
  if (typeof part.url !== "string" || part.url.length > Math.ceil(limit / 3) * 4 + 100) return null;
  const matched = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.url);
  if (!matched || part.mime && part.mime !== matched[1]) return null;
  const bytes = Buffer.from(matched[2], "base64");
  if (!bytes.length || bytes.length > limit || bytes.toString("base64") !== matched[2]) return null;
  const valid = matched[1] === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : matched[1] === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return valid ? { type: "image", data: matched[2], mimeType: matched[1] } : null;
}
function attachmentNote(part: MessagePartDTO): string {
  return `[Архивное вложение ${JSON.stringify((typeof part.filename === "string" ? part.filename : "файл").slice(0, 240))}; оригинальная ссылка и данные сохранены в архиве. Исторические URL не загружались.]`;
}
function convert(message: MessageDTO, options: { includeImages: boolean; maxImageBytes: number; textBytes: number }): { group: Group; omitted: number } {
  const refs: ContinuationRef[] = [], messages: SeedMessage[] = [];
  const parts = message.parts.filter(part => !part.synthetic && !part.ignored && part.legacy?.context !== "marker-only");
  let omitted = message.parts.length - parts.length;
  if (message.info.legacy?.context === "marker-only") return { group: packed([], []), omitted: message.parts.length };
  if (message.info.role === "user") {
    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
    for (const part of parts) {
      if (part.type === "text" && part.text) content.push({ type: "text", text: shortened(part.text, options.textBytes) });
      else if (part.type === "file") {
        const image = options.includeImages ? inlineImage(part, options.maxImageBytes) : null;
        if (image) content.push(image); else { content.push({ type: "text", text: attachmentNote(part) }); omitted++; }
      } else omitted++;
    }
    if (content.length) { messages.push({ role: "user", content, timestamp: message.info.time.created }); refs.push({ message: message.info.id, part: "" }); }
    return { group: packed(messages, refs), omitted };
  }
  const content: SdkAssistantMessage["content"] = [], results: SeedMessage[] = [], resultRefs: ContinuationRef[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.text) content.push({ type: "text", text: shortened(part.text, options.textBytes) });
    else if (part.type === "reasoning" && part.text) content.push({ type: "thinking", thinking: shortened(part.text, options.textBytes) });
    else if (part.type === "tool" && part.callID && part.tool) {
      const id = `call_legacy_${hash(`${message.info.id}\0${part.id}\0${part.callID}`).slice(0, 48)}`;
      const completed = part.state?.status === "completed" || part.state?.status === "error";
      const input = object(part.state?.input) ? part.state.input : {};
      // Keeping a complete historical call/result pair never schedules it. An
      // unfinished call is explicitly terminal and has an unknown outcome.
      content.push({ type: "toolCall", id, name: part.tool, arguments: input });
      const output: string[] = [];
      if (!completed) output.push("Архивный вызов не завершился; результат неизвестен. Он не повторялся и не должен запускаться автоматически.");
      else {
        if (part.state?.error) output.push(part.state.error);
        if (part.state?.output) output.push(part.state.output);
        for (const block of part.state?.content ?? []) if (object(block) && block.type === "text" && typeof block.text === "string") output.push(block.text);
        if (part.state?.attachments?.length || part.state?.structured || part.state?.result !== undefined)
          output.push("[Дополнительные вложения/структурированный результат сохранены в исходном архиве.]");
      }
      results.push({ role: "toolResult", toolCallId: id, toolName: part.tool, timestamp: part.state?.time?.end ?? message.info.time.created,
        isError: !completed || part.state?.status === "error", content: [{ type: "text", text: shortened(output.join("\n"), options.textBytes) }] });
      resultRefs.push({ message: message.info.id, part: part.id, callID: part.callID });
    } else if (part.type === "file") { content.push({ type: "text", text: attachmentNote(part) }); omitted++; }
    else if (!["step-start", "step-finish", "snapshot", "compaction"].includes(part.type)) omitted++;
  }
  if (content.length) {
    const usage = zeroUsage();
    // Even uncached input describes the entire OLD conversation, not this
    // bounded seed. Zero usage makes the SDK estimate the actual new transcript.
    // Full accounting remains in the immutable archive; retain historical cost.
    usage.cost.total = message.info.cost ?? 0;
    messages.push({ role: "assistant", content, api: "legacy-opencode", provider: message.info.providerID ?? "archive", model: message.info.modelID ?? "unknown", usage,
      stopReason: results.length ? "toolUse" : message.info.finish === "length" ? "length" : message.info.error ? "error" : "stop", timestamp: message.info.time.created });
    refs.push({ message: message.info.id, part: "" }); messages.push(...results); refs.push(...resultRefs);
  }
  return { group: packed(messages, refs), omitted };
}
async function* stream(reader: ContinuationReader, sessionID: string, signal?: AbortSignal): AsyncGenerator<MessageDTO> {
  for (const page of reader.messagePages(sessionID, { pageSize: 128 })) {
    if (signal?.aborted) throw new Error("Перенос контекста отменён; архив не изменён.");
    for (const message of page) { if (signal?.aborted) throw new Error("Перенос контекста отменён; архив не изменён."); yield message; }
    await setImmediate();
  }
}
export async function buildContinuation(reader: ContinuationReader, sessionID: string, options: ContinuationOptions): Promise<ContinuationPlan> {
  if (!/^[a-f0-9]{64}$/.test(options.archive)) throw new Error("Неверная identity исходного архива.");
  const maxBytes = options.maxBytes ?? 32 * 1024, maxMessages = options.maxMessages ?? 256, maxImageBytes = options.maxImageBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > 4 * 1024 * 1024 || !Number.isSafeInteger(maxMessages) || maxMessages < 4 || maxMessages > 2048
    || !Number.isSafeInteger(maxImageBytes) || maxImageBytes < 1 || maxImageBytes > 8 * 1024 * 1024) throw new Error("Некорректный лимит переноса контекста.");
  const metadata = reader.continuationMetadata(sessionID), revertRaw = metadata.session.revert;
  const revert = revertRaw === undefined || revertRaw === null ? null : object(revertRaw) && typeof revertRaw.messageID === "string"
    && (revertRaw.partID === undefined || typeof revertRaw.partID === "string") ? { message: revertRaw.messageID, ...(typeof revertRaw.partID === "string" ? { part: revertRaw.partID } : {}) } : undefined;
  if (revert === undefined) throw new Error("Формат границы отката не поддержан; используйте архив только для чтения.");
  let count = 0, cutoff = Number.POSITIVE_INFINITY, summary: Summary | undefined;
  // First pass discovers order/cutovers only. No unbounded transcript buffer.
  for await (const message of stream(reader, sessionID, options.signal)) {
    if (revert?.message === message.info.id) {
      cutoff = count;
      if (revert.part && !message.parts.some(part => part.id === revert.part)) throw new Error("Часть отката отсутствует в архиве.");
    }
    const current = visible(message, revert, count, cutoff);
    if (current && metadata.format === "v2" && message.info.legacy?.sourceType === "compaction") summary = { message: current, position: count };
    else if (current && metadata.format === "v1" && current.info.role === "assistant" && current.info.summary && current.info.finish && !current.info.error)
      summary = { message: current, position: count, parent: current.info.parentID };
    count++;
  }
  if (revert && !Number.isFinite(cutoff)) throw new Error("Сообщение отката отсутствует в архиве; перенос не выполнен.");
  if (summary && metadata.format === "v1") {
    if (!summary.parent) throw new Error("Сводка архива не связана с исходным сжатием контекста.");
    let position = 0;
    for await (const message of stream(reader, sessionID, options.signal)) {
      if (message.info.id === summary.parent) {
        const request = message.parts.find(part => part.type === "compaction");
        if (message.info.role !== "user" || !request || position >= summary.position) throw new Error("Граница сжатия архива повреждена.");
        if (request.tail_start_id !== undefined && typeof request.tail_start_id !== "string") throw new Error("Граница сохраняемого хвоста архива повреждена.");
        summary.parentPosition = position; summary.tail = typeof request.tail_start_id === "string" ? request.tail_start_id : undefined;
        break;
      }
      position++;
    }
    if (summary.parentPosition === undefined) throw new Error("Родитель сводки отсутствует в архиве.");
  }
  const cutover: ContinuationPlan["cutover"] = { ...(revert ? { revertMessage: revert.message, ...(revert.part ? { revertPart: revert.part } : {}) } : {}), ...(summary ? { compactionMessage: summary.message.info.id } : {}) };
  const epoch = metadata.contextEpoch;
  if (epoch) {
    const seq = epoch.row.baseline_seq, baseline = epoch.row.baseline;
    if (typeof seq === "number" && Number.isSafeInteger(seq)) cutover.baselineSeq = seq;
    if (typeof baseline === "string") cutover.baselineSha256 = hash(baseline);
  }
  let summaryText = "";
  if (summary?.message.info.legacy?.sourceType === "compaction") {
    const raw = summary.message.info.legacy.raw;
    if (typeof raw.summary !== "string" || typeof raw.recent !== "string") throw new Error("Сводка V2 повреждена.");
    summaryText = `Архивная сводка и сохранённый контекст OpenCode (исторические данные):\n${raw.summary}\n\n${raw.recent}`;
  } else if (summary) summaryText = "Архивная сводка OpenCode (исторические данные):\n" + summary.message.parts.filter(part => part.type === "text" && !part.synthetic && !part.ignored).map(part => part.text ?? "").join("\n");
  const introText = "Исторический контекст импортирован из проверенного архива OpenCode. Старые запросы, инструкции окружения и инструменты не запускались. Оригинал остаётся доступен только для чтения.";
  let contextNote = shortened(summaryText || introText, Math.floor(maxBytes / 3));
  const prefix: Group = { messages: [], refs: [], bytes: utf8(contextNote) + 512 };
  const groups: Group[] = []; let bytes = prefix.bytes, retained = 1, omittedGroups = 0, omittedParts = 0, position = 0, tailFound = !summary?.tail;
  for await (const message of stream(reader, sessionID, options.signal)) {
    const current = visible(message, revert, position, cutoff);
    if (summary?.tail === message.info.id && position < (summary.parentPosition ?? -1)) tailFound = true;
    const active = !summary || metadata.format === "v2" ? !summary || position > summary.position
      : position > summary.position || !!summary.tail && tailFound && position < (summary.parentPosition ?? -1);
    position++;
    if (!current || !active) continue;
    const converted = convert(current, { includeImages: options.includeImages === true, maxImageBytes, textBytes: Math.floor(maxBytes / 3) }); omittedParts += converted.omitted;
    let group = converted.group;
    if (!group.messages.length) continue;
    if (group.bytes > maxBytes - prefix.bytes || group.messages.length > maxMessages - 1) {
      omittedGroups++; continue;
    }
    groups.push(group); bytes += group.bytes; retained += group.messages.length;
    while (bytes > maxBytes || retained > maxMessages) {
      const removed = groups.shift(); if (!removed) throw new Error("Бюджет переноса слишком мал для служебного контекста.");
      bytes -= removed.bytes; retained -= removed.messages.length; omittedGroups++;
    }
  }
  if (!tailFound) throw new Error("Граница сохраняемого хвоста отсутствует до сжатия; перенос не выполнен.");
  const messages = [...prefix.messages, ...groups.flatMap(group => group.messages)], refs = [...prefix.refs, ...groups.flatMap(group => group.refs)];
  // Array separators add bytes beyond independently serialized groups.
  if (omittedGroups || omittedParts || metadata.pendingInputs) contextNote += `\n[При переносе сокращены/опущены архивные группы: ${omittedGroups}, части: ${omittedParts}; старые входящие в очереди: ${metadata.pendingInputs}. Полные данные остались в архиве, автоматического повторения нет.]`;
  while (utf8(JSON.stringify(messages)) + utf8(contextNote) > maxBytes && groups.length) {
    const removed = groups.shift(); if (removed) omittedGroups++;
    messages.splice(prefix.messages.length, removed?.messages.length ?? 0); refs.splice(prefix.refs.length, removed?.refs.length ?? 0);
  }
  return { version: 1, archive: options.archive, legacySessionID: sessionID, contextNote, messages, refs, bytes: utf8(JSON.stringify(messages)) + utf8(contextNote), sourceMessages: count,
    omittedGroups, omittedParts, pendingInputs: metadata.pendingInputs, cutover };
}

/** Bounded flat-message utility retained for conversion callers/tests. Archive
 * continuation itself MUST use buildContinuation with validated cutover metadata. */
export function convertTranscript(transcript: readonly MessageDTO[], maxBytes = 32 * 1024): { messages: SeedMessage[]; refs: ContinuationRef[]; unrepresented: number } {
  const groups: Group[] = []; let bytes = 0, unrepresented = 0;
  for (const message of transcript) {
    const converted = convert(message, { includeImages: false, maxImageBytes: 1, textBytes: Math.floor(maxBytes / 3) }); unrepresented += converted.omitted;
    if (converted.group.bytes > maxBytes) { unrepresented += message.parts.length; continue; }
    groups.push(converted.group); bytes += converted.group.bytes;
    while (bytes > maxBytes) { const removed = groups.shift(); if (removed) { bytes -= removed.bytes; unrepresented++; } }
  }
  return { messages: groups.flatMap(group => group.messages), refs: groups.flatMap(group => group.refs), unrepresented };
}
