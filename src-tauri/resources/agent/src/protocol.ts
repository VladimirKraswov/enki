// Enki Runtime wire contract, shared by the runtime and the WebView client.
//
// Dependency-free on purpose: the UI bundles this file at UI build time and the
// runtime bundles it at native build time. A UI hot update can therefore run
// against an older runtime; `CONTRACT_VERSION` is the explicit negotiation point
// and every additive field is optional.

/** Incompatible wire changes bump this. The client refuses a different major. */
export const CONTRACT_VERSION = 1;
/** Runtime SQLite schema; migrations are forward-only and journaled. */
export const SCHEMA_VERSION = 3;
/** The exact SDK version the adapter was written against. */
export const SDK_VERSION = "0.85.1";
export const API_PREFIX = "/v1";

// ---------------------------------------------------------------- DTOs

export interface PermissionRule {
  permission: string;
  pattern: string;
  action: "allow" | "ask" | "deny";
}

export type SessionOrigin =
  | { kind: "pi" }
  | { kind: "opencode"; archive: string; legacyId: string; sourceOrigin?: string; readOnly: true; continuedBy?: string }
  /** Writable working copy of a former Pi CLI chat; `archive` is the immutable original. */
  | { kind: "pi-cli"; source: string; sourceOrigin: string; legacyId: string; archive: string; runtimeId: string }
  | { kind: "continuation"; from: string; archive: string }
  /** Stored provenance failed validation: shown read-only, never executed or rewritten. */
  | { kind: "quarantined"; readOnly: true; reason: string };

/** Archives and unverifiable provenance never accept prompts, queue items or timers. */
export function isReadOnlyOrigin(origin: SessionOrigin | undefined): boolean {
  return origin?.kind === "opencode" || origin?.kind === "quarantined";
}

export interface SessionDTO {
  id: string;
  directory: string;
  title: string;
  projectID: string;
  parentID?: string;
  permission?: PermissionRule[];
  model?: { id: string; providerID: string; variant?: string | null };
  origin?: SessionOrigin;
  workshop?: boolean;
  time: { created: number; updated: number; archived?: number | null };
}

export type SessionStatusDTO =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt?: number; message?: string; next?: number }
  | { type: "waiting"; message?: string };

export interface ToolStateDTO {
  status: "pending" | "running" | "completed" | "error";
  input?: unknown;
  output?: string;
  title?: string;
  metadata?: unknown;
  time?: { start?: number; end?: number; output?: number };
  error?: string;
}

export interface MessagePartDTO {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  mime?: string;
  filename?: string;
  url?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: ToolStateDTO;
  synthetic?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface MessageInfoDTO {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time: { created: number; completed?: number | null };
  error?: unknown;
  providerID?: string;
  modelID?: string;
  variant?: string | null;
  cost?: number;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  finish?: string | null;
  summary?: boolean;
  parentID?: string;
  timingKey?: string;
  timingSource?: "live" | "entry";
}

export interface MessageDTO {
  info: MessageInfoDTO;
  parts: MessagePartDTO[];
}

export interface PermissionRequestDTO {
  id: string;
  sessionID: string;
  permission: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  tool?: { messageID?: string; callID?: string } | null;
}

export interface QuestionRequestDTO {
  id: string;
  sessionID: string;
  questions: Array<{
    question: string;
    header?: string;
    custom?: boolean | null;
    multiple?: boolean | null;
    options?: Array<{ label: string; description?: string }>;
  }>;
  tool?: { messageID?: string; callID?: string } | null;
}

/** Blocking extension UI request that is not a tool permission or a question. */
export interface DialogRequestDTO {
  id: string;
  sessionID: string;
  directory: string;
  method: "confirm" | "input" | "editor" | "select";
  title: string;
  message?: string;
  placeholder?: string;
  prefill?: string;
  options?: string[];
  deadline: number;
}

export interface ServerEventDTO {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
}

/**
 * Largest serialized envelope the runtime puts on the SSE wire, in UTF-8
 * bytes. The WebView decoder accepts at least this many characters per frame
 * (characters never exceed UTF-8 bytes), so every frame the runtime sends is
 * decodable. A larger event (e.g. a legal 64 MiB attachment data URL inside a
 * part) is sent as an `event.oversized` stub under the SAME seq: the cursor
 * advances and the client reconciles that state from the authoritative
 * history/snapshot routes instead of requesting an impossible frame forever.
 */
export const EVENT_WIRE_LIMIT_BYTES = 3 * 1024 * 1024;
/** Decoder headroom over EVENT_WIRE_LIMIT_BYTES for the `id:`/`data:` framing. */
export const EVENT_FRAME_CHARACTERS = EVENT_WIRE_LIMIT_BYTES + 64 * 1024;
export interface OversizedEventProperties {
  /** Original event type, e.g. "message.part.updated". */
  type: string;
  bytes: number;
  sessionID?: string;
  messageID?: string;
  partID?: string;
}

/** Every event leaves the runtime inside this envelope. `seq` is the durable cursor. */
export interface EventEnvelope {
  seq: number;
  time: number;
  /** Host-local project directory the event belongs to; null for runtime-wide events. */
  directory: string | null;
  sessionID: string | null;
  event: ServerEventDTO;
}

export interface ModelInfoDTO {
  id: string;
  providerID: string;
  name?: string;
  api?: { id?: string; url?: string };
  capabilities?: {
    reasoning?: boolean;
    toolcall?: boolean;
    attachment?: boolean;
    input?: { text?: boolean; image?: boolean };
  };
  limit?: { context?: number; output?: number };
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  variants?: Record<string, { id: string }> | null;
  thinkingLevelMap?: Record<string, string | null>;
  access?: { state: "available" | "unavailable" | "unknown"; kind?: "local" | "paid" | "free" | "subscription"; checkedAt?: number; reason?: string };
}

export interface ProviderDTO {
  id: string;
  name?: string;
  source?: "builtin" | "custom" | "extension" | "config";
  options?: { baseURL?: string };
  auth?: { configured: boolean; source?: string };
  models: Record<string, ModelInfoDTO>;
}

export interface ProvidersDTO {
  checking?: boolean;
  all: ProviderDTO[];
  connected: string[];
  default: Record<string, string> | null;
}

export interface CapabilitiesDTO {
  pty: boolean;
  permissions: boolean;
  questions: boolean;
  /** Prepared file/image parts in a question reply (absent in older runtimes). */
  questionAttachments?: boolean;
  attachments: boolean;
  fork: boolean;
  compaction: boolean;
  vcsDiff: boolean;
  projectlessChat: boolean;
  queue: boolean;
  schedules: boolean;
  legacyImport: boolean;
  /** `tui`: real SDK plugin surface over GET/POST /sessions/:id/ui* (xterm + shared draft). */
  extensionUi: { dialogs: true; notify: true; status: true; widgetsText: true; tui: boolean };
}

export interface HealthDTO {
  healthy: boolean;
  version: string;
  contract: number;
  schema: number;
  sdk: string;
  node: string;
  platform: string;
  arch: string;
  instance: string;
  startedAt: number;
  host: "local" | "remote";
  draining: boolean;
  /** Stable identity of this runtime's database (ledger authority); absent on older runtimes. */
  hostId?: string;
}

// ------------------------------------------------------------ commands

export interface PromptPartText {
  type: "text";
  text: string;
  synthetic?: boolean;
  metadata?: Record<string, unknown>;
}
export interface PromptPartFile {
  type: "file";
  mime: string;
  filename?: string;
  /** data: URL produced by the UI attachment preparation. */
  url: string;
}
export type PromptPart = PromptPartText | PromptPartFile;
/** Inline question text beyond this bound travels as a prepared text file. */
export const QUESTION_ANSWER_TEXT_LIMIT = 10_000;

export interface ModelRef {
  providerID: string;
  modelID: string;
  variant?: string | null;
}

export type CommandKind = "prompt" | "steer" | "abort" | "compact" | "model.set" | "model.transition";

export interface PromptCommandPayload {
  parts: PromptPart[];
  model: ModelRef;
  /** Provenance for receipts and reconciliation only. */
  source?: "manual" | "queue" | "schedule";
  sourceId?: string | null;
  /** The client knows this model is Hub-managed: refuse to run it without a lease. */
  hubRoute?: boolean;
}
export interface CompactCommandPayload {
  model?: ModelRef;
  customInstructions?: string;
}
export interface ModelSetPayload {
  model: ModelRef;
}
export interface ModelTransitionPayload {
  model: ModelRef;
  /** Input-token budget of the target; 0 lets the runtime derive it from the catalog. */
  budget?: number;
}

interface CommandBase {
  /** Client-generated, globally unique, reused verbatim on retry after a lost ACK. */
  id: string;
  sessionID: string;
  directory: string;
}
export type PromptCommand = CommandBase & { kind: "prompt" | "steer"; payload: PromptCommandPayload };
export type CompactCommand = CommandBase & { kind: "compact"; payload: CompactCommandPayload };
export type ModelSetCommand = CommandBase & { kind: "model.set"; payload: ModelSetPayload };
export type ModelTransitionCommand = CommandBase & { kind: "model.transition"; payload: ModelTransitionPayload };
export type AbortCommand = CommandBase & { kind: "abort"; payload: Record<string, never> };
export type CommandRequest = PromptCommand | CompactCommand | ModelSetCommand | ModelTransitionCommand | AbortCommand;

export type CommandState =
  /** Durably recorded; waiting for the session worker, model readiness or a lease. */
  | "accepted"
  /** Recorded immediately before the SDK call; from here a crash means "uncertain". */
  | "dispatching"
  | "running"
  | "completed"
  | "failed"
  | "rejected"
  | "cancelled"
  /** Runtime stopped after side effects may have happened. Never replayed. */
  | "uncertain";

export interface CommandReceipt {
  id: string;
  kind: CommandKind;
  sessionID: string;
  state: CommandState;
  /** Durable SDK entry id of the user message created by a prompt/steer. */
  entryId?: string | null;
  error?: string | null;
  createdAt: number;
  updatedAt: number;
  /** True when this response was served from the ledger (duplicate request). */
  duplicate?: boolean;
}

// --------------------------------------------------------------- queue

export interface QueueAttachmentRef {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface QueueItemDTO {
  id: string;
  sessionID: string;
  directory: string;
  text: string;
  model: ModelRef;
  agent?: string;
  state: "ready" | "sending" | "uncertain";
  error?: string;
  queuedAt: number;
  attachments?: QueueAttachmentRef[];
  commandId?: string | null;
}

export interface QueueStateDTO {
  sessionID: string;
  armed: boolean;
  pausedReason: string | null;
  items: QueueItemDTO[];
  /** Saved corrections not yet present in the SDK history. These are receipts, never new queued jobs. */
  corrections?: PendingCorrectionDTO[];
}

export interface PendingCorrectionDTO {
  id: string;
  text: string;
  state: "accepted" | "dispatching" | "running" | "uncertain";
  createdAt: number;
  error?: string;
  attachments?: { name: string }[];
}

// ------------------------------------------------------------ schedules

/** Attempts of one occurrence that may be refused before the timer pauses
 * (runtime scheduler authority; clients only display it). */
export const SCHEDULE_MAX_ATTEMPTS = 4;

export interface ScheduleDTO {
  id: string;
  directory: string;
  sessionID: string;
  title: string;
  prompt: string;
  minutes: number;
  mode: "once" | "repeat";
  runAt?: number;
  requestKey?: string;
  model: ModelRef;
  enabled: boolean;
  nextAt: number;
  lastAt?: number;
  state: "ready" | "waiting" | "dispatching" | "sent" | "error";
  detail?: string;
  /** Re-attempt of the current occurrence after a provably unexecuted
   * (rejected) attempt; part of its command id. Absent for the first attempt. */
  attempt?: number;
}

// --------------------------------------------------------------- legacy

export interface LegacyArchiveDTO {
  id: string;
  kind: "opencode" | "pi-cli";
  createdAt: number;
  source: string;
  sha256: string;
  counts: Record<string, number>;
  importer: string;
  sessions: number;
}

export interface MigrationStatusDTO {
  archives: LegacyArchiveDTO[];
  journal: Array<{ id: string; kind: string; state: string; detail?: string; updatedAt: number }>;
}

// ------------------------------------------------------------- helpers

/** Bounded identifier accepted for sessions, commands, queue items and schedules. */
export const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function isModelRef(value: unknown): value is ModelRef {
  if (!value || typeof value !== "object") return false;
  const m = value as ModelRef;
  return typeof m.providerID === "string" && m.providerID.length > 0 && m.providerID.length <= 512
    && typeof m.modelID === "string" && m.modelID.length > 0 && m.modelID.length <= 512
    && (m.variant === undefined || m.variant === null || (typeof m.variant === "string" && m.variant.length <= 64));
}

export function isPromptPart(value: unknown): value is PromptPart {
  if (!value || typeof value !== "object") return false;
  const p = value as PromptPart;
  if (p.type === "text") return typeof p.text === "string" && p.text.length <= 4_000_000;
  if (p.type === "file")
    return typeof p.mime === "string" && p.mime.length <= 200 && typeof p.url === "string"
      && p.url.startsWith("data:") && p.url.length <= 48 * 1024 * 1024
      && (p.filename === undefined || (typeof p.filename === "string" && p.filename.length <= 512));
  return false;
}

/** Accepts only well-formed command requests; anything else is a 400, never a guess. */
export function validateCommand(value: unknown): CommandRequest | string {
  if (!value || typeof value !== "object") return "Ожидался объект команды.";
  const c = value as Record<string, unknown>;
  const id = c.id, sessionID = c.sessionID, directory = c.directory;
  if (!isId(id)) return "Некорректный идентификатор команды.";
  if (!isId(sessionID)) return "Некорректный идентификатор сессии.";
  if (typeof directory !== "string" || !directory || directory.length > 4096) return "Некорректный каталог.";
  const base = { id, sessionID, directory };
  const payload = (c.payload && typeof c.payload === "object" ? c.payload : {}) as Record<string, unknown>;
  switch (c.kind) {
    case "prompt":
    case "steer": {
      const parts = payload.parts;
      if (!Array.isArray(parts) || !parts.length || parts.length > 64 || !parts.every(isPromptPart)) return "Некорректные части запроса.";
      if (!isModelRef(payload.model)) return "Не указана модель.";
      const source = payload.source;
      if (source !== undefined && source !== "manual" && source !== "queue" && source !== "schedule") return "Некорректный источник.";
      if (payload.sourceId !== undefined && payload.sourceId !== null && !isId(payload.sourceId)) return "Некорректный источник.";
      return { ...base, kind: c.kind === "steer" ? "steer" : "prompt", payload: {
        parts, model: payload.model,
        ...(source ? { source } : {}),
        ...(typeof payload.sourceId === "string" ? { sourceId: payload.sourceId } : {}),
        ...(payload.hubRoute === true ? { hubRoute: true } : {}),
      } };
    }
    case "compact": {
      if (payload.model !== undefined && !isModelRef(payload.model)) return "Некорректная модель сжатия.";
      const instructions = payload.customInstructions;
      if (instructions !== undefined && (typeof instructions !== "string" || instructions.length > 20000)) return "Некорректные инструкции сжатия.";
      return { ...base, kind: "compact", payload: {
        ...(isModelRef(payload.model) ? { model: payload.model } : {}),
        ...(typeof instructions === "string" ? { customInstructions: instructions } : {}),
      } };
    }
    case "model.set":
      if (!isModelRef(payload.model)) return "Не указана модель.";
      return { ...base, kind: "model.set", payload: { model: payload.model } };
    case "model.transition": {
      if (!isModelRef(payload.model)) return "Не указана модель.";
      const budget = payload.budget;
      if (budget !== undefined && (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget < 0)) return "Некорректный бюджет контекста.";
      return { ...base, kind: "model.transition", payload: { model: payload.model, ...(typeof budget === "number" ? { budget } : {}) } };
    }
    case "abort":
      return { ...base, kind: "abort", payload: {} };
    default:
      return "Неизвестная команда.";
  }
}

/** Stable digest input for idempotency: key order and whitespace never matter. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** Queue pause classification is part of the contract so both sides agree. */
export function isQueuePausingError(error: string | null | undefined): boolean {
  return !!error && /insufficient.?balance|insufficient.?credits|payment required|недостаточно средств|quota exceeded|unauthorized|invalid api key|authentication failed|\baborted\b|\bstopped\b/i.test(error);
}
