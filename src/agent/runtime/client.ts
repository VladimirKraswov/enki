// Typed HTTP transport for the Enki Runtime API v1 (loopback only).
//
// - The bearer token lives only in memory and only in the Authorization header;
//   it never appears in a URL, preference or log.
// - A 401 refreshes the connection once (token rotation) and retries the same
//   request; an idempotent command id makes that retry safe for commands.
// - Errors are redacted: response bodies are reduced to the runtime's message.
import type {
  CapabilitiesDTO,
  CommandReceipt,
  CommandRequest,
  DialogRequestDTO,
  HealthDTO,
  MessageDTO,
  ModelRef,
  PermissionRequestDTO,
  PermissionRule,
  PromptPart,
  ProvidersDTO,
  QueueStateDTO,
  ScheduleDTO,
  SessionDTO,
  SessionStatusDTO,
} from "../../../src-tauri/resources/agent/src/protocol";
import { API_PREFIX } from "../../../src-tauri/resources/agent/src/protocol";
import type { QuestionRequestDTO } from "../../../src-tauri/resources/agent/src/protocol";
import type { UiInput, UiResize } from "../../../src-tauri/resources/agent/src/plugin-ui/protocol";
import type { DraftResolution, DraftResult, DraftSnapshot, InputReceipt, SurfaceAttachment, UiSnapshot } from "./pluginUi/types";
import { ApiError, ConnectionError, isAllowedBaseUrl } from "../../api/http";
import type { FileEntry, Project, SessionDiffFile, VcsInfo } from "../../api/types";

export interface RuntimeConnection {
  endpoint: string;
  token: string;
  instance: string;
  version: string;
  contract: number;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  onResponse?: (response: Response) => void;
  /** Empty bodies (204 or `undefined` handlers) are expected. */
  empty?: boolean;
}

export interface ResourcePathStatusDTO { path: string; present: boolean }
/** One explicitly configured LOCAL Pi package: resource counts and the runtime's
 * diagnostics (≤20; refused patterns, escaping links, bounds, ignore files). */
export interface PackageStatusDTO extends ResourcePathStatusDTO { extensions: number; skills: number; prompts: number; themes: number; diagnostics: string[] }
export interface ResourceStatusDTO { extensions: ResourcePathStatusDTO[]; skills: ResourcePathStatusDTO[]; prompts: ResourcePathStatusDTO[];
  /** Absent on a runtime without local package support. */
  packages?: PackageStatusDTO[]; deferred: string[] }
export interface RuntimeSettingsDTO {
  defaultPolicy: "ask" | "read" | "full";
  extensionPaths: string[];
  /** Explicit skill / prompt-template paths of the runtime host (older runtimes omit them). */
  skillPaths?: string[];
  promptPaths?: string[];
  /** Absolute LOCAL Pi package folders (trusted code; never downloaded). Older runtimes omit it. */
  packagePaths?: string[];
  useUserPiResources: boolean;
  noDiscoveredExtensions: boolean;
  gitProgram: string | null;
  compaction: { enabled: boolean; reserveTokens?: number; keepRecentTokens?: number };
  browserEnabled: boolean;
  /** Absent on an older runtime (then LSP followed only its config file). */
  lspEnabled?: boolean;
}

export interface SnapshotDTO {
  seq: number;
  instance: string;
  statuses: Record<string, SessionStatusDTO>;
  permissions: PermissionRequestDTO[];
  /** Absent only on an older runtime: then no question can be pending there. */
  questions?: QuestionRequestDTO[];
  dialogs: DialogRequestDTO[];
  queues: QueueStateDTO[];
  schedules: ScheduleDTO[];
  activity: RuntimeActivityDTO;
}

/** Authoritative runtime activity (GET /runtime/idle, snapshot). */
export interface RuntimeActivityDTO {
  running: number; queued: number; pending: number; idle: boolean;
  questions?: number; terminals?: number; readyQueue?: number; sending?: number; scheduled?: number; draining?: boolean;
  /** Owned shells: running, starting, and closed-but-unconfirmed (closing + cleanup-unknown). */
  pty?: { running: number; starting: number; unconfirmed: number; closing?: number; cleanupUnknown?: number };
}

export interface MigrationsDTO {
  archives: Array<{ id: string; kind: string; createdAt: number; source: string; sha256: string; counts: Record<string, number>; importer: string; sessions: number }>;
  journal: Array<{ id: string; kind: string; state: string; detail?: string; updatedAt: number }>;
  sources: { opencode: string | null; piCli: string | null };
  /** Startup recovery failures of app-owned import/continuation journals. */
  recovery?: Array<{ kind: string; message: string }>;
  /** Chats the canonical-shard migration of the Enki store left where they are. */
  shards?: Array<{ session: string; reason: string }>;
  directoryAliases?: Record<string, string>;
  piAgent?: { available: boolean; status: ConfigStatusDTO };
}

export interface PtyDTO { id: string; title?: string; cwd?: string; status?: string; exitCode?: number; cursor?: number }
/** A shell Enki closed whose cleanup is not confirmed (it keeps blocking automatic maintenance). */
export interface PtyClosingDTO { id: string; title: string; cwd: string; state: "closing" | "cleanup-unknown"; since: number; primaryExited: boolean; exitCode?: number; detail: string }

/** Sanitized imported-config state (GET /migrations/pi-agent): no values, headers or paths. */
export interface ConfigStatusDTO { state: "none" | "ready" | "shadowed" | "blocked"; code: string | null; configRevision: number; generationId: string | null; deferred: string[];
  /** An import was committed but applies only after the runtime restarts. */
  pendingRestart?: { configRevision: number; generationId: string } }

/** Pre-2.0 UI queue/timer item → runtime cutover journal (src-tauri/resources/agent/src/migration/cutover.ts). */
export type CutoverEngine = "opencode" | "pi-cli" | "runtime";
export interface CutoverSessionRef { engine: CutoverEngine; id: string; directory: string; sourceOrigin?: string }
export interface CutoverItem {
  kind: "queue" | "timer"; legacyId: string; session: CutoverSessionRef;
  queue?: { text: string; parts: PromptPart[]; model: ModelRef; agent?: string; state: "ready" | "uncertain"; error?: string; queuedAt?: number; missingAttachments?: number };
  timer?: { title: string; prompt: string; minutes: number; mode: "once" | "repeat"; runAt?: number; requestKey?: string; model: ModelRef;
    enabled: boolean; nextAt?: number; lastAt?: number; state: string; detail?: string };
}
export interface CutoverBatch { installation: string; workspace: string; source: "ui-queue" | "ui-timers"; items: CutoverItem[] }
export interface CutoverReceiptDTO {
  id: string; legacyId: string; kind: "queue" | "timer"; workspace: string; state: "received" | "accepted" | "quarantined" | "resolved";
  sessionID: string | null; itemID: string | null; code: string | null; reason: string | null; retryable: boolean; updatedAt: number;
}

/**
 * Stable for this window (JS realm) and shared by every RuntimeClient in it. The
 * runtime hashes it with the bearer into a `client:` UI principal; it is not a
 * secret and never replaces the bearer. A reload gets a new id (old streams are
 * gone with the old page), a second window never shares one.
 */
const WINDOW_CLIENT_ID: string = crypto.randomUUID();
export function windowClientId(): string { return WINDOW_CLIENT_ID; }

export class RuntimeClient {
  private connection: RuntimeConnection;
  private refreshing: Promise<RuntimeConnection> | null = null;
  readonly clientID = WINDOW_CLIENT_ID;

  constructor(connection: RuntimeConnection, private readonly refresh: () => Promise<RuntimeConnection>, private readonly timeoutMs = 20000) {
    if (!isAllowedBaseUrl(`${connection.endpoint}/`)) throw new ConnectionError("Среда выполнения должна слушать только loopback.");
    this.connection = connection;
  }

  get endpoint(): string { return this.connection.endpoint; }
  get instance(): string { return this.connection.instance; }
  get version(): string { return this.connection.version; }

  /** Headers for every request and every `fetch` stream: bearer + window client id. */
  authorization(): Record<string, string> {
    return { Authorization: `Bearer ${this.connection.token}`, "X-Enki-Client": this.clientID };
  }

  url(path: string, query?: Query): string {
    const url = new URL(`${this.connection.endpoint}${API_PREFIX}${path}`);
    for (const [key, value] of Object.entries(query ?? {}))
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    return url.toString();
  }

  /** Re-read the connection after a 401 (rotated token) or a runtime restart. */
  async reconnect(): Promise<RuntimeConnection> {
    this.refreshing ??= this.refresh().then(next => {
      if (!isAllowedBaseUrl(`${next.endpoint}/`)) throw new ConnectionError("Среда выполнения должна слушать только loopback.");
      this.connection = next;
      return next;
    }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("timeout")), opts.timeoutMs ?? this.timeoutMs);
    const onAbort = () => ctrl.abort(opts.signal?.reason instanceof Error ? opts.signal.reason : undefined);
    if (opts.signal) {
      if (opts.signal.aborted) { clearTimeout(timer); throw opts.signal.reason ?? new DOMException("Aborted", "AbortError"); }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    let unauthorized = false;
    try {
      const res = await fetch(this.url(path, opts.query), {
        method,
        headers: { ...this.authorization(), ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
        cache: "no-store",
      });
      if (res.status === 401 && !retried) { unauthorized = true; await res.body?.cancel(); }
      else {
        if (!res.ok) {
          const text = await res.text();
          let detail = text.slice(0, 400);
          try {
            const parsed = JSON.parse(text) as { message?: unknown };
            if (typeof parsed.message === "string") detail = parsed.message.slice(0, 400);
          } catch { /* plain text */ }
          throw new ApiError(res.status, detail);
        }
        opts.onResponse?.(res);
        // Only endpoints declared `empty` may answer without a body; for a
        // JSON-required one, 204/empty is a contract violation, never `undefined`.
        const text = res.status === 204 ? "" : await res.text();
        if (!text) {
          if (opts.empty) return undefined as T;
          throw new ApiError(res.status, `Среда выполнения не вернула данных для ${method} ${path}`);
        }
        try { return JSON.parse(text) as T; }
        catch { throw new ApiError(res.status, `Среда выполнения вернула некорректный ответ для ${method} ${path}`); }
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (opts.signal?.aborted) throw opts.signal.reason ?? e;
      if (ctrl.signal.aborted) throw new ConnectionError(`Истекло время ожидания: ${method} ${path}`);
      throw new ConnectionError("Среда выполнения Enki недоступна.");
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    // Rotated token: one refresh, then the identical request (commands carry ids).
    if (unauthorized) {
      await this.reconnect().catch(() => { throw new ApiError(401, "Доступ к среде выполнения отклонён."); });
      return this.request<T>(method, path, opts, true);
    }
    throw new ApiError(401, "Доступ к среде выполнения отклонён.");
  }

  // ---------------------------------------------------------------- runtime
  health(signal?: AbortSignal) { return this.request<HealthDTO>("GET", "/health", { signal, timeoutMs: 6000 }); }
  capabilities() { return this.request<CapabilitiesDTO>("GET", "/capabilities"); }
  idle(signal?: AbortSignal) { return this.request<RuntimeActivityDTO & { draining: boolean }>("GET", "/runtime/idle", { signal }); }
  settings() { return this.request<RuntimeSettingsDTO>("GET", "/settings"); }
  saveSettings(patch: Partial<RuntimeSettingsDTO>) { return this.request<RuntimeSettingsDTO>("PUT", "/settings", { body: patch }); }
  /** Which configured resource paths exist on the runtime host; deferred imported keys. */
  resourceStatus(signal?: AbortSignal) { return this.request<ResourceStatusDTO>("GET", "/settings/resources", { signal }); }
  snapshot(directory: string | null, signal?: AbortSignal) { return this.request<SnapshotDTO>("GET", "/snapshot", { query: { directory }, signal }); }

  // ------------------------------------------------------------- workspaces
  projects(signal?: AbortSignal) { return this.request<Project[]>("GET", "/projects", { signal }); }
  paths(directory?: string | null) { return this.request<{ home: string; directory: string; worktree: string; chats: string }>("GET", "/paths", { query: { directory } }); }
  prepareChatWorkspace(id: string) { return this.request<{ directory: string; root: string }>("POST", "/workspaces/chat", { body: { id } }); }
  trustProject(directory: string, trusted: boolean) { return this.request<{ directory: string; trusted: boolean }>("POST", "/projects/trust", { body: { directory, trusted } }); }
  vcs(directory: string, signal?: AbortSignal) { return this.request<VcsInfo | null>("GET", "/vcs", { query: { directory }, signal }).catch(() => null); }
  vcsStatus(directory: string, signal?: AbortSignal) { return this.request<VcsInfo & { files?: unknown[] }>("GET", "/vcs/status", { query: { directory }, signal }); }
  vcsDiff(directory: string, opts: { mode?: "git" | "branch"; context?: number; signal?: AbortSignal } = {}) {
    return this.request<SessionDiffFile[]>("GET", "/vcs/diff", { query: { directory, mode: opts.mode ?? "git", context: opts.context }, signal: opts.signal });
  }
  fileList(directory: string, path: string, signal?: AbortSignal) { return this.request<FileEntry[]>("GET", "/files", { query: { directory, path }, signal }); }
  fileContent(directory: string, path: string, signal?: AbortSignal) {
    return this.request<{ type: string; content?: string; source?: Record<string, unknown> }>("GET", "/files/content", { query: { directory, path }, signal });
  }

  // --------------------------------------------------------------- sessions
  listSessions(directory: string, opts: { limit?: number; signal?: AbortSignal } = {}) {
    return this.request<SessionDTO[]>("GET", "/sessions", { query: { directory, limit: opts.limit }, signal: opts.signal });
  }
  recentSessions(query: { archived?: boolean; cursor?: number; limit?: number; search?: string; directory?: string }, signal?: AbortSignal) {
    return this.request<{ sessions: SessionDTO[]; cursor: number | null }>("GET", "/sessions/recent", { query: { ...query, archived: query.archived ? "true" : undefined }, signal });
  }
  sessionStatuses(directory: string | null, signal?: AbortSignal) {
    return this.request<Record<string, SessionStatusDTO>>("GET", "/sessions/status", { query: { directory }, signal });
  }
  getSession(id: string, directory: string | null, signal?: AbortSignal) {
    return this.request<SessionDTO>("GET", `/sessions/${encodeURIComponent(id)}`, { query: { directory }, signal });
  }
  createSession(body: { directory: string; title?: string; permission?: PermissionRule[] | null; model?: ModelRef | null; workshop?: boolean }, signal?: AbortSignal) {
    return this.request<SessionDTO>("POST", "/sessions", { body, signal });
  }
  updateSession(id: string, directory: string | null, patch: { title?: string; permission?: PermissionRule[] | null; time?: { archived?: number | null }; workshop?: boolean }) {
    return this.request<SessionDTO>("PATCH", `/sessions/${encodeURIComponent(id)}`, { query: { directory }, body: patch });
  }
  deleteSession(id: string, directory: string | null) {
    return this.request<void>("DELETE", `/sessions/${encodeURIComponent(id)}`, { query: { directory }, empty: true });
  }
  /** `messageID` null copies the whole current branch into a new session. */
  forkSession(id: string, directory: string, messageID: string | null, title?: string) {
    return this.request<SessionDTO>("POST", `/sessions/${encodeURIComponent(id)}/fork`, { query: { directory }, body: { messageID, ...(title ? { title } : {}) } });
  }
  continueLegacy(id: string, directory: string) {
    // A verified large archive needs two bounded streaming passes before the
    // SDK seed is committed. Ordinary HTTP reads keep their shorter deadline.
    return this.request<SessionDTO>("POST", `/sessions/${encodeURIComponent(id)}/continue`, { query: { directory }, body: {}, timeoutMs: 120000 });
  }
  messages(id: string, opts: { directory?: string | null; limit?: number; before?: string; signal?: AbortSignal } = {}) {
    return this.request<{ messages: MessageDTO[]; before: string | null }>("GET", `/sessions/${encodeURIComponent(id)}/messages`, {
      query: { directory: opts.directory, limit: opts.limit, before: opts.before }, signal: opts.signal,
    });
  }
  children(id: string, directory: string, signal?: AbortSignal) {
    return this.request<SessionDTO[]>("GET", `/sessions/${encodeURIComponent(id)}/children`, { query: { directory }, signal });
  }
  sessionDiff(id: string, directory: string, signal?: AbortSignal) {
    return this.request<SessionDiffFile[]>("GET", `/sessions/${encodeURIComponent(id)}/diff`, { query: { directory }, signal });
  }
  usage(id: string, directory: string, signal?: AbortSignal) {
    return this.request<unknown>("GET", `/sessions/${encodeURIComponent(id)}/usage`, { query: { directory }, signal });
  }
  stop(id: string, directory: string) {
    return this.request<{ stopped: boolean }>("POST", `/sessions/${encodeURIComponent(id)}/stop`, { query: { directory }, body: {} });
  }

  // ------------------------------------------------------------------ queue
  queue(id: string, directory: string) { return this.request<QueueStateDTO>("GET", `/sessions/${encodeURIComponent(id)}/queue`, { query: { directory } }); }
  enqueue(id: string, directory: string, item: { id: string; text: string; parts: PromptPart[]; model: ModelRef }) {
    return this.request<QueueStateDTO>("POST", `/sessions/${encodeURIComponent(id)}/queue`, { query: { directory }, body: item, timeoutMs: 120000 });
  }
  editQueued(id: string, directory: string, item: string, patch: { text?: string; parts?: PromptPart[]; addParts?: PromptPart[]; removeAttachments?: string[]; model?: ModelRef }) {
    return this.request<QueueStateDTO>("PATCH", `/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(item)}`, { query: { directory }, body: patch, timeoutMs: 120000 });
  }
  removeQueued(id: string, directory: string, item: string) {
    return this.request<QueueStateDTO | null>("DELETE", `/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(item)}`, { query: { directory } });
  }
  reorderQueued(id: string, directory: string, item: string, before: string | null) {
    return this.request<QueueStateDTO>("POST", `/sessions/${encodeURIComponent(id)}/queue/reorder`, { query: { directory }, body: { id: item, before } });
  }
  resumeQueue(id: string, directory: string, model?: ModelRef) {
    return this.request<QueueStateDTO>("POST", `/sessions/${encodeURIComponent(id)}/queue/resume`, { query: { directory }, body: model ? { model } : {} });
  }
  pauseQueue(id: string, directory: string) {
    return this.request<QueueStateDTO>("POST", `/sessions/${encodeURIComponent(id)}/queue/pause`, { query: { directory }, body: {} });
  }
  steerQueued(id: string, directory: string, item: string) {
    return this.request<CommandReceipt>("POST", `/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(item)}/steer`, { query: { directory }, body: {} });
  }
  acknowledgeQueued(id: string, directory: string, item: string, action: "drop" | "requeue") {
    return this.request<QueueStateDTO | null>("POST", `/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(item)}/acknowledge`, { query: { directory }, body: { action } });
  }

  // --------------------------------------------------------------- commands
  /** Idempotent by `request.id`: a lost acknowledgement is retried with the same id. */
  command(request: CommandRequest, signal?: AbortSignal) {
    return this.request<CommandReceipt>("POST", "/commands", { body: request, signal, timeoutMs: 120000 });
  }
  receipt(id: string, signal?: AbortSignal) { return this.request<CommandReceipt>("GET", `/commands/${encodeURIComponent(id)}`, { signal }); }

  // ------------------------------------------------------------ interaction
  permissions(directory: string | null, signal?: AbortSignal) { return this.request<PermissionRequestDTO[]>("GET", "/permissions", { query: { directory }, signal }); }
  replyPermission(id: string, reply: "once" | "always" | "reject") {
    return this.request<void>("POST", `/permissions/${encodeURIComponent(id)}/reply`, { body: { reply }, empty: true });
  }
  dialogs(directory: string | null, signal?: AbortSignal) { return this.request<DialogRequestDTO[]>("GET", "/dialogs", { query: { directory }, signal }); }
  replyDialog(id: string, answer: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
    return this.request<void>("POST", `/dialogs/${encodeURIComponent(id)}/reply`, { body: answer, empty: true });
  }
  replyBroker(id: string, result: { ok: true; value: unknown } | { ok: false; error: string }) {
    return this.request<void>("POST", `/broker/${encodeURIComponent(id)}`, { body: result, empty: true });
  }
  questions(directory: string | null, signal?: AbortSignal) { return this.request<QuestionRequestDTO[]>("GET", "/questions", { query: { directory }, signal }); }
  replyQuestion(id: string, answers: string[][], directory: string) {
    return this.request<void>("POST", `/questions/${encodeURIComponent(id)}/reply`, { query: { directory }, body: { answers }, empty: true });
  }
  rejectQuestion(id: string, directory: string) {
    return this.request<void>("POST", `/questions/${encodeURIComponent(id)}/reject`, { query: { directory }, body: {}, empty: true });
  }

  // -------------------------------------------------------------- plugin UI
  /** SSE: `open` starts/adopts the worker (mutation), `events` watches without opening. */
  uiStreamUrl(id: string, directory: string, mode: "open" | "events") { return this.url(`/sessions/${encodeURIComponent(id)}/ui/${mode}`, { directory }); }
  /** Plugin-UI route answering JSON (`T`). */
  private ui<T>(method: string, id: string, directory: string, route: string, body?: unknown, signal?: AbortSignal, empty = false) {
    return this.request<T>(method, `/sessions/${encodeURIComponent(id)}/ui${route}`, { query: { directory }, ...(body !== undefined ? { body } : {}), signal, empty });
  }
  /** Plugin-UI route whose handler returns nothing (204). */
  private uiVoid(id: string, directory: string, route: string, body: unknown) {
    return this.ui<void>("POST", id, directory, route, body, undefined, true);
  }
  uiSnapshot(id: string, directory: string, signal?: AbortSignal) { return this.ui<UiSnapshot>("GET", id, directory, "", undefined, signal); }
  uiControl(id: string, directory: string) { return this.ui<SurfaceAttachment>("POST", id, directory, "/control", {}); }
  uiRelease(id: string, directory: string) { return this.uiVoid(id, directory, "/release", {}); }
  uiInput(id: string, directory: string, command: UiInput) { return this.ui<InputReceipt>("POST", id, directory, "/input", command); }
  uiResize(id: string, directory: string, command: UiResize) { return this.uiVoid(id, directory, "/resize", command); }
  uiResync(id: string, directory: string) { return this.uiVoid(id, directory, "/resync", {}); }
  uiRetryDraft(id: string, directory: string) { return this.uiVoid(id, directory, "/retry-draft", {}); }
  uiRetrySubmission(id: string, directory: string) { return this.uiVoid(id, directory, "/retry-submission", {}); }
  uiResolveDraft(id: string, directory: string, choice: DraftResolution) { return this.uiVoid(id, directory, "/resolve-draft", choice); }
  /** CAS replace. A 409 is an explicit conflict carrying the canonical draft; it is never retried with a new id. */
  async uiDraft(id: string, directory: string, mutation: { id: string; baseRevision: number; text: string; selection?: { start: number; end: number } }):
    Promise<{ ok: true; result: DraftResult } | { ok: false; message: string; canonical: DraftSnapshot | null }> {
    try { return { ok: true, result: await this.ui<DraftResult>("POST", id, directory, "/draft", mutation) }; }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      const canonical = await this.uiSnapshot(id, directory).then(snapshot => snapshot.draft, () => null);
      return { ok: false, message: error.message, canonical };
    }
  }

  // -------------------------------------------------------------- schedules
  schedules(query: { directory?: string; session?: string } = {}) { return this.request<{ tasks: ScheduleDTO[] }>("GET", "/schedules", { query }); }
  addSchedule(body: { directory: string; sessionID: string; title: string; prompt: string; minutes: number; mode: "once" | "repeat"; runAt?: number; requestKey?: string; model: ModelRef }) {
    return this.request<ScheduleDTO>("POST", "/schedules", { body });
  }
  toggleSchedule(id: string, enabled: boolean) { return this.request<ScheduleDTO>("PATCH", `/schedules/${encodeURIComponent(id)}`, { body: { enabled } }); }
  removeSchedule(id: string) { return this.request<void>("DELETE", `/schedules/${encodeURIComponent(id)}`, { empty: true }); }

  // ----------------------------------------------------------------- models
  providers(signal?: AbortSignal) { return this.request<ProvidersDTO>("GET", "/providers", { signal }); }
  providersSettled(signal?: AbortSignal) { return this.request<ProvidersDTO>("GET", "/providers/settled", { signal, timeoutMs: 35000 }); }
  refreshProviders() { return this.request<{ errors: string[] }>("POST", "/providers/refresh", { body: {}, timeoutMs: 45000 }); }
  checkModel(providerID: string, modelID: string, signal?: AbortSignal) {
    return this.request<{ ok: boolean; detail: string }>("POST", "/models/check", { body: { providerID, modelID }, signal, timeoutMs: 120000 });
  }
  setCredential(provider: string, apiKey: string | null) {
    return this.request<{ provider: string; configured: boolean }>("POST", `/credentials/${encodeURIComponent(provider)}`, { body: { apiKey } });
  }
  importPiCredentials() { return this.request<{ imported: string[]; kept: string[]; failed: Array<{ provider: string; reason: string }> }>("POST", "/credentials/import-pi", { body: {}, timeoutMs: 120000 }); }
  /** `readOnly` when an imported Pi generation is active (the runtime refuses PUT then). */
  modelsConfig() {
    return this.request<{ path: string; content: string; readOnly?: boolean; source?: "owner" | "imported"; state?: ConfigStatusDTO["state"]; configRevision?: number }>("GET", "/config/models");
  }
  saveModelsConfig(expected: string, content: string) {
    return this.request<{ path: string; content: string }>("PUT", "/config/models", { body: { expected, content } });
  }
  extensions(directory?: string | null) {
    return this.request<{ sessions: Array<{ sessionID: string; errors: unknown[]; unsupported: string[] }>; mcp: unknown }>("GET", "/extensions", { query: { directory } });
  }
  /**
   * Call ONLY after a confirmed shared-registry/skill/capability commit on this
   * host. New workers use the new scope at once; idle workers reopen, busy ones
   * are marked pending until idle (never aborted or replayed). `null` = all folders.
   */
  refreshCapabilities(directory: string | null) {
    return this.request<{ reopened: number; pending: number }>("POST", "/capabilities/refresh", { body: directory ? { directory } : {} });
  }
  /** Imported Pi default model (only when admissible in the live catalog). */
  configDefaults(signal?: AbortSignal) { return this.request<{ model: ModelRef | null; code: string | null }>("GET", "/config/defaults", { signal }); }

  // ------------------------------------------------------------- migrations
  migrations() { return this.request<MigrationsDTO>("GET", "/migrations"); }
  importOpenCode() { return this.request<unknown>("POST", "/migrations/opencode", { body: {}, timeoutMs: 600000 }); }
  /** Resolve a saved original ID only against this supervisor's verified OpenCode source. */
  resolveLegacySession(legacyID: string, directory: string) {
    return this.request<SessionDTO>("POST", "/migrations/opencode/session", { body: { legacyID, directory } });
  }
  importPiCli(sessions: unknown[]) { return this.request<unknown>("POST", "/migrations/pi-cli", { body: { sessions }, timeoutMs: 600000 }); }
  importPiAgent() { return this.request<unknown>("POST", "/migrations/pi-agent", { body: {}, timeoutMs: 120000 }); }
  /** Origin-bound POSITIVE delivery evidence for a pre-2.0 lost-ACK send; absence is "unknown". */
  migrationEvidence(body: { engine: "opencode" | "pi-cli"; sessionID: string; messageID: string; directory: string; text: string }) {
    return this.request<{ evidence: "delivered" | "likely_delivered" | "archive_missing" | "unknown"; sessionID?: string; detail: string }>("POST", "/migrations/evidence", { body });
  }
  configStatus(signal?: AbortSignal) { return this.request<ConfigStatusDTO>("GET", "/migrations/pi-agent", { signal }); }
  /** Idempotent by (installation, workspace, source, kind, legacyId): a retry returns the same receipts. */
  cutover(batch: CutoverBatch, signal?: AbortSignal) {
    return this.request<{ receipts: CutoverReceiptDTO[] }>("POST", "/migrations/cutover", { body: batch, signal, timeoutMs: 600000 });
  }
  cutoverReceipts(query: { installation?: string; workspace?: string } = {}, signal?: AbortSignal) {
    return this.request<CutoverReceiptDTO[]>("GET", "/migrations/cutover", { query, signal });
  }
  retryCutover(id: string) { return this.request<CutoverReceiptDTO>("POST", `/migrations/cutover/${encodeURIComponent(id)}/retry`, { body: {}, timeoutMs: 120000 }); }
  resolveCutover(id: string) { return this.request<CutoverReceiptDTO>("POST", `/migrations/cutover/${encodeURIComponent(id)}/resolve`, { body: {} }); }

  // -------------------------------------------------------------------- pty
  ptyList(directory: string, signal?: AbortSignal) { return this.request<PtyDTO[]>("GET", "/pty", { query: { directory }, signal }); }
  ptyCreate(directory: string, title: string, size: { cols: number; rows: number }) {
    return this.request<PtyDTO>("POST", "/pty", { body: { directory, title, ...size } });
  }
  ptyGet(id: string, directory: string, signal?: AbortSignal) { return this.request<PtyDTO>("GET", `/pty/${encodeURIComponent(id)}`, { query: { directory }, signal }); }
  ptyUpdate(id: string, directory: string, patch: { title?: string; size?: { rows: number; cols: number } }) {
    return this.request<void>("PUT", `/pty/${encodeURIComponent(id)}`, { body: { directory, ...patch }, empty: true });
  }
  ptyKill(id: string, directory: string) { return this.request<void>("DELETE", `/pty/${encodeURIComponent(id)}`, { query: { directory }, empty: true }); }
  ptyClosing(directory: string, signal?: AbortSignal) { return this.request<PtyClosingDTO[]>("GET", "/pty/closing", { query: { directory }, signal }); }
  /** Stop tracking a closed shell; nothing is signalled and cleanup stays unknown. */
  ptyDetach(id: string, directory: string) {
    return this.request<{ id: string; detached: true; cleanup: "unknown"; primaryExited: boolean }>("POST", `/pty/${encodeURIComponent(id)}/detach`, { body: { directory } });
  }
  ptyInput(id: string, directory: string, data: string) {
    return this.request<void>("POST", `/pty/${encodeURIComponent(id)}/input`, { body: { directory, data }, empty: true });
  }
  /** SSE output stream (base64 chunks with a character cursor); headers via authorization(). */
  ptyStreamUrl(id: string, directory: string, after: number) { return this.url(`/pty/${encodeURIComponent(id)}/stream`, { directory, after }); }
}
