// UI models for sessions, messages and parts as served by the Enki Runtime
// (wire contract: src-tauri/resources/agent/src/protocol.ts). The shapes stay
// compatible with histories imported from OpenCode, which the runtime serves
// read-only. Parsers below tolerate additive/optional fields.
import type { SessionOrigin } from "../../src-tauri/resources/agent/src/protocol";

export interface HealthInfo {
  healthy: boolean;
  version: string;
}

export interface Project {
  id: string;
  worktree: string;
  vcs?: string | null;
  sandboxes?: string[];
  time?: { created?: number; updated?: number };
}

export interface SessionModel {
  id: string;
  providerID: string;
  variant?: string | null;
}

export interface PermissionRule {
  permission: string;
  pattern: string;
  action: "allow" | "ask" | "deny";
}

export interface Session {
  permission?: PermissionRule[];
  id: string;
  slug?: string;
  projectID: string;
  directory: string;
  parentID?: string;
  title: string;
  agent?: string;
  model?: SessionModel;
  version?: string;
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number };
  summary?: { additions?: number; deletions?: number; files?: number };
  time: { created: number; updated: number; archived?: number | null };
  /** Native, imported read-only OpenCode archive, former Pi CLI chat or continuation. */
  origin?: SessionOrigin;
  workshop?: boolean;
}

/** Imported OpenCode history is shown read-only until explicitly continued. */
export function isReadOnlySession(session: Pick<Session, "origin"> | undefined | null): boolean {
  return session?.origin?.kind === "opencode";
}

export type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt?: number; message?: string; next?: number }
  | { type: "waiting"; message?: string };

export interface MessageBase {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time: { created: number; completed?: number | null };
  error?: unknown;
  /** App observation identity/provenance; never forwarded to agent APIs. */
  timingKey?: string;
  timingSource?: 'live' | 'entry';
}

export interface UserMessage extends MessageBase {
  role: "user";
  agent?: string;
  model?: { providerID?: string; modelID?: string; variant?: string | null };
}

export interface AssistantMessage extends MessageBase {
  summary?: boolean;
  role: "assistant";
  agent?: string;
  mode?: string;
  modelID?: string;
  providerID?: string;
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
  parentID?: string;
}

export type Message = UserMessage | AssistantMessage;

export interface ToolState {
  status: "pending" | "running" | "completed" | "error";
  input?: unknown;
  output?: string;
  title?: string;
  metadata?: unknown;
  time?: { start?: number; end?: number; compact?: number };
  error?: string;
}

export interface MessagePart {
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
  state?: ToolState;
  synthetic?: boolean;
  ignored?: boolean;
  metadata?: Record<string, unknown> | null;
  time?: Record<string, unknown>;
  // step-finish
  reason?: string;
  cost?: number;
  tokens?: Record<string, unknown>;
}

export interface TextPartInput {
  type: "text";
  text: string;
  synthetic?: boolean;
  metadata?: Record<string, unknown>;
}

export interface PromptPartInput {
  type: "file";
  mime: string;
  filename?: string;
  url: string;
}

export interface PromptRequest {
  /** Client-generated command id; reused verbatim on retry after a lost ACK. */
  messageID?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string | null;
  parts: Array<TextPartInput | PromptPartInput>;
  /** Provenance kept in the runtime's command receipt. */
  source?: "manual" | "queue" | "schedule";
  sourceId?: string | null;
  /** The model is Hub-managed: the runtime must hold a lease before running it. */
  hubRoute?: boolean;
}

export interface ModelVariantInfo {
  id?: string;
  [key: string]: unknown;
}

export interface ModelInfo {
  id: string;
  providerID: string;
  api?: { id?: string; url?: string; npm?: string };
  name?: string;
  capabilities?: {
    reasoning?: boolean;
    toolcall?: boolean;
    attachment?: boolean;
    input?: { text?: boolean; image?: boolean; audio?: boolean; video?: boolean; pdf?: boolean };
  };
  limit?: { context?: number; input?: number; output?: number };
  variants?: Record<string, ModelVariantInfo> | null;
  status?: string;
}

export interface ProviderInfo {
  id: string;
  name?: string;
  source?: string;
  options?: { baseURL?: string };
  models: Record<string, ModelInfo>;
}

export interface ProviderResponse {
  all: ProviderInfo[];
  default: Record<string, string> | null;
  connected: string[];
}

export interface AgentInfo {
  model?: { providerID: string; modelID: string };
  variant?: string;
  name: string;
  description?: string | null;
  mode?: string | null;
  hidden?: boolean | null;
}

export interface PermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  tool?: { messageID?: string; callID?: string } | null;
}

export interface QuestionInfo {
  question: string;
  header?: string;
  custom?: boolean | null;
  multiple?: boolean | null;
  options?: Array<{ label: string; description?: string }>;
}

export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID?: string; callID?: string } | null;
}

export interface VcsInfo {
  branch?: string | null;
  default_branch?: string | null;
  project?: string;
  [key: string]: unknown;
}

export interface VcsFileStatus {
  file: string;
  added?: number;
  removed?: number;
  status?: string;
}

export interface SessionDiffFile {
  file: string;
  before?: string;
  after?: string;
  additions?: number;
  deletions?: number;
  status?: "added" | "deleted" | "modified" | "rename" | string;
  patch?: string;
  additionsTotal?: number;
  deletionsTotal?: number;
}

export interface FileEntry {
  name: string;
  path: string;
  absolute: string;
  type: "file" | "directory";
  ignored?: boolean;
}

export interface PtyInfo {
  id: string;
  title?: string;
  args?: string[];
  cwd?: string;
  status?: "running" | "exited" | string;
}

export interface ServerEvent {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface MessageResponse {
  info: Message;
  parts: MessagePart[];
}

// ---- Normalization helpers (tolerate additive/missing fields) ----

export function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function normalizeSession(raw: Record<string, unknown>): Session {
  const time = (raw.time ?? {}) as Record<string, unknown>;
  const model = raw.model as Record<string, unknown> | undefined;
  return {
    id: asString(raw.id),
    slug: typeof raw.slug === "string" ? raw.slug : undefined,
    projectID: asString(raw.projectID),
    directory: asString(raw.directory),
    parentID: typeof raw.parentID === "string" ? raw.parentID : undefined,
    title: asString(raw.title, "Без названия"),
    agent: typeof raw.agent === "string" ? raw.agent : undefined,
    model: model
      ? {
          id: asString(model.id),
          providerID: asString(model.providerID),
          variant: typeof model.variant === "string" ? model.variant : null,
        }
      : undefined,
    version: typeof raw.version === "string" ? raw.version : undefined,
    cost: asNumber(raw.cost),
    permission: raw.permission as PermissionRule[] | undefined,
    tokens: raw.tokens as Session["tokens"],
    summary: raw.summary as Session["summary"],
    time: {
      created: asNumber(time.created) ?? 0,
      updated: asNumber(time.updated) ?? 0,
      archived: typeof time.archived === "number" ? time.archived : null,
    },
  };
}

export function normalizeMessage(raw: Record<string, unknown>): Message | null {
  const role = raw.role;
  if (role !== "user" && role !== "assistant") return null;
  const time = (raw.time ?? {}) as Record<string, unknown>;
  const base: MessageBase = {
    id: asString(raw.id),
    sessionID: asString(raw.sessionID),
    role,
    time: {
      created: asNumber(time.created) ?? 0,
      completed: typeof time.completed === "number" ? time.completed : null,
    },
    error: raw.error,
  };
  if (role === "user") {
    return {
      ...base,
      role: "user",
      agent: asString(raw.agent) || undefined,
      model: raw.model as UserMessage["model"],
    };
  }
  return {
    ...base,
    role: "assistant",
    parentID: typeof raw.parentID === "string" ? raw.parentID : undefined,
    agent: asString(raw.agent) || undefined,
    modelID: asString(raw.modelID) || undefined,
    providerID: asString(raw.providerID) || undefined,
    variant: typeof raw.variant === "string" ? raw.variant : null,
    cost: asNumber(raw.cost),
    tokens: raw.tokens as AssistantMessage["tokens"],
    summary: raw.summary === true,
    finish: typeof raw.finish === "string" ? raw.finish : null,
  };
}

export function normalizeStatusType(raw: unknown): SessionStatus {
  const t = (raw as { type?: string })?.type;
  switch (t) {
    case "busy":
      return { type: "busy" };
    case "retry":
      return {
        type: "retry",
        attempt: asNumber((raw as Record<string, unknown>).attempt),
        message:
          asString((raw as Record<string, unknown>).message) || undefined,
      };
    case "waiting":
      return { type: "waiting" };
    default:
      return { type: "idle" };
  }
}
