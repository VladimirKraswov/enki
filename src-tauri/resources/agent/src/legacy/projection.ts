import { createHash } from "node:crypto";
import type { ArchiveRecord, JsonObject, JsonValue, LegacyAnnotation, MessageDTO, MessageInfoDTO, MessagePartDTO, ToolStateDTO } from "./protocol.ts";
import { body, diagnostic, identities, number, object, text, whole, type IssueSink } from "./records.ts";

function annotation(record: ArchiveRecord, format: "v1" | "v2", sourceType: string, raw: JsonObject,
  metadata = false): LegacyAnnotation {
  return { format, sourceTable: format === "v2" ? "session_message" : record.table === "part" ? "part" : "message",
    sourceId: record.id ?? "", sourceType, ...(record.seq === null ? {} : { seq: record.seq }),
    render: metadata ? "metadata" : "chat", authority: "archive-only",
    context: metadata ? "marker-only" : "historical-chat", raw };
}
function partID(record: ArchiveRecord, key: string): string {
  return `prt_legacy_${createHash("sha256").update(`${record.sessionID}\0${record.id}\0${key}`).digest("hex")}`;
}
function time(record: ArchiveRecord, data: JsonObject, issue: IssueSink): MessageInfoDTO["time"] | null {
  if (data.time !== undefined && !object(data.time)) {
    issue(diagnostic(record, "ROW_INVALID", "Поле time сообщения должно быть объектом.", "error", "time")); return null;
  }
  const source = object(data.time) ? data.time : null;
  const created = source?.created === undefined ? whole(record.row.time_created) : whole(source.created);
  const completed = source?.completed === undefined || source.completed === null ? null : whole(source.completed);
  if (created === null || source && source.completed !== undefined && source.completed !== null && completed === null) {
    issue(diagnostic(record, "ROW_INVALID", "Некорректное время сообщения архива.", "error", "time"));
    return null;
  }
  return { created, completed };
}
function info(record: ArchiveRecord, data: JsonObject, role: "user" | "assistant", format: "v1" | "v2", issue: IssueSink): MessageInfoDTO | null {
  if (!record.id || !record.sessionID) { issue(diagnostic(record, "ROW_INVALID", "У сообщения отсутствует SQL identity.")); return null; }
  const timestamp = time(record, data, issue);
  if (!timestamp) return null;
  const model = object(data.model) ? data.model : null;
  const providerID = text(data.providerID) ?? text(model?.providerID);
  const modelID = text(data.modelID) ?? text(model?.id) ?? text(model?.modelID);
  const variant = text(data.variant) ?? text(model?.variant);
  const tokens = object(data.tokens) ? data.tokens : null;
  const cache = tokens && object(tokens.cache) ? tokens.cache : null;
  if (data.cost !== undefined && number(data.cost) === null || data.tokens !== undefined && !tokens
    || tokens && ["input", "output", "reasoning", "total"].some(key => tokens[key] !== undefined && number(tokens[key]) === null)
    || tokens?.cache !== undefined && !cache || cache && ["read", "write"].some(key => cache[key] !== undefined && number(cache[key]) === null)) {
    issue(diagnostic(record, "ROW_INVALID", "Некорректная стоимость или usage сообщения.")); return null;
  }
  const result: MessageInfoDTO = { id: record.id, sessionID: record.sessionID, role, time: timestamp,
    legacy: annotation(record, format, format === "v1" ? role : record.type ?? "unknown", data),
    ...(providerID === null ? {} : { providerID }), ...(modelID === null ? {} : { modelID }),
    ...(variant === null ? {} : { variant }), ...(data.variant === null ? { variant: null } : {}),
    ...(number(data.cost) === null ? {} : { cost: number(data.cost) ?? undefined }),
    ...(typeof data.finish === "string" || data.finish === null ? { finish: data.finish } : {}),
    ...(data.summary === true ? { summary: true } : {}),
    ...(typeof data.parentID === "string" ? { parentID: data.parentID } : {}),
    ...(data.error === undefined ? {} : { error: data.error }) };
  if (tokens) result.tokens = {
    ...(number(tokens.total) === null ? {} : { total: number(tokens.total) ?? undefined }),
    ...(number(tokens.input) === null ? {} : { input: number(tokens.input) ?? undefined }),
    ...(number(tokens.output) === null ? {} : { output: number(tokens.output) ?? undefined }),
    ...(number(tokens.reasoning) === null ? {} : { reasoning: number(tokens.reasoning) ?? undefined }),
    ...(cache ? { cache: { ...(number(cache.read) === null ? {} : { read: number(cache.read) ?? undefined }),
      ...(number(cache.write) === null ? {} : { write: number(cache.write) ?? undefined }) } } : {}),
  };
  return result;
}
function state(record: ArchiveRecord, value: JsonValue | undefined, format: "v1" | "v2", issue: IssueSink): ToolStateDTO | null {
  if (!object(value) || !["pending", "running", "completed", "error"].includes(String(value.status))) {
    issue(diagnostic(record, "TOOL_STATE_INVALID", "Неизвестное или повреждённое состояние инструмента.")); return null;
  }
  const status = value.status;
  if (status !== "pending" && status !== "running" && status !== "completed" && status !== "error") return null;
  const expectedString = format === "v2" && status === "pending";
  if (expectedString ? typeof value.input !== "string" : !object(value.input)) {
    issue(diagnostic(record, "TOOL_STATE_INVALID", "Некорректный input записанного инструмента.")); return null;
  }
  if (format === "v2" && status !== "pending"
    && (!Array.isArray(value.content) || !object(value.structured))) {
    issue(diagnostic(record, "TOOL_STATE_INVALID", "У V2 инструмента отсутствует content/structured.")); return null;
  }
  if (value.attachments !== undefined && !Array.isArray(value.attachments)) {
    issue(diagnostic(record, "TOOL_STATE_INVALID", "Некорректные вложения результата инструмента.")); return null;
  }
  const result: ToolStateDTO = { status, input: value.input, raw: value };
  if (value.title !== undefined) {
    if (typeof value.title !== "string") { issue(diagnostic(record, "TOOL_STATE_INVALID", "Некорректный title инструмента.")); return null; }
    result.title = value.title;
  }
  if (value.metadata !== undefined) result.metadata = value.metadata;
  if (value.time !== undefined) {
    if (!object(value.time) || value.time.start !== undefined && whole(value.time.start) === null
      || value.time.end !== undefined && whole(value.time.end) === null) {
      issue(diagnostic(record, "TOOL_STATE_INVALID", "Некорректное время инструмента.")); return null;
    }
    result.time = { ...(whole(value.time.start) === null ? {} : { start: whole(value.time.start) ?? undefined }),
      ...(whole(value.time.end) === null ? {} : { end: whole(value.time.end) ?? undefined }) };
  }
  if (format === "v1" && (status === "completed" && typeof value.output !== "string"
    || status === "error" && typeof value.error !== "string")) {
    issue(diagnostic(record, "TOOL_STATE_INVALID", "У завершённого V1 инструмента отсутствует output/error.")); return null;
  }
  if (format === "v2" && status === "error"
    && (!object(value.error) || value.error.type !== "unknown" || typeof value.error.message !== "string")) {
    issue(diagnostic(record, "TOOL_STATE_INVALID", "У V2 error отсутствует структурированная ошибка.")); return null;
  }
  // V2 error is structured; preserve it in raw and expose a compatible display string.
  if (value.error !== undefined) {
    if (format === "v1" && typeof value.error === "string") result.error = value.error;
    else if (format === "v2" && object(value.error) && value.error.type === "unknown" && typeof value.error.message === "string") result.error = value.error.message;
    else { issue(diagnostic(record, "TOOL_STATE_INVALID", "Некорректная ошибка инструмента.")); return null; }
  }
  if (value.output !== undefined && typeof value.output !== "string") {
    issue(diagnostic(record, "TOOL_STATE_INVALID", "Некорректный output инструмента.")); return null;
  }
  if (typeof value.output === "string") result.output = value.output;
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      if (!object(item) || item.type === "text" && typeof item.text !== "string"
        || item.type === "file" && (typeof item.uri !== "string" || typeof item.mime !== "string")) {
        issue(diagnostic(record, "TOOL_STATE_INVALID", "Повреждён content результата инструмента.")); return null;
      }
      if (item.type !== "text" && item.type !== "file") issue(diagnostic(record, "TOOL_CONTENT_UNSUPPORTED", "Неизвестный блок content инструмента сохранён в raw.", "warning"));
    }
    result.content = value.content;
    if (value.output === undefined) result.output = value.content.filter(object)
      .filter(item => item.type === "text" && typeof item.text === "string").map(item => String(item.text)).join("\n");
  }
  if (Array.isArray(value.attachments)) result.attachments = value.attachments;
  if (object(value.structured)) result.structured = value.structured;
  if (value.result !== undefined) result.result = value.result;
  if (value.outputPaths !== undefined && (!Array.isArray(value.outputPaths) || !value.outputPaths.every(item => typeof item === "string"))) {
    issue(diagnostic(record, "TOOL_STATE_INVALID", "Некорректные outputPaths инструмента.")); return null;
  }
  if (Array.isArray(value.outputPaths) && value.outputPaths.every((item): item is string => typeof item === "string")) result.outputPaths = value.outputPaths;
  return result;
}

export function v1Part(record: ArchiveRecord, sessionID: string, messageID: string, issue: IssueSink): MessagePartDTO | null {
  const data = body(record, "data", issue);
  if (!data) return null;
  if (!record.id) { issue(diagnostic(record, "ROW_INVALID", "У части отсутствует SQL identity.")); return null; }
  if (whole(record.row.time_created) === null || whole(record.row.time_updated) === null) {
    issue(diagnostic(record, "ROW_INVALID", "Некорректное SQL-время части архива.")); return null;
  }
  identities(record, data, { id: record.id, sessionID, messageID }, issue);
  if (typeof data.type !== "string" || !data.type) { issue(diagnostic(record, "PART_TYPE_INVALID", "У части отсутствует тип.")); return null; }
  const hidden = data.synthetic === true || data.ignored === true;
  const part: MessagePartDTO = { ...data, id: record.id, sessionID, messageID, type: data.type,
    ...(hidden ? { synthetic: true } : {}), legacy: annotation(record, "v1", data.type, data, hidden) };
  if ((data.type === "text" || data.type === "reasoning") && typeof data.text !== "string") {
    issue(diagnostic(record, "PART_INVALID", "Текстовая часть повреждена.")); return null;
  }
  for (const key of ["mime", "filename", "url", "text", "tool", "callID"] as const) {
    if (data[key] !== undefined && typeof data[key] !== "string") {
      issue(diagnostic(record, "PART_INVALID", `Некорректное поле ${key} части.`)); return null;
    }
  }
  if (data.metadata !== undefined && data.metadata !== null && !object(data.metadata)
    || data.synthetic !== undefined && typeof data.synthetic !== "boolean" || data.ignored !== undefined && typeof data.ignored !== "boolean") {
    issue(diagnostic(record, "PART_INVALID", "Некорректные flags/metadata части.")); return null;
  }
  if (data.type !== "tool") delete part.state;
  if (data.type === "file" && (typeof data.mime !== "string" || typeof data.url !== "string")) {
    issue(diagnostic(record, "PART_INVALID", "У файловой части отсутствует mime/url.")); return null;
  }
  if (!["text", "reasoning", "file", "tool", "compaction", "step-start", "step-finish", "snapshot", "patch", "agent", "subtask", "retry"].includes(data.type)) {
    issue(diagnostic(record, "PART_TYPE_UNSUPPORTED", "Неизвестная V1 часть сохранена в архиве.", "warning"));
    part.synthetic = true; part.ignored = true; part.legacy = annotation(record, "v1", data.type, data, true);
  }
  if (data.type === "tool") {
    if (typeof data.callID !== "string" || !data.callID || typeof data.tool !== "string" || !data.tool) {
      issue(diagnostic(record, "TOOL_ID_INVALID", "У записанного инструмента отсутствуют callID/tool.")); return null;
    }
    const tool = state(record, data.state, "v1", issue);
    if (!tool) return null;
    part.state = tool;
  }
  return part;
}
export function v1Message(record: ArchiveRecord, parts: MessagePartDTO[], issue: IssueSink): MessageDTO | null {
  const data = body(record, "data", issue);
  if (!data || !record.id || !record.sessionID) return null;
  identities(record, data, { id: record.id, sessionID: record.sessionID }, issue);
  if (data.role !== "user" && data.role !== "assistant") {
    issue(diagnostic(record, "ROLE_UNSUPPORTED", "Неизвестная роль V1; запись не превращена в сообщение человека.", "error", "role")); return null;
  }
  const metadata = info(record, data, data.role, "v1", issue);
  return metadata ? { info: metadata, parts } : null;
}

function metadataMessage(record: ArchiveRecord, data: JsonObject, issue: IssueSink): MessageDTO | null {
  const metadata = info(record, data, "assistant", "v2", issue);
  if (!metadata || !record.id || !record.sessionID) return null;
  const kind = record.type ?? "unknown";
  if (kind === "compaction" && (typeof data.summary !== "string" || typeof data.recent !== "string" || data.reason !== "auto" && data.reason !== "manual")
    || kind === "shell" && (typeof data.callID !== "string" || typeof data.command !== "string" || typeof data.output !== "string")
    || (kind === "system" || kind === "synthetic") && typeof data.text !== "string"
    || kind === "agent-switched" && typeof data.agent !== "string"
    || kind === "model-switched" && (!object(data.model) || typeof data.model.id !== "string" || typeof data.model.providerID !== "string"))
    issue(diagnostic(record, "ROW_INVALID", "Повреждены обязательные поля служебной записи V2."));
  const labels: Record<string, string> = { compaction: "сжатие контекста", shell: "записанный shell-запуск",
    synthetic: "синтетическая запись", system: "системная запись", "agent-switched": "смена агента", "model-switched": "смена модели" };
  const label = Object.hasOwn(labels, kind) ? labels[kind] : "неизвестный служебный тип";
  metadata.legacy = annotation(record, "v2", kind, data, true);
  if (kind === "compaction") metadata.summary = true;
  // Fixed marker has no raw command/prompt content; source text belongs only to the archive panel.
  return { info: metadata, parts: [{ id: partID(record, "metadata"), sessionID: record.sessionID, messageID: record.id,
    type: "legacy-metadata", text: `[Архив OpenCode: ${label}. Данные сохранены только для чтения; это не новая команда.]`,
    synthetic: true, ignored: true, legacy: annotation(record, "v2", kind, data, true) }] };
}
export function v2Message(record: ArchiveRecord, issue: IssueSink): MessageDTO | null {
  const data = body(record, "data", issue);
  if (!data || !record.id || !record.sessionID) return null;
  identities(record, data, { id: record.id, type: record.type ?? "", sessionID: record.sessionID }, issue);
  if (record.type !== "user" && record.type !== "assistant") {
    if (!["compaction", "shell", "synthetic", "system", "agent-switched", "model-switched"].includes(record.type ?? ""))
      issue(diagnostic(record, "TYPE_UNSUPPORTED", "Неизвестный V2 тип сохранён как архивные метаданные.", "warning", "type"));
    return metadataMessage(record, data, issue);
  }
  const metadata = info(record, data, record.type, "v2", issue);
  if (!metadata) return null;
  const parts: MessagePartDTO[] = [];
  const part = (key: string, source: JsonObject, type: string): MessagePartDTO => ({
    id: partID(record, key), sessionID: record.sessionID ?? "", messageID: record.id ?? "", type,
    legacy: annotation(record, "v2", type, source) });
  if (record.type === "user") {
    if (typeof data.text !== "string") { issue(diagnostic(record, "PART_INVALID", "У V2 user отсутствует текст.")); return null; }
    parts.push({ ...part("text", { text: data.text }, "text"), text: data.text });
    if (data.files !== undefined && !Array.isArray(data.files)) { issue(diagnostic(record, "PART_INVALID", "Некорректные V2 файлы.")); return null; }
    for (const [index, file] of (Array.isArray(data.files) ? data.files : []).entries()) {
      if (!object(file) || typeof file.uri !== "string" || typeof file.mime !== "string") {
        issue(diagnostic(record, "PART_INVALID", "Некорректное V2 вложение.")); continue;
      }
      parts.push({ ...part(`file:${index}`, file, "file"), url: file.uri, mime: file.mime,
        ...(typeof file.name === "string" ? { filename: file.name } : {}) });
    }
    return { info: metadata, parts };
  }
  if (!Array.isArray(data.content)) { issue(diagnostic(record, "PART_INVALID", "У V2 assistant отсутствует content.")); return null; }
  const sourceIds = new Set<string>();
  for (const [index, content] of data.content.entries()) {
    if (!object(content) || typeof content.type !== "string" || typeof content.id !== "string" || !content.id) {
      issue(diagnostic(record, "PART_INVALID", "Повреждён V2 assistant content.")); continue;
    }
    if (sourceIds.has(content.id)) { issue(diagnostic(record, "PART_ID_DUPLICATE", "Повторяется identity части V2 content.")); continue; }
    sourceIds.add(content.id);
    const item = part(`content:${index}:${content.id}`, content, content.type);
    if (content.type === "tool") {
      const tool = state(record, content.state, "v2", issue);
      if (!tool || typeof content.name !== "string" || !content.name) {
        if (tool) issue(diagnostic(record, "TOOL_ID_INVALID", "У V2 инструмента отсутствует name.")); continue;
      }
      // AssistantTool.id is the source call ID. It is not a separate V1 Part ID.
      item.callID = content.id; item.tool = content.name; item.state = tool;
      if (object(content.time)) item.state.time = { ...(whole(content.time.ran) === null ? {} : { start: whole(content.time.ran) ?? undefined }),
        ...(whole(content.time.completed) === null ? {} : { end: whole(content.time.completed) ?? undefined }) };
    } else if (content.type === "text" || content.type === "reasoning") {
      if (typeof content.text !== "string") { issue(diagnostic(record, "PART_INVALID", "Повреждён текст V2 content.")); continue; }
      item.text = content.text;
    } else {
      issue(diagnostic(record, "PART_TYPE_UNSUPPORTED", "Неизвестная V2 часть сохранена в архиве.", "warning"));
      item.type = "legacy-metadata"; item.synthetic = true; item.ignored = true;
      item.text = "[Архив OpenCode: неизвестная часть сохранена только для чтения.]";
      item.legacy = annotation(record, "v2", content.type, content, true);
    }
    parts.push(item);
  }
  return { info: metadata, parts };
}
