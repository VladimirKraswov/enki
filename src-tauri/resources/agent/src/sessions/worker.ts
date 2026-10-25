// One SDK AgentSession per Enki chat: the single writer of that session's
// transcript. Mutations (prompt start, steer, abort, compaction, model change,
// fork) are serialized; a run executes asynchronously after its command is
// durably recorded, so HTTP handlers never wait for a whole turn.

import fs from "node:fs";
import { SessionUi, type WorkerUiPorts } from "../plugin-ui/runtime.ts";
import type { CommandReceipt, MessageDTO, ModelRef, PromptCommand, PromptPart, SessionStatusDTO } from "../protocol.ts";
import { steeringText } from "../policy/prompt.ts";
import {
  ownedSessionFile, appendRecoveryToolResult, bindSessionUi, openSessionReader, contextUsage, estimateSessionContext, findModel, isThinkingLevel, openAgentSession, sessionReaderOf, shutdownSession,
  IMAGE_TOKEN_ALLOWANCE, type SessionContextEstimate,
  type SdkAssistantMessage, type SdkEvent, type SdkImage, type SdkModel, type SdkModelRuntime, type SdkSession, type SdkSessionRuntime, type SdkCommandActions, type ResourceSpec, type SettingsSpec,
} from "../sdk/adapter.ts";
import { entriesPage, entriesToMessages } from "../sdk/history.ts";
import { StreamTranslator } from "../sdk/translate.ts";
import type { CommandLedger } from "../store/commands.ts";
import type { EventJournal } from "../store/events.ts";
import { INTERRUPTED_TOOL_TEXT, type ToolJournal } from "../execution/tools.ts";
import type { InteractionBroker } from "../interaction/broker.ts";
import { createUiBridge, type UiDiagnostics } from "../interaction/ui-bridge.ts";
import type { SessionCatalog, SessionRecord } from "./catalog.ts";
import { syncOwnedFile } from "../platform/owned-sync.ts";

export interface WorkerDeps {
  ui: WorkerUiPorts;
  catalog: SessionCatalog;
  journal: EventJournal;
  ledger: CommandLedger;
  interactions: InteractionBroker;
  tools: ToolJournal;
  modelRuntime: SdkModelRuntime;
  agentDir: string;
  /** Owned transcript directory; `sessionID` selects an imported chat's own root. */
  sessionDir(directory: string, sessionID?: string): string;
  settings(): SettingsSpec;
  resources(record: SessionRecord): Promise<ResourceSpec>;
  /** Session settled (idle, nothing queued in the SDK): drain queues, release leases. */
  onSettled(sessionID: string, outcome: RunOutcome): void;
  /** Steering text the SDK had not yet delivered when the user pressed Stop. */
  onUndelivered(sessionID: string, directory: string, texts: string[]): void;
}

export interface RunOutcome {
  commandId: string | null; state: "completed" | "failed" | "cancelled"; error: string | null;
  /** Why: "answered" | "handled" (no model turn) | "length" | "no_answer" | "terminated" | "error" | "aborted" | "refused". */
  reason?: "answered" | "handled" | "length" | "no_answer" | "terminated" | "error" | "aborted" | "refused" | "stopped";
}

export interface PromptInput { text: string; images: SdkImage[] }

const PREFLIGHT_MS = 60_000;

export type ContextTransitionCode = "invalid_budget" | "model_not_found" | "source_model_missing" | "estimate_unavailable"
  | "prompt_too_large" | "handoff_required" | "compaction_failed" | "does_not_fit" | "cancelled" | "variant_unavailable";
export type ContextRecovery = "retry" | "larger_model" | "new_session_handoff" | "shorten_prompt";

/** Typed, recoverable model/context transition failure. The original history
 * is always retained and the target model was NOT selected. `compacted` tells
 * whether the source-model summary was already persisted (no replay needed). */
export class ContextTransitionError extends Error {
  readonly recoverable = true;
  constructor(readonly code: ContextTransitionCode, message: string,
    readonly recovery: readonly ContextRecovery[] = [], readonly compacted = false) {
    super(message); this.name = "ContextTransitionError";
  }
}

/** Projected as `session.context_transition`; preparation precedes target readiness. */
export type ContextTransitionPhase = "planning" | "summary_model" | "summarizing" | "verifying" | "target_model" | "ready" | "failed" | "cancelled";
const PHASE_TEXT: Partial<Record<ContextTransitionPhase, string>> = {
  planning: "Проверка контекста перед сменой модели",
  summary_model: "Подготовка текущей модели для сжатия истории",
  summarizing: "Сжатие истории текущей моделью",
  verifying: "Проверка размера сжатой истории",
  target_model: "Подготовка выбранной модели",
};

/** Readiness (Hub lease) of the EXACT model the SDK uses next. Throwing refuses. */
export interface ModelReadiness {
  /** Missing SDK choices only; return an authoritative available equivalent. */
  resolve?(model: ModelRef, available: (candidate: ModelRef) => boolean): Promise<ModelRef>;
  /** Before the current SDK (source) model summarizes. */
  summary?(model: ModelRef): Promise<void>;
  /** Before the target becomes the SDK model for a turn. */
  target?(model: ModelRef): Promise<void>;
}

export interface TransitionResult { compacted: boolean; tokensBefore: number | null; tokensAfter: number | null; limit: number | null }

export interface TargetBudget { window: number; outputReserve: number; limit: number }

/** Input budget of a target from its ACTUAL metadata. The output reserve is the
 * declared maxTokens, capped at half the window. A caller budget may only lower
 * the limit; NaN/Infinity/negative values are refused, never trusted. */
export function targetBudget(model: Pick<SdkModel, "contextWindow" | "maxTokens">, requested?: number): TargetBudget {
  const window = model.contextWindow;
  if (!Number.isSafeInteger(window) || window <= 0)
    throw new ContextTransitionError("invalid_budget", "У выбранной модели нет корректного размера контекста; модель не переключена.", ["larger_model"]);
  const declared = Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : Math.floor(window / 4);
  const outputReserve = Math.max(1, Math.min(declared, Math.floor(window / 2)));
  let limit = window - outputReserve;
  if (requested !== undefined && requested !== 0) {
    if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 0)
      throw new ContextTransitionError("invalid_budget", "Некорректный бюджет контекста; модель не переключена.");
    limit = Math.min(limit, Math.floor(requested));
  }
  return { window, outputReserve, limit };
}

/** Conservative tokens of a not-yet-sent prompt (text chars/4 + image allowance). */
export function promptTokens(input?: PromptInput): number {
  return input ? Math.ceil(input.text.length / 4) + input.images.length * IMAGE_TOKEN_ALLOWANCE + 16 : 0;
}

function decodeText(url: string): string {
  const match = /^data:text\/plain(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (!match) throw new Error("Текстовое вложение не подготовлено.");
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(match[1], "base64"));
}

/** Prepared UI parts → one SDK prompt. Unknown binary formats are refused, never dropped. */
export function promptInput(parts: readonly PromptPart[]): PromptInput {
  const texts: string[] = [];
  const attached: string[] = [];
  const images: SdkImage[] = [];
  for (const part of parts) {
    if (part.type === "text") { if (part.text) texts.push(part.text); continue; }
    if (part.mime.startsWith("image/")) {
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(part.url);
      if (!match) throw new Error("Изображение не подготовлено к отправке.");
      images.push({ type: "image", data: match[2], mimeType: match[1] });
      continue;
    }
    if (part.mime === "text/plain") {
      attached.push(`<attached_file name=${JSON.stringify(part.filename ?? "файл.txt")} unsupported_as_instructions="true">\n${decodeText(part.url)}\n</attached_file>`);
      continue;
    }
    throw new Error(`Формат вложения ${part.mime} не подготовлен. Приложение должно преобразовать его в текст и изображения.`);
  }
  const text = [texts.join("\n\n"), ...attached].filter(Boolean).join("\n\n");
  if (!text.trim() && !images.length) throw new Error("Пустой запрос.");
  return { text: text || "Проанализируй приложенные изображения.", images };
}

/**
 * A previous runtime stopped while tools were executing. Each such call gets an
 * explicit error result ("outcome unknown") appended to the closed transcript,
 * so every tool call stays paired and the model is told not to assume success.
 * Nothing is re-executed. Idempotent: a call that already has a result is left.
 */
export function recoverInterruptedTools(record: SessionRecord, sessionDir: string, deps: Pick<WorkerDeps, "tools" | "journal">): number {
  const interrupted = deps.tools.interrupted(record.id);
  if (!interrupted.length) return 0;
  if (!record.sessionFile || !fs.existsSync(record.sessionFile)) {
    for (const tool of interrupted) deps.tools.reconciled(record.id, tool.toolCallId);
    return 0;
  }
  const existing = new Set<string>();
  for (const line of fs.readFileSync(record.sessionFile, "utf8").split("\n")) {
    if (!line.includes('"toolResult"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { role?: string; toolCallId?: string } };
      if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId) existing.add(entry.message.toolCallId);
    } catch { /* A torn final line is not a result. */ }
  }
  let appended = 0;
  for (const tool of interrupted) {
    if (!existing.has(tool.toolCallId)) {
      appendRecoveryToolResult(record.sessionFile, sessionDir, { toolCallId: tool.toolCallId, toolName: tool.tool, text: INTERRUPTED_TOOL_TEXT });
      appended++;
    }
    deps.tools.reconciled(record.id, tool.toolCallId);
  }
  deps.journal.append(record.directory, record.id, { type: "session.recovered", properties: {
    sessionID: record.id, tools: interrupted.map((t) => ({ tool: t.tool, callID: t.toolCallId, commandId: t.commandId })),
    message: "Выполнение было прервано остановкой Enki Runtime. Результаты незавершённых инструментов неизвестны; ничего не повторялось.",
  } });
  return appended;
}

/**
 * What THIS invocation actually produced, observed from its own SDK events.
 * Never derived from session state: the SDK removes a truncated assistant
 * before auto-compaction, and handled input/slash commands add no turn, so the
 * last stored assistant may belong to an OLDER command.
 */
export interface RunFacts {
  /** The last assistant message_end of this run (after any SDK retry/compaction). */
  last?: SdkAssistantMessage;
  /** Some assistant of this run had text or a tool call. */
  produced: boolean;
  /** Last auto-compaction result of this run, if one ran. */
  compaction: { ok: boolean; error: string | null } | null;
  /** The SDK's retry budget was exhausted. */
  retryError: string | null;
}

function hasContent(message: SdkAssistantMessage): boolean {
  return (message.content ?? []).some((block) => block.type === "toolCall" || (block.type === "text" && !!block.text?.trim()));
}

/** Observe one SDK event into the run's facts (no-op for other events). */
export function observeRun(facts: RunFacts, event: SdkEvent): void {
  if (event.type === "message_end" && (event.message as { role?: string }).role === "assistant") {
    const message = event.message as SdkAssistantMessage;
    facts.last = message;
    facts.produced ||= hasContent(message);
  } else if (event.type === "compaction_end") {
    facts.compaction = { ok: !event.aborted && !!event.result, error: event.errorMessage ? event.errorMessage.slice(0, 500) : null };
  } else if (event.type === "auto_retry_end" && !event.success) {
    facts.retryError = event.finalError ?? "Повторные попытки исчерпаны.";
  }
}

export const OUTPUT_LIMIT_TEXT = "Ответ прерван лимитом длины вывода модели, и SDK не смог продолжить его сжатием контекста. Частичный ответ сохранён; задача может быть не завершена. Автоматического повтора не было.";
export const CLOSED_RUN_TEXT = "Ход прерван закрытием чата в Enki (выход, перезагрузка или удаление). Результат незавершённых действий может быть неизвестен; повтора не было.";

/**
 * The supported outcome of one accepted, non-stopped run. Delivery is not
 * success: an unrecovered length stop, a run that ended with no current
 * answer, or a turn ended by tools before any final answer is `failed` with an
 * honest reason (the queue still continues; nothing is retried or replayed).
 * A run in which the SDK never started a model turn (handled input or slash
 * command) completes as handled, independent of any older assistant.
 */
export function runOutcome(commandId: string, facts: RunFacts, modelStarted: boolean): RunOutcome {
  const last = facts.last;
  if (!modelStarted && !last) return { commandId, state: "completed", error: null, reason: "handled" };
  if (last?.stopReason === "aborted") return { commandId, state: "cancelled", error: "Ответ остановлен.", reason: "aborted" };
  if (last?.stopReason === "error") return { commandId, state: "failed", error: last.errorMessage || facts.retryError || "Модель завершила ответ ошибкой.", reason: "error" };
  if (last?.stopReason === "length") {
    const recovery = facts.compaction && !facts.compaction.ok && facts.compaction.error ? ` Сжатие: ${facts.compaction.error}` : "";
    return { commandId, state: "failed", error: `${OUTPUT_LIMIT_TEXT}${recovery}`, reason: "length" };
  }
  if (!last || !facts.produced) {
    const recovery = facts.compaction && !facts.compaction.ok ? ` Восстановление сжатием не удалось${facts.compaction.error ? `: ${facts.compaction.error}` : ""}.` : "";
    return { commandId, state: "failed", error: `Модель не дала ответа в этом запросе.${recovery} История сохранена; автоматического повтора не было.`, reason: "no_answer" };
  }
  if (last.stopReason === "toolUse")
    return { commandId, state: "failed", error: "Ход завершился на вызове инструментов без итогового ответа (выполнение остановлено политикой инструментов). Повтора не было.", reason: "terminated" };
  return { commandId, state: "completed", error: null, reason: "answered" };
}

export class SessionWorker {
  status: SessionStatusDTO = { type: "idle" };
  lastActivity = Date.now();
  readonly diagnostics: UiDiagnostics = { unsupported: new Set() };
  extensionErrors: Array<{ path: string; error: string }> = [];
  /** Facts of the prompt run in flight (null between runs). */
  private runFacts: RunFacts | null = null;
  private run: Promise<void> | null = null;
  private activeCommand: string | null = null;
  /** The exact run Enki itself ended (explicit Stop, Hub lease loss, or an
   * intentional close), with the truthful reason; cleared when that run settles. */
  private stopRequested: { command: string; cause: "stop" | "close"; text: string | null } | null = null;
  /** Reason of the latest abort, bound to the epoch it invalidated (preparation fences). */
  private abortNote: { epoch: number; text: string } | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private unsubscribe: (() => void) | undefined;
  private operationEpoch = 0;
  private preparing = false;
  private surface: SessionUi | undefined;
  private commands: SdkCommandActions | undefined;
  private sdkStarted = false;
  private settled: (() => void) | undefined;
  private transcriptFailure: { command: string; error: string } | null = null;
  private readonly correlations: Array<{ command: string; text: string; entry?: string }> = [];
  private readonly steeringCommands = new Set<string>();
  private invalidating = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private initializing = true;
  private uiCommands = 0;

  private constructor(readonly id: string, readonly directory: string, private session: SdkSession, private readonly deps: WorkerDeps, private readonly runtime: SdkSessionRuntime) {}

  static async open(record: SessionRecord, deps: WorkerDeps, ready?: (worker: SessionWorker) => void): Promise<SessionWorker> {
    const sessionDir = deps.sessionDir(record.directory, record.id);
    // Settle tool calls a previous runtime left without a result before the SDK
    // loads the transcript, so the agent state sees every call paired.
    recoverInterruptedTools(record, sessionDir, deps);
    const model = record.model ? findModel(deps.modelRuntime, record.model.providerID, record.model.modelID) : undefined;
    const opened = await openAgentSession({
      cwd: record.directory,
      agentDir: deps.agentDir,
      sessionDir,
      ...(record.sessionFile && fs.existsSync(record.sessionFile) ? { sessionFile: record.sessionFile } : { newSessionId: record.id }),
      modelRuntime: deps.modelRuntime,
      settings: deps.settings(),
      resources: await deps.resources(record),
      ...(model ? { model } : {}),
      ...(record.model?.variant && isThinkingLevel(record.model.variant) ? { thinking: record.model.variant } : {}),
    });
    const worker = new SessionWorker(record.id, record.directory, opened.session, deps, opened.runtime);
    try {
      worker.extensionErrors = opened.extensionErrors;
      worker.commands = worker.commandActions();
      opened.runtime.setBeforeSessionInvalidate(() => {
        worker.invalidating = true;
        worker.unsubscribe?.(); worker.unsubscribe = undefined;
        worker.surface?.dispose(); worker.surface = undefined;
      });
      opened.runtime.setRebindSession(async session => {
        worker.session = session;
        await worker.bind(deps.catalog.get(record.id) ?? record);
        worker.invalidating = false;
      });
      await worker.bind(record, ready);
      worker.initializing = false;
      for (const error of opened.extensionErrors)
        deps.journal.append(record.directory, record.id, { type: "extension.error", properties: { sessionID: record.id, path: error.path, event: "load", error: error.error.slice(0, 500) } });
      if (opened.modelFallback)
        deps.journal.append(record.directory, record.id, { type: "extension.notify", properties: { sessionID: record.id, level: "warning", message: opened.modelFallback } });
      return worker;
    } catch (error) {
      await worker.close("quit").catch(() => undefined);
      throw error;
    }
  }

  private async createSurface(record: SessionRecord): Promise<SessionUi> {
    if (!this.commands) throw new Error("Команды UI ещё не привязаны.");
    const surface = await SessionUi.create(record, this.deps.agentDir, this.deps.ui, this.deps.journal,
      this.commands, () => {
        const model = this.session.model;
        if (!model) throw new Error("Сначала выберите модель для отправки из редактора.");
        return { providerID: model.provider, modelID: model.id, variant: this.session.thinkingLevel };
      }, () => this.deps.modelRuntime.getProviders().length, this.session.resourceLoader.getThemes().themes);
    if (this.closed) { surface.dispose(); throw new Error("Worker закрыт во время подключения интерфейса."); }
    return surface;
  }
  private async bind(record: SessionRecord, ready?: (worker: SessionWorker) => void): Promise<void> {
    this.assertOpen();
    this.surface = await this.createSurface(record);
    this.attach();
    ready?.(this);
    const file = this.session.sessionFile;
    const model = this.session.model;
    this.deps.catalog.update(this.id, { ...(file ? { sessionFile: file } : {}),
      ...(model ? { model: { providerID: model.provider, modelID: model.id, variant: this.session.thinkingLevel } } : {}), touch: false });
    const onError = (path: string, event: string, error: string) => this.deps.journal.append(this.directory, this.id,
      { type: "extension.error", properties: { sessionID: this.id, path, event, error: error.slice(0, 500) } });
    const lifecycle = { abortHandler: () => this.abort(), shutdownHandler: () => { void this.close("quit"); },
      onError: (error: { extensionPath: string; event: string; error: string }) => { onError(error.extensionPath, error.event, error.error); } };
    await bindSessionUi(this.session, createUiBridge({ sessionID: this.id, directory: this.directory }, this.deps.interactions,
      this.deps.journal, this.diagnostics, () => {
        if (!this.surface) throw new Error("Интерфейс worker закрыт."); return this.surface;
      }, lifecycle), onError,
      { commandContextActions: this.commands!, abortHandler: lifecycle.abortHandler, shutdownHandler: lifecycle.shutdownHandler });
    this.assertOpen(); this.refreshTranscript();
  }
  ui(): SessionUi { this.assertOpen(); if (!this.surface) throw new Error("Интерфейс сессии переподключается."); return this.surface; }
  private commandActions(): SdkCommandActions {
    const replace = async (action: () => Promise<{ cancelled: boolean }>) => {
      this.assertOpen(); this.operationEpoch++;
      this.uiCommands++;
      try {
      let result: { cancelled: boolean };
      try { result = await action(); }
      catch (error) {
        if (this.invalidating) await this.close("quit").catch(() => undefined);
        throw error;
      }
      this.assertOpen();
      this.deps.journal.append(this.directory, this.id, { type: "session.history", properties: { sessionID: this.id, reason: "replace" } });
      return result;
      } finally { this.uiCommands--; }
    };
    return {
      waitForIdle: () => this.session.waitForIdle(),
      newSession: options => replace(() => this.runtime.newSession(options)),
      fork: (entryId, options) => replace(() => this.runtime.fork(entryId, options)),
      switchSession: (file, options) => replace(() => this.runtime.switchSession(
        ownedSessionFile(file, this.deps.sessionDir(this.directory, this.id)), { ...options, cwdOverride: this.directory })),
      navigateTree: async (entryId, options) => {
        this.assertOpen(); this.uiCommands++;
        try { const result = await this.session.navigateTree(entryId, options);
        if (result.editorText !== undefined) this.ui().host.editor.api.setEditorText(result.editorText);
        this.refreshTranscript(); return result;
        } finally { this.uiCommands--; }
      },
      reload: async () => {
        this.assertOpen(); this.uiCommands++;
        try { await this.session.waitForIdle(); this.assertOpen();
        await this.session.reload({ beforeSessionStart: async () => {
          this.surface?.dispose(); this.surface = undefined;
          const record = this.deps.catalog.get(this.id); if (!record) throw new Error("Сессия удалена.");
          this.surface = await this.createSurface(record);
        } });
        this.assertOpen(); this.refreshTranscript();
        } finally { this.uiCommands--; }
      },
    };
  }
  private refreshTranscript(): void {
    if (!this.surface) return;
    const lines = this.tail(20).flatMap(message => message.parts.flatMap(part =>
      part.type === "text" && part.text ? [part.text] : part.type === "tool" ? [`${part.tool}: ${part.state?.status ?? "pending"}`] : []));
    this.surface?.updateTranscript(lines);
  }

  private attach(): void {
    this.unsubscribe?.();
    const session = this.session;
    const seen = new Set(session.sessionManager.getEntries().map(entry => entry.id));
    const translator = new StreamTranslator(this.id, {
      onUserEntry: (entryId, _timestamp, message) => {
        if (message.role !== "user") return;
        const text = typeof message.content === "string" ? message.content : message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
        const pending = this.correlations.find(item => !item.entry && item.text === text);
        if (pending) pending.entry = entryId;
      },
      onToolStart: (callId, tool) => this.deps.tools.started(this.id, callId, tool, this.activeCommand),
      onToolEnd: (callId, isError) => this.deps.tools.ended(this.id, callId, isError),
    });
    const publish = (out: Parameters<EventJournal["append"]>[2], transient = false) => {
      if (out.type === "session.status") this.status = out.properties.status as SessionStatusDTO;
      if (out.type === "session.idle") this.status = { type: "idle" };
      this.deps.journal.append(this.directory, this.id, out, transient);
    };
    const reconcile = () => {
      if (this.closed || this.session !== session) return;
      let changed = false;
      for (const entry of session.sessionManager.getEntries()) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id); changed = true;
        for (const out of translator.appended(entry)) publish(out);
      }
      if (!changed) return;
      const file = session.sessionFile;
      // Re-reading the whole persisted transcript only confirms command
      // correlations; with none waiting for a durable id there is nothing to do.
      if (file && this.correlations.some(item => item.entry) && fs.existsSync(file)) {
        // Force the SDK's already-written bytes before committing their identity
        // to the FULL-synchronous command ledger; never write a parallel JSONL.
        syncOwnedFile(file);
        const ids = new Set(openSessionReader(file, this.deps.sessionDir(this.directory, this.id)).all().map(entry => entry.id));
        for (let index = this.correlations.length - 1; index >= 0; index--) {
          const pending = this.correlations[index];
          if (pending.entry && ids.has(pending.entry)) { this.deps.ledger.recordEntry(pending.command, pending.entry); this.correlations.splice(index, 1); }
        }
      }
      this.refreshTranscript();
    };
    const transcriptError = (error: unknown, command: string | null) => {
      // A late microtask must not poison a later command on the same session.
      if (command !== this.activeCommand || this.closed) return;
      const message = `Не удалось подтвердить сохранение истории: ${error instanceof Error ? error.message : String(error)}`;
      if (command && !this.transcriptFailure) this.transcriptFailure = { command, error: message };
      publish({ type: "session.error", properties: { sessionID: this.id, error: { name: "TranscriptSyncError", message } } });
    };
    this.unsubscribe = session.subscribe(event => {
      this.lastActivity = Date.now();
      if (this.runFacts) observeRun(this.runFacts, event);
      if (event.type === "agent_start") { this.sdkStarted = true; this.surface?.setRunning(true); }
      if (event.type === "agent_settled") {
        try { reconcile(); }
        catch (error) { transcriptError(error, this.activeCommand); }
        finally {
          try { this.surface?.setRunning(false); }
          finally { this.settled?.(); }
        }
      }
      for (const out of translator.translate(event)) {
        const transient = out.type === "message.part.delta" || out.type === "session.sdk_queue"
          || (out.type === "message.part.updated" && (out.properties.part as { type?: string; state?: { status?: string } } | undefined)?.type === "reasoning")
          || event.type === "tool_execution_update";
        publish(out, transient);
      }
      if (event.type === "entry_appended") seen.add(event.entry.id);
      if (event.type === "message_end" || event.type === "entry_appended" || event.type === "compaction_end") {
        // SDK persists message_end after listeners return. The microtask observes
        // the real appended entries, rather than pretending the SDK emitted them.
        const command = this.activeCommand;
        queueMicrotask(() => {
          try { reconcile(); }
          catch (error) { transcriptError(error, command); }
        });
      }
    });
  }

  busy(): boolean {
    return this.initializing || this.preparing || this.uiCommands > 0 || this.run !== null || this.session.isStreaming || this.session.isCompacting;
  }
  isClosed(): boolean { return this.closed; }
  uiActivity(): number { return this.surface?.activity() ?? 0; }

  idle(): boolean {
    return !this.busy() && this.uiActivity() === 0 && !this.deps.interactions.hasPending(this.id);
  }

  streaming(): boolean {
    return this.session.isStreaming;
  }

  /** A dispatched SDK turn is in progress (from dispatch until it settles);
   * preparation, model transition and idle waits are not a running turn. */
  turnRunning(): boolean {
    return this.run !== null;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => undefined).then(work);
    this.chain = next;
    return next;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Сессия закрывается; команда не выполнена.");
  }

  /** Apply the command's exact model and effort before the SDK sees the prompt. */
  private async select(model: ModelRef, epoch = this.operationEpoch): Promise<void> {
    const current = this.session.model;
    if (current?.provider !== model.providerID || current?.id !== model.modelID) {
      const target = findModel(this.deps.modelRuntime, model.providerID, model.modelID);
      if (!target) throw new Error(`Модель ${model.providerID}/${model.modelID} не найдена в каталоге Pi.`);
      await this.session.setModel(target);
      // SDK applies the model before awaiting model_select handlers. Stop may
      // fence the prompt in that await; still project the model actually set.
      const actual = this.session.model;
      if (!this.closed && actual) this.deps.catalog.update(this.id, { model: { providerID: actual.provider, modelID: actual.id, variant: this.session.thinkingLevel }, touch: false });
    }
    this.assertOpen();
    if (epoch !== this.operationEpoch) throw new Error("Подготовка отменена; запрос не отправлен.");
    if (model.variant && isThinkingLevel(model.variant) && this.session.thinkingLevel !== model.variant)
      this.session.setThinkingLevel(model.variant);
    this.deps.catalog.update(this.id, { model, touch: false });
  }

  /**
   * Start a turn. Resolves when the SDK accepted (or refused) the prompt in
   * preflight; the turn itself continues asynchronously.
   */
  startPrompt(command: PromptCommand, readiness?: ModelReadiness): Promise<CommandReceipt> {
    return this.serial(async () => {
      this.assertOpen();
      if (this.busy()) return this.deps.ledger.update(command.id, "rejected", { error: "Агент уже выполняет задачу. Поставьте запрос в очередь." })!;
      let input: PromptInput;
      const epoch = this.operationEpoch;
      this.preparing = true;
      try {
        input = promptInput(command.payload.parts);
        // Manual, queued and scheduled prompts share this one transition: a
        // smaller target is reached only after the SOURCE model summarized.
        await this.prepareModel(command.payload.model, { epoch, input, readiness, operation: command.id });
        this.assertOpen();
        if (epoch !== this.operationEpoch) return this.deps.ledger.update(command.id, "cancelled", { error: "Подготовка отменена. Запрос не отправлен." })!;
      } catch (error) {
        return this.deps.ledger.update(command.id, epoch === this.operationEpoch ? "rejected" : "cancelled", { error: error instanceof Error ? error.message : String(error) })!;
      } finally { this.preparing = false; }
      // From here a crash means the outcome is uncertain: recorded before the SDK call.
      this.deps.ledger.update(command.id, "dispatching");
      this.activeCommand = command.id;
      this.stopRequested = null;
      this.transcriptFailure = null;
      this.correlations.push({ command: command.id, text: input.text });
      this.sdkStarted = false;
      this.runFacts = { produced: false, compaction: null, retryError: null };
      const settled = new Promise<void>(resolve => { this.settled = resolve; });
      const run = { preflight: null as boolean | null, failure: null as string | null };
      let resolveAccepted!: (ok: boolean) => void;
      const accepted = new Promise<boolean>((resolve) => { resolveAccepted = resolve; });
      // The SDK reports acceptance before prompt() resolves. A provider that
      // starts streaming without the callback is still running: never report it
      // as refused, so a stall here is treated as accepted, not as "not sent".
      const timer = setTimeout(() => { run.preflight ??= true; resolveAccepted(true); }, PREFLIGHT_MS);
      this.run = (async () => {
        try {
          await this.session.prompt(input.text, {
            ...(input.images.length ? { images: input.images } : {}),
            source: "rpc",
            preflightResult: (ok) => { run.preflight ??= ok; resolveAccepted(ok); },
          });
        } catch (error) {
          run.failure = error instanceof Error ? error.message : String(error);
          resolveAccepted(run.preflight === true);
        }
        if (this.sdkStarted) await settled;
        resolveAccepted(run.preflight === true);
      })().finally(() => {
        clearTimeout(timer);
        this.finishRun(command.id, run.preflight === true, run.failure);
      });
      const ok = await accepted;
      if (ok) {
        this.deps.catalog.touch(this.id);
        this.deps.ledger.update(command.id, "running");
      } else await this.run.catch(() => undefined);
      return this.deps.ledger.get(command.id)!;
    });
  }

  private finishRun(commandId: string, accepted: boolean, failure: string | null): void {
    // The SDK may have answered while its persisted identity could not be
    // confirmed. Settle and release the turn, but never call it completed or
    // replay it. Steering without a confirmed entry retains its uncertain state.
    if (this.transcriptFailure?.command === commandId) failure ??= this.transcriptFailure.error;
    this.transcriptFailure = null;
    this.run = null;
    this.settled = undefined;
    this.activeCommand = null;
    const facts = this.runFacts ?? { produced: false, compaction: null, retryError: null };
    this.runFacts = null;
    // THIS run's own last assistant (never an older command's; see RunFacts).
    const assistant = facts.last;
    // An explicit Stop of THIS run (its exact command id) is a cancellation even
    // when the SDK closes the turn with stopReason "error"/an abort exception
    // (e.g. Stop while a question or tool waits). The marker never outlives the
    // run, so a retry or the next turn keeps its genuine failures.
    const stop = this.stopRequested?.command === commandId ? this.stopRequested : null;
    this.stopRequested = null;
    // An intentional close detaches the event subscription first, so the facts
    // end at the close: a provider error/length stop seen BEFORE it is genuine
    // and keeps its failure; anything else (e.g. the stale toolUse of a tool
    // still running) was ended by Enki itself, not by the model or tool policy.
    const genuine = stop?.cause === "close" && (assistant?.stopReason === "error" || assistant?.stopReason === "length");
    const outcome: RunOutcome = !accepted
      ? { commandId, state: "failed", error: failure ?? "Pi отклонил запрос до выполнения.", reason: "refused" }
      : genuine ? runOutcome(commandId, facts, this.sdkStarted)
      : stop && (failure || !assistant || assistant.stopReason !== "stop")
        ? { commandId, state: "cancelled", error: stop.text ?? (stop.cause === "close" ? CLOSED_RUN_TEXT : "Ответ остановлен."), reason: "stopped" }
      : failure ? { commandId, state: "failed", error: failure, reason: "error" }
      : runOutcome(commandId, facts, this.sdkStarted);
    // Refused in preflight = provably not executed; anything after acceptance keeps its real outcome.
    this.deps.ledger.update(commandId, accepted ? outcome.state : "rejected", { error: outcome.error });
    // Durable per-run outcome for automation/diagnostics (delivery ≠ success).
    if (accepted && !this.closed) this.deps.journal.append(this.directory, this.id, { type: "session.outcome", properties: {
      sessionID: this.id, commandID: commandId, state: outcome.state, reason: outcome.reason ?? null, error: outcome.error,
      ...(assistant?.stopReason ? { finish: assistant.stopReason } : {}) } });
    for (const id of this.steeringCommands) {
      const receipt = this.deps.ledger.get(id);
      if (receipt?.state !== "running" && receipt?.state !== "dispatching") continue;
      this.deps.ledger.update(id, receipt.entryId ? outcome.state : "uncertain", {
        error: receipt.entryId ? outcome.error : "Не удалось сопоставить уточнение с сохранённой историей. Повторной отправки не было.",
      });
    }
    this.steeringCommands.clear();
    for (let index = this.correlations.length - 1; index >= 0; index--) {
      if (this.correlations[index].command === commandId || this.deps.ledger.get(this.correlations[index].command)?.state !== "running") this.correlations.splice(index, 1);
    }
    this.status = { type: "idle" };
    this.surface?.setRunning(false);
    this.deps.catalog.touch(this.id);
    this.deps.onSettled(this.id, outcome);
  }

  /** Correction for a running turn, delivered at the next model/tool boundary. */
  steer(command: PromptCommand): Promise<CommandReceipt> {
    return this.serial(async () => {
      this.assertOpen();
      if (!this.session.isStreaming) return this.deps.ledger.update(command.id, "rejected", { error: "Агент уже завершил работу; отправьте обычный запрос." })!;
      let input: PromptInput;
      try { input = promptInput(command.payload.parts); }
      catch (error) { return this.deps.ledger.update(command.id, "rejected", { error: error instanceof Error ? error.message : String(error) })!; }
      this.deps.ledger.update(command.id, "dispatching");
      try {
        const text = steeringText(this.id, input.text);
        this.correlations.push({ command: command.id, text });
        await this.session.steer(text, input.images.length ? input.images : undefined);
        this.steeringCommands.add(command.id);
      } catch (error) {
        return this.deps.ledger.update(command.id, "rejected", { error: error instanceof Error ? error.message : String(error) })!;
      }
      // The steering message becomes a durable user entry when delivered; the
      // translator then records its entry id on this receipt.
      return this.deps.ledger.update(command.id, "running")!;
    });
  }

  /** Stop: undelivered corrections are handed back, pending approvals denied.
   * `reason` (e.g. a lost Hub reservation) becomes the truthful receipt text. */
  async abort(reason?: string): Promise<void> {
    this.operationEpoch++;
    this.abortNote = reason ? { epoch: this.operationEpoch, text: reason } : null;
    // Bound to the exact active run; a settled turn or a later retry is unaffected.
    if (this.activeCommand) this.stopRequested = { command: this.activeCommand, cause: "stop", text: reason ?? null };
    // A source summary or manual compaction is paid inference too: cancel it
    // (the SDK's separate abortCompaction) before waiting for the agent.
    if (this.session.isCompacting) this.session.abortCompaction();
    const cleared = this.session.clearQueue();
    const texts = [...cleared.steering, ...cleared.followUp].filter((t) => typeof t === "string" && t.trim());
    if (texts.length) this.deps.onUndelivered(this.id, this.directory, texts);
    this.deps.interactions.cancelSession(this.id);
    for (const receipt of this.deps.ledger.open(this.id))
      if (!receipt.entryId && receipt.kind === "steer") {
        this.deps.ledger.update(receipt.id, "cancelled", { error: "Уточнение не доставлено: задача остановлена." });
        this.steeringCommands.delete(receipt.id);
      }
    await this.session.abort();
    if (this.session.isCompacting) this.session.abortCompaction();
  }

  compact(customInstructions?: string): Promise<{ tokensBefore: number; tokensAfter: number | null; summary: string }> {
    return this.serial(async () => {
      this.assertOpen();
      if (this.busy()) throw new Error("Сначала остановите ответ перед сжатием контекста.");
      const result = await this.session.compact(customInstructions);
      return { tokensBefore: result.tokensBefore, tokensAfter: result.estimatedTokensAfter ?? null, summary: result.summary };
    });
  }

  /**
   * Enki's own branch copy (edit/handoff) is still an SDK fork for this
   * session's extensions: they receive `session_before_fork` and any of them
   * may cancel it before anything is written.
   */
  allowsFork(entryId: string, position: "before" | "at"): Promise<boolean> {
    return this.serial(async () => {
      this.assertOpen();
      if (this.busy()) throw new Error("Сначала остановите ответ.");
      const result = await this.session.extensionRunner.emit({ type: "session_before_fork", entryId, position });
      this.assertOpen();
      return result?.cancel !== true;
    });
  }

  /** The model the SDK actually uses now (manual compaction runs on it). */
  currentModel(): ModelRef | null {
    const model = this.session.model;
    return model ? { providerID: model.provider, modelID: model.id } : null;
  }

  /** Explicit model choice: same fit-before-switch transition as a prompt, without a turn. */
  setModel(model: ModelRef, readiness?: ModelReadiness, operation: string | null = null): Promise<TransitionResult> {
    return this.serial(async () => {
      this.assertOpen();
      if (this.busy()) throw new Error("Нельзя менять модель во время работы. Сначала остановите ответ.");
      const epoch = this.operationEpoch; this.preparing = true;
      try { return await this.prepareModel(model, { epoch, readiness, operation }); } finally { this.preparing = false; }
    });
  }

  /**
   * Explicit transfer to another model with an optional caller budget, which
   * can only LOWER the target's own limit. Same path as prompts and setModel.
   */
  transition(target: ModelRef, budget?: number, readiness?: ModelReadiness, operation: string | null = null): Promise<TransitionResult> {
    return this.serial(async () => {
      this.assertOpen();
      if (this.busy()) throw new Error("Дождитесь завершения текущей работы перед переносом контекста в меньшую модель.");
      const epoch = this.operationEpoch; this.preparing = true;
      try { return await this.prepareModel(target, { epoch, budget, readiness, operation }); } finally { this.preparing = false; }
    });
  }

  private contextEstimate(compacted: boolean): SessionContextEstimate {
    try { return estimateSessionContext(this.session); }
    catch (error) {
      throw new ContextTransitionError("estimate_unavailable", `${error instanceof Error ? error.message : String(error)} История сохранена, модель не переключена.`, ["retry", "new_session_handoff"], compacted);
    }
  }

  private transitionProgress(operation: string | null, phase: ContextTransitionPhase, source: ModelRef | null, target: ModelRef,
    extra: Record<string, unknown>, turnFollows: boolean): void {
    if (this.closed) return;
    this.deps.journal.append(this.directory, this.id, { type: "session.context_transition",
      properties: { sessionID: this.id, operation, phase, source, target: { providerID: target.providerID, modelID: target.modelID }, ...extra } });
    const message = PHASE_TEXT[phase];
    if (message) {
      this.status = { type: "waiting", message };
      this.deps.journal.append(this.directory, this.id, { type: "session.status", properties: { sessionID: this.id, status: this.status } });
    } else if (phase !== "ready" || !turnFollows) {
      this.status = { type: "idle" };
      this.deps.journal.append(this.directory, this.id, { type: "session.idle", properties: { sessionID: this.id } });
    }
  }

  /**
   * The ONE model-transition authority (prompt, queue, timer, model.set,
   * model.transition). Public SDK order: when the current context plus the
   * pending prompt does not fit the target, the CURRENT SDK model summarizes
   * via session.compact() while still selected; only a verified, bounded
   * result lets session.setModel() switch residency. Unknown usage is never
   * "fits": the next request is estimated from SDK messages/system/tools.
   * Every await is fenced by the operation epoch (Stop/close); nothing is
   * replayed and the original transcript is never truncated or deleted.
   */
  private async prepareModel(target: ModelRef, options: { epoch: number; budget?: number; input?: PromptInput; readiness?: ModelReadiness; operation: string | null }): Promise<TransitionResult> {
    const { epoch, readiness, operation } = options;
    const result: TransitionResult = { compacted: false, tokensBefore: null, tokensAfter: null, limit: null };
    const fenced = () => {
      this.assertOpen();
      if (epoch === this.operationEpoch) return;
      const note = this.abortNote?.epoch === this.operationEpoch ? `${this.abortNote.text} ` : "";
      throw new ContextTransitionError("cancelled", `${note}Подготовка отменена; модель не переключена, запрос не отправлен.`, [], result.compacted);
    };
    const original = { providerID: target.providerID, modelID: target.modelID };
    let targetModel = findModel(this.deps.modelRuntime, target.providerID, target.modelID);
    if (!targetModel && readiness?.resolve) {
      let canonical: ModelRef;
      try { canonical = await readiness.resolve(target, candidate => !!findModel(this.deps.modelRuntime, candidate.providerID, candidate.modelID)); }
      catch (error) {
        fenced();
        throw new ContextTransitionError("model_not_found", `Модель ${target.providerID}/${target.modelID} недоступна. ${error instanceof Error ? error.message : String(error)}`, ["retry", "larger_model"]);
      }
      fenced();
      target = { providerID: canonical.providerID, modelID: canonical.modelID, ...(target.variant !== undefined ? { variant: target.variant } : {}) };
      targetModel = findModel(this.deps.modelRuntime, target.providerID, target.modelID);
    }
    if (!targetModel) throw new ContextTransitionError("model_not_found", `Модель ${target.providerID}/${target.modelID} не найдена в каталоге Pi.`);
    if ((original.providerID !== target.providerID || original.modelID !== target.modelID) && target.variant
      && (!isThinkingLevel(target.variant) || (target.variant !== "off" && !targetModel.reasoning)))
      throw new ContextTransitionError("variant_unavailable", `Режим «${target.variant}» недоступен для эквивалентной модели ${target.providerID}/${target.modelID}. Выберите поддерживаемый режим; запрос не отправлен.`);
    const source = this.session.model;
    const sourceRef = source ? { providerID: source.provider, modelID: source.id } : null;
    const switching = !source || source.provider !== target.providerID || source.id !== target.modelID;
    const turnFollows = options.input !== undefined;
    // A same-model prompt is fitted too, and becomes a visible transition only
    // when it cannot be sent as is (compaction or an actionable refusal).
    let visible = switching;
    const progress = (phase: ContextTransitionPhase, extra: Record<string, unknown> = {}) => {
      if (visible) this.transitionProgress(operation, phase, sourceRef, target, extra, turnFollows);
    };
    try {
      // EVERY prompt is fitted (also on an unchanged model with SDK
      // auto-compaction disabled); a pure model switch is fitted as before.
      if (switching || turnFollows) await this.fitTarget(target, targetModel, source, sourceRef, options, result, progress, fenced, () => { visible = true; });
      progress("target_model");
      await readiness?.target?.(target); fenced();
      await this.select(target, epoch);
      if (original.providerID !== target.providerID || original.modelID !== target.modelID) {
        this.deps.journal.append(this.directory, this.id, { type: "session.model_migrated", properties: {
          sessionID: this.id, from: original, to: { providerID: target.providerID, modelID: target.modelID },
        } });
      }
      progress("ready", { compacted: result.compacted, tokensAfter: result.tokensAfter, limit: result.limit });
      return result;
    } catch (error) {
      const cancelled = this.closed || epoch !== this.operationEpoch;
      const typed = error instanceof ContextTransitionError ? error : null;
      progress(cancelled ? "cancelled" : "failed", { compacted: result.compacted, code: cancelled ? "cancelled" : typed?.code ?? "error",
        recovery: typed?.recovery ?? [], error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
      throw error;
    }
  }

  /** Verify (and if needed, make) the context fit the target BEFORE any switch. */
  private async fitTarget(target: ModelRef, targetModel: SdkModel, source: SdkModel | undefined, sourceRef: ModelRef | null,
    options: { budget?: number; input?: PromptInput; readiness?: ModelReadiness }, result: TransitionResult,
    progress: (phase: ContextTransitionPhase, extra?: Record<string, unknown>) => void, fenced: () => void,
    reveal: () => void = () => {}): Promise<void> {
    const budget = targetBudget(targetModel, options.budget);
    const incoming = promptTokens(options.input);
    result.limit = budget.limit;
    const before = this.contextEstimate(false);
    result.tokensBefore = before.tokens; result.tokensAfter = before.tokens;
    const fits = before.tokens + incoming <= budget.limit;
    if (!fits) reveal();
    progress("planning", { tokens: before.tokens, incoming, limit: budget.limit, window: budget.window, outputReserve: budget.outputReserve, usageKnown: before.usage !== null,
      system: before.system, tools: before.tools });
    if (fits) return;
    const name = `${target.providerID}/${target.modelID}`;
    // System prompt + active tool schemas + the NEW prompt can never shrink by
    // compacting old history: refuse before any source or target inference.
    // The prompt is not sent and not consumed; nothing is compacted or switched.
    const irreducible = before.system + before.tools + incoming;
    if (irreducible > budget.limit)
      throw new ContextTransitionError("prompt_too_large", `Новый запрос вместе с системными инструкциями и инструментами (≈${irreducible} токенов) не помещается в модель ${name} (${budget.limit} токенов). Сжатие истории этого не исправит: сократите запрос или вложения либо выберите модель с большим контекстом. Запрос не отправлен, история сохранена.`, ["shorten_prompt", "larger_model"]);
    if (!source || !sourceRef)
      throw new ContextTransitionError("source_model_missing", `История не помещается в ${name}, а текущая модель для сжатия не определена. История сохранена, модель не переключена.`, ["larger_model", "new_session_handoff"]);
    // The summary request itself must fit the SOURCE window; never feed the
    // whole old history to a model that cannot hold it.
    if ((before.usage ?? before.estimate) > source.contextWindow)
      throw new ContextTransitionError("handoff_required", `История превышает контекст и текущей модели ${sourceRef.providerID}/${sourceRef.modelID}, поэтому её нельзя сжать перед переходом в ${name}. История сохранена; выберите модель с большим контекстом или начните новый чат с ограниченной передачей.`, ["larger_model", "new_session_handoff"]);
    progress("summary_model", { model: sourceRef });
    await options.readiness?.summary?.(sourceRef); fenced();
    // The lease above names the source; the SDK must still be on that exact model.
    if (this.session.model?.provider !== sourceRef.providerID || this.session.model?.id !== sourceRef.modelID)
      throw new ContextTransitionError("cancelled", "Модель изменилась во время подготовки; переключение не выполнено.");
    progress("summarizing", { model: sourceRef, tokens: before.tokens });
    let compaction: Awaited<ReturnType<SdkSession["compact"]>>;
    try { compaction = await this.session.compact(); }
    catch (error) {
      fenced();
      throw new ContextTransitionError("compaction_failed", `Текущая модель ${sourceRef.providerID}/${sourceRef.modelID} не смогла сжать историю: ${error instanceof Error ? error.message : String(error)}. История сохранена, модель не переключена; повторите или начните новый чат с ограниченной передачей.`, ["retry", "larger_model", "new_session_handoff"]);
    }
    result.compacted = true;
    fenced();
    if (!compaction.summary.trim())
      throw new ContextTransitionError("compaction_failed", "Сжатие не вернуло выжимку; модель не переключена. История сохранена.", ["retry", "new_session_handoff"], true);
    progress("verifying", { model: sourceRef });
    // SDK usage is null right after compaction; the bounded message estimate
    // (and the SDK's own estimate, whichever is larger) decides the fit.
    const after = this.contextEstimate(true);
    const reported = compaction.estimatedTokensAfter;
    const tokensAfter = Math.max(after.tokens, typeof reported === "number" && Number.isFinite(reported) ? reported : 0);
    result.tokensAfter = tokensAfter;
    if (tokensAfter + incoming > budget.limit)
      throw new ContextTransitionError("does_not_fit", `После сжатия история всё ещё не помещается в выбранную модель ${name} (≈${tokensAfter + incoming} из ${budget.limit} токенов); переключение не выполнено. История сохранена.`, ["larger_model", "new_session_handoff"], true);
  }

  history(): MessageDTO[] {
    return entriesToMessages(this.id, sessionReaderOf(this.session).branch());
  }

  /** A page of history(): only the page's live entries are cloned and converted. */
  historyPage(limit: number, before?: string): { messages: MessageDTO[]; before?: string } {
    return entriesPage(this.id, this.session.sessionManager.getBranch(), limit, before, (slice) => structuredClone(slice));
  }

  /** The last `count` messages, for the plugin UI transcript. */
  private tail(count: number): MessageDTO[] {
    return this.historyPage(count).messages;
  }

  sessionFile(): string | undefined {
    return this.session.sessionFile;
  }

  usage(): { tokens: number | null; contextWindow: number } | null {
    const usage = contextUsage(this.session);
    return usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow } : null;
  }

  rename(title: string): void {
    this.session.setSessionName(title);
  }

  /** Close for eviction or shutdown; extensions receive session_shutdown first. */
  close(_reason: "quit" | "reload"): Promise<void> {
    if (this.closePromise) return this.closePromise;
    // Bind the intentional close to the exact active run BEFORE events are
    // detached; an earlier explicit Stop of that run keeps its own reason.
    if (this.activeCommand && this.stopRequested?.command !== this.activeCommand)
      this.stopRequested = { command: this.activeCommand, cause: "close", text: null };
    this.closed = true; this.operationEpoch++;
    this.deps.interactions.cancelSession(this.id);
    this.surface?.beginShutdown();
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.closePromise = (async () => {
      let failure: unknown;
      try {
        // AgentSessionRuntime.dispose() emits shutdown/disposes listeners, but
        // does not abort an active agent. Settle it first while SDK persistence
        // listeners are still alive, then emit the one shutdown event.
        this.session.abortCompaction();
        await this.session.abort();
        await this.runtime.dispose();
      }
      catch (error) { failure = error; }
      finally { this.settled?.(); this.surface?.dispose(); this.surface = undefined; }
      await this.run;
      if (failure !== undefined) throw failure;
    })();
    return this.closePromise;
  }
}
