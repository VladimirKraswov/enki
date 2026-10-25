// Agent contract used by the application state machine.
//
// The store (src/state/store.ts) talks to this interface, never to a concrete
// transport. Exactly one implementation exists: the Enki Runtime client
// (src/agent/runtime/backend.ts), which drives the bundled Pi SDK runtime on
// this computer or on an SSH host.
//
// Rules:
// - The backend owns the transport. It never exposes URLs or wire formats upwards.
// - Every directory-sensitive call carries the directory it belongs to.
// - `prompt` acknowledges *acceptance* (a durable command receipt), not
//   completion. Progress arrives as events.
// - Permission and extension dialogs are surfaced, never auto-answered.

import type {
  AgentInfo,
  HealthInfo,
  MessageResponse,
  PermissionRequest,
  PermissionRule,
  PromptRequest,
  Project,
  ProviderResponse,
  QuestionRequest,
  ServerEvent,
  Session,
  SessionStatus,
  VcsInfo,
} from "../api/types";
import type { CompactionConfig } from "../state/context";

/** Optional surfaces. The UI must degrade per-capability, never by version gate. */
export interface AgentCapabilities {
  /** Interactive shell sessions owned by the runtime. */
  pty: boolean;
  /** Tool-call approval prompts the user answers. */
  permissions: boolean;
  /** Structured questions the agent asks mid-run. */
  questions: boolean;
  /** File/image parts in a prompt. */
  attachments: boolean;
  /** Branching a conversation from an earlier message. */
  fork: boolean;
  /** Runtime-side history summarization. */
  compaction: boolean;
  /** Working-tree diffs for the review panel. */
  vcsDiff: boolean;
  /** A chat that owns a managed directory instead of a user project. */
  projectlessChat: boolean;
}

export interface AgentRuntimeConfig {
  default_agent?: string;
  model?: string;
  compaction?: CompactionConfig;
}

export interface AgentPaths {
  home: string;
  directory: string;
  worktree: string;
}

export interface CreateSessionInput {
  directory: string;
  title?: string;
  permission?: PermissionRule[];
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  signal?: AbortSignal;
}

export interface SessionPatch {
  title?: string;
  permission?: PermissionRule[];
  time?: { archived?: number | null };
}

export type StreamState =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "error";

export interface EventSubscription<T> {
  signal: AbortSignal;
  onEvent: (event: T) => void;
  onState: (state: StreamState, detail?: string) => void;
  /** The stream could not replay everything since the last event: reconcile. */
  onReset?: (reason: "instance" | "expired" | "oversized") => void;
}

/** An event observed on the runtime-wide stream, tagged with its directory. */
export interface DirectoryEvent {
  directory?: string;
  payload: ServerEvent;
}

export interface AgentBackend {
  readonly id: string;
  /** Stable origin identity used for request guards and preference scoping. */
  readonly endpoint: string;
  readonly capabilities: AgentCapabilities;

  // ---- connection / runtime metadata ----
  health(signal?: AbortSignal): Promise<HealthInfo>;
  providers(
    signal: AbortSignal | undefined,
    directory: string | null,
  ): Promise<ProviderResponse>;
  agents(
    signal: AbortSignal | undefined,
    directory: string | null,
  ): Promise<AgentInfo[]>;
  config(directory: string | null): Promise<AgentRuntimeConfig>;

  // ---- workspaces ----
  projects(signal?: AbortSignal): Promise<Project[]>;
  paths(directory?: string | null): Promise<AgentPaths>;
  vcs(directory: string, signal?: AbortSignal): Promise<VcsInfo | null>;

  // ---- sessions ----
  listSessions(
    directory: string | null,
    opts?: { limit?: number; signal?: AbortSignal },
  ): Promise<Session[]>;
  recentSessions(
    archived?: boolean,
    cursor?: number,
    filter?: { search?: string; directory?: string },
  ): Promise<{ sessions: Session[]; cursor: number | null }>;
  getSession(
    sessionID: string,
    directory: string | null,
    signal?: AbortSignal,
  ): Promise<Session>;
  createSession(input: CreateSessionInput): Promise<Session>;
  updateSession(
    sessionID: string,
    patch: SessionPatch,
    directory: string | null,
  ): Promise<Session>;
  forkSession(
    sessionID: string,
    directory: string,
    messageID: string,
  ): Promise<Session>;
  deleteSession(sessionID: string, directory: string | null): Promise<void>;
  sessionStatuses(
    directory: string | null,
    signal?: AbortSignal,
  ): Promise<Record<string, SessionStatus>>;

  // ---- history / execution ----
  messages(
    sessionID: string,
    opts?: {
      directory?: string | null;
      limit?: number;
      before?: string;
      signal?: AbortSignal;
    },
  ): Promise<{ messages: MessageResponse[]; before?: string }>;
  /** Resolves when the command was durably *accepted*. Completion is observed through events. */
  prompt(
    sessionID: string,
    directory: string,
    body: PromptRequest,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Explicit correction for the next boundary of an existing run. */
  steer?(sessionID: string, directory: string, body: PromptRequest): Promise<void>;
  abort(sessionID: string, directory: string): Promise<void>;
  summarize(
    sessionID: string,
    directory: string,
    providerID: string,
    modelID: string,
  ): Promise<void>;

  // ---- interaction ----
  pendingPermissions(
    directory: string | null,
    signal?: AbortSignal,
  ): Promise<PermissionRequest[]>;
  replyPermission(
    requestID: string,
    reply: "once" | "always" | "reject",
    directory: string,
  ): Promise<void>;
  pendingQuestions(
    directory: string | null,
    signal?: AbortSignal,
  ): Promise<QuestionRequest[]>;
  replyQuestion(
    requestID: string,
    answers: string[][],
    directory: string,
  ): Promise<void>;
  rejectQuestion(requestID: string, directory: string): Promise<void>;

  // ---- events ----
  /** Incremental updates for one directory. Aborting the signal ends the subscription. */
  subscribeDirectory(
    directory: string,
    subscription: EventSubscription<ServerEvent>,
  ): void;
  /** Runtime-wide activity, used to notice work finishing outside the open chat. */
  subscribeAll(subscription: EventSubscription<DirectoryEvent>): void;
}
