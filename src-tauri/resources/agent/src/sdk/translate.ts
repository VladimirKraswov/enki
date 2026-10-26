// Live AgentSession events → Enki DTO events, one translator per session.
//
// While an assistant message streams it has no durable id yet, so it is shown
// under a provisional `live-*` id. When the SDK persists the message
// (`entry_appended`), the provisional message is removed and the durable entry
// is published under its real id, and later tool events address that id. A
// client that reconnects and replays the journal therefore converges on the
// same ids that history returns.

import type { MessagePartDTO, ServerEventDTO } from "../protocol.ts";
import { isSteeringText, visiblePromptText } from "../policy/prompt.ts";
import { splitArchiveText } from "../policy/archive.ts";
import type { SdkAssistantMessage, SdkEntry, SdkEvent, SdkMessage, SdkToolResultMessage } from "./adapter.ts";
import {
  assistantInfo, assistantParts, blocksOf, boundedDetails, finishOf, partId, tokensOf, toolOutputText,
  toolResultState, userParts,
} from "./history.ts";

export interface TranslatorHooks {
  /** A durable user entry was appended: lets the command ledger record its id. */
  onUserEntry?(entryId: string, timestamp: number | undefined, message: SdkMessage): void;
  onToolStart?(toolCallId: string, toolName: string): void;
  onToolEnd?(toolCallId: string, isError: boolean): void;
  onSettled?(): void;
  onError?(message: string): void;
}

interface LiveTool { messageID: string; index: number; part: MessagePartDTO }

/** Characters of a RUNNING tool's cumulative partial output sent per update. */
export const LIVE_PARTIAL_CHARS = 64 * 1024;
export const LIVE_PARTIAL_MARKER = "…[начало вывода скрыто; полный результат появится по завершении инструмента]\n";
/** Each update re-sends the whole cumulative partial; keep only its tail so a
 * chatty long tool costs O(bound) per update, not O(total). The completed
 * result (tool_execution_end and the durable entry) is never shortened here. */
export function livePartial(text: string): string {
  return text.length <= LIVE_PARTIAL_CHARS ? text : LIVE_PARTIAL_MARKER + text.slice(text.length - LIVE_PARTIAL_CHARS);
}

function role(message: SdkMessage | undefined): string {
  return (message as { role?: string } | undefined)?.role ?? "";
}

export class StreamTranslator {
  private seq = 0;
  private liveAssistant: string | null = null;
  private liveUser: string | null = null;
  /** Content indexes of the live assistant whose reasoning part was created. */
  private thinking = new Set<number>();
  private tools = new Map<string, LiveTool>();

  constructor(private readonly sessionID: string, private readonly hooks: TranslatorHooks = {}) {}

  private live(kind: "user" | "assistant"): string {
    this.seq += 1;
    return `live-${kind}-${Date.now().toString(36)}-${this.seq}`;
  }

  private status(status: Record<string, unknown>): ServerEventDTO {
    return { type: "session.status", properties: { sessionID: this.sessionID, status } };
  }

  private part(part: MessagePartDTO): ServerEventDTO {
    return { type: "message.part.updated", properties: { part } };
  }

  /** Normal messages are persisted after message_end listeners in SDK 0.85.1;
   * the worker supplies their actual newly observed SessionManager entries. */
  appended(entry: SdkEntry): ServerEventDTO[] { return this.onEntry(entry); }

  translate(event: SdkEvent): ServerEventDTO[] {
    switch (event.type) {
      case "agent_start":
        return [this.status({ type: "busy" })];
      case "agent_settled":
        this.liveAssistant = null;
        this.liveUser = null;
        this.thinking.clear();
        this.tools.clear();
        this.hooks.onSettled?.();
        return [{ type: "session.idle", properties: { sessionID: this.sessionID } }];
      case "message_start":
        return this.onMessageStart(event.message);
      case "message_update":
        return this.onDelta(event.assistantMessageEvent);
      case "message_end":
        return this.onMessageEnd(event.message);
      case "entry_appended":
        return this.onEntry(event.entry);
      case "tool_execution_start":
        this.hooks.onToolStart?.(event.toolCallId, event.toolName);
        return this.onTool(event.toolCallId, event.toolName, "running", event.args, undefined, { start: Date.now() });
      case "tool_execution_update":
        return this.onTool(event.toolCallId, event.toolName, "running", event.args,
          livePartial(toolOutputText(blocksOf((event.partialResult ?? {}) as { content?: unknown }))));
      case "tool_execution_end": {
        this.hooks.onToolEnd?.(event.toolCallId, event.isError);
        const result = (event.result ?? {}) as { content?: unknown; details?: unknown };
        return this.onTool(event.toolCallId, event.toolName, event.isError ? "error" : "completed", undefined,
          toolOutputText(blocksOf(result)), { end: Date.now() }, boundedDetails(result.details));
      }
      case "auto_retry_start":
        return [this.status({ type: "retry", attempt: event.attempt, message: event.errorMessage.slice(0, 300), next: Date.now() + event.delayMs })];
      case "auto_retry_end":
        if (event.success) return [this.status({ type: "busy" })];
        this.hooks.onError?.(event.finalError ?? "Повторные попытки исчерпаны.");
        return [{ type: "session.error", properties: { sessionID: this.sessionID, error: { name: "ProviderError", message: event.finalError ?? "Повторные попытки исчерпаны." } } }];
      case "compaction_start":
        return [this.status({ type: "waiting", message: "Сжатие контекста" })];
      case "compaction_end":
        if (event.errorMessage && !event.aborted)
          return [this.status({ type: "busy" }), { type: "session.compaction", properties: { sessionID: this.sessionID, ok: false, error: event.errorMessage.slice(0, 500) } }];
        return [{ type: "session.compaction", properties: { sessionID: this.sessionID, ok: !event.aborted && !!event.result,
          tokensBefore: event.result?.tokensBefore ?? null, tokensAfter: event.result?.estimatedTokensAfter ?? null } }];
      case "queue_update":
        return [{ type: "session.sdk_queue", properties: { sessionID: this.sessionID, steering: [...event.steering].length, followUp: [...event.followUp].length } }];
      case "session_info_changed":
        return [{ type: "session.renamed", properties: { sessionID: this.sessionID, title: event.name ?? null } }];
      default:
        return [];
    }
  }

  private onMessageStart(message: SdkMessage): ServerEventDTO[] {
    const kind = role(message);
    if (kind === "user") {
      const id = this.live("user");
      this.liveUser = id;
      const user = message as { content?: unknown; timestamp?: number };
      const text = blocksOf(user).filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n");
      const split = splitArchiveText(visiblePromptText(text, this.sessionID));
      return [
        { type: "message.updated", properties: { info: { id, sessionID: this.sessionID, role: "user", timingSource: "live",
          ...(typeof user.timestamp === "number" ? { timingKey: `pi:user:${user.timestamp}` } : {}), time: { created: Date.now() } } } },
        ...(split.text ? [this.part({ id: partId(id, 0), sessionID: this.sessionID, messageID: id, type: "text", text: split.text,
          ...(isSteeringText(text, this.sessionID) ? { metadata: { arvelaSteering: 1 } } : {}) })] : []),
      ];
    }
    if (kind !== "assistant") return [];
    const id = this.live("assistant");
    this.liveAssistant = id;
    this.thinking.clear();
    const assistant = message as SdkAssistantMessage;
    return [{ type: "message.updated", properties: { info: { id, sessionID: this.sessionID, role: "assistant",
      time: { created: Date.now() }, providerID: assistant.provider, modelID: assistant.model } } }];
  }

  private onDelta(delta: { type: string; contentIndex?: number; delta?: string; id?: string; toolName?: string; toolCall?: { id: string; name: string; arguments?: unknown } }): ServerEventDTO[] {
    const messageID = this.liveAssistant;
    if (!messageID) return [];
    const index = typeof delta.contentIndex === "number" ? delta.contentIndex : 0;
    switch (delta.type) {
      case "text_delta":
        return [{ type: "message.part.delta", properties: { sessionID: this.sessionID, messageID, partID: partId(messageID, index), field: "text", delta: String(delta.delta ?? "") } }];
      case "thinking_delta": {
        // The first chunk creates the typed reasoning part; later chunks are
        // linear deltas. Re-sending the cumulative text per chunk cost O(n²)
        // wire/journal/WebView work; the durable entry still carries it all.
        const text = String(delta.delta ?? "");
        const partID = partId(messageID, index);
        if (!this.thinking.has(index)) {
          this.thinking.add(index);
          return [this.part({ id: partID, sessionID: this.sessionID, messageID, type: "reasoning", text })];
        }
        return text ? [{ type: "message.part.delta", properties: { sessionID: this.sessionID, messageID, partID, field: "text", partType: "reasoning", delta: text } }] : [];
      }
      case "toolcall_start": {
        if (!delta.id) return [];
        const part: MessagePartDTO = { id: partId(messageID, index), sessionID: this.sessionID, messageID, type: "tool", tool: delta.toolName ?? "", callID: delta.id, state: { status: "pending" } };
        this.tools.set(delta.id, { messageID, index, part });
        return [this.part(part)];
      }
      case "toolcall_end": {
        if (!delta.toolCall) return [];
        const part: MessagePartDTO = { id: partId(messageID, index), sessionID: this.sessionID, messageID, type: "tool", tool: delta.toolCall.name,
          callID: delta.toolCall.id, state: { status: "running", input: delta.toolCall.arguments } };
        this.tools.set(delta.toolCall.id, { messageID, index, part });
        return [this.part(part)];
      }
      default:
        return [];
    }
  }

  private onMessageEnd(message: SdkMessage): ServerEventDTO[] {
    if (role(message) !== "assistant" || !this.liveAssistant) return [];
    const assistant = message as SdkAssistantMessage;
    const id = this.liveAssistant;
    const events: ServerEventDTO[] = [{ type: "message.updated", properties: { info: {
      id, sessionID: this.sessionID, role: "assistant", time: { created: Date.now(), completed: Date.now() },
      providerID: assistant.provider, modelID: assistant.model, tokens: tokensOf(assistant.usage), cost: assistant.usage?.cost?.total,
      finish: finishOf(assistant), ...(assistant.stopReason === "error" ? { error: { name: "ProviderError", message: assistant.errorMessage || "Модель завершила ответ ошибкой." } } : {}),
    } } }];
    if (assistant.stopReason === "error") this.hooks.onError?.(assistant.errorMessage || "Модель завершила ответ ошибкой.");
    return events;
  }

  /** Replace provisional messages with the durable entry the SDK just persisted. */
  private onEntry(entry: SdkEntry): ServerEventDTO[] {
    if (entry.type !== "message") return entry.type === "compaction" ? [{ type: "session.history", properties: { sessionID: this.sessionID, reason: "compaction" } }] : [];
    const message = entry.message;
    const kind = role(message);
    const created = Date.parse(entry.timestamp) || Date.now();
    if (kind === "user") {
      const events: ServerEventDTO[] = [];
      if (this.liveUser) events.push({ type: "message.removed", properties: { sessionID: this.sessionID, messageID: this.liveUser } });
      this.liveUser = null;
      const user = message as { content?: unknown; timestamp?: number };
      this.hooks.onUserEntry?.(entry.id, user.timestamp, message);
      events.push({ type: "message.updated", properties: { info: { id: entry.id, sessionID: this.sessionID, role: "user", timingSource: "live",
        ...(typeof user.timestamp === "number" ? { timingKey: `pi:user:${user.timestamp}` } : {}), time: { created } } } });
      for (const part of userParts(this.sessionID, entry.id, user)) events.push(this.part(part));
      return events;
    }
    if (kind === "assistant") {
      const events: ServerEventDTO[] = [];
      if (this.liveAssistant) events.push({ type: "message.removed", properties: { sessionID: this.sessionID, messageID: this.liveAssistant } });
      this.liveAssistant = null;
      const assistant = message as SdkAssistantMessage;
      const durable = new Map<string, MessagePartDTO>();
      events.push({ type: "message.updated", properties: { info: assistantInfo(this.sessionID, entry.id, assistant, created) } });
      for (const part of assistantParts(this.sessionID, entry.id, assistant, created, durable)) events.push(this.part(part));
      for (const [callId, part] of durable) {
        const index = Number(part.id.slice(part.id.lastIndexOf("#") + 1));
        this.tools.set(callId, { messageID: entry.id, index, part });
      }
      return events;
    }
    if (kind === "toolResult") {
      const result = message as SdkToolResultMessage;
      const live = this.tools.get(result.toolCallId);
      if (!live) return [];
      live.part = { ...live.part, state: toolResultState(live.part.state, result, created) };
      return [this.part(live.part)];
    }
    if (kind === "custom" || kind === "bashExecution")
      return [{ type: "session.history", properties: { sessionID: this.sessionID, reason: kind } }];
    return [];
  }

  private onTool(callId: string, toolName: string, status: "running" | "completed" | "error", input: unknown, output?: string,
    time?: { start?: number; end?: number }, metadata?: unknown): ServerEventDTO[] {
    const live = this.tools.get(callId);
    const messageID = live?.messageID ?? this.liveAssistant;
    if (!messageID) return [];
    const index = live?.index ?? 0;
    const previous = live?.part.state;
    const part: MessagePartDTO = {
      id: partId(messageID, index), sessionID: this.sessionID, messageID, type: "tool", tool: toolName, callID: callId,
      state: {
        ...previous, status, ...(input === undefined ? {} : { input }),
        ...(output !== undefined ? { output } : {}),
        ...(status === "error" ? { error: output || "Ошибка инструмента" } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
        time: { ...(previous?.time ?? {}), ...(time ?? {}),
          ...(output !== undefined && output !== previous?.output ? { output: Date.now() } : {}) },
      },
    };
    this.tools.set(callId, { messageID, index, part });
    return [this.part(part)];
  }
}
