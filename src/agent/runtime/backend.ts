// The Enki Runtime as the application's agent backend.
import type {
  CommandReceipt,
  CommandRequest,
  DialogRequestDTO,
  EventEnvelope,
  ModelRef,
  PromptPart,
  QueueStateDTO,
  ScheduleDTO,
  SessionDTO,
} from "../../../src-tauri/resources/agent/src/protocol";
import { ApiError, ConnectionError } from "../../api/http";
import {
  normalizeMessage,
  normalizeSession,
  normalizeStatusType,
  type HealthInfo,
  type MessagePart,
  type MessageResponse,
  type PermissionRequest,
  type PromptRequest,
  type ProviderResponse,
  type QuestionRequest,
  type Session,
  type SessionStatus,
} from "../../api/types";
import type {
  AgentBackend,
  AgentCapabilities,
  AgentPaths,
  AgentRuntimeConfig,
  CreateSessionInput,
  DirectoryEvent,
  EventSubscription,
  SessionPatch,
} from "../backend";
import { RuntimeClient, type RuntimeConnection } from "./client";
import { runRuntimeStream } from "./events";
import { RUNTIME_AGENT_ID } from "./ids";

export const RUNTIME_CAPABILITIES: AgentCapabilities = {
  pty: true,
  permissions: true,
  questions: true,
  attachments: true,
  fork: true,
  compaction: true,
  vcsDiff: true,
  projectlessChat: true,
};

/** Runtime session DTO → the UI session model (origin/workshop preserved). */
export function sessionOf(dto: SessionDTO): Session {
  return { ...normalizeSession(dto as unknown as Record<string, unknown>), origin: dto.origin, workshop: dto.workshop === true };
}

/** Accepted means durably recorded; a refusal is a definite "not sent". */
export function acceptedReceipt(receipt: CommandReceipt): CommandReceipt {
  if (receipt.state === "rejected") throw new ApiError(409, receipt.error || "Среда выполнения отклонила команду.");
  return receipt;
}

function modelOf(body: PromptRequest): ModelRef {
  if (!body.model) throw new ApiError(400, "Не выбрана модель.");
  return { providerID: body.model.providerID, modelID: body.model.modelID, ...(body.variant !== undefined ? { variant: body.variant ?? null } : {}) };
}

export class RuntimeBackend implements AgentBackend {
  readonly id = RUNTIME_AGENT_ID;
  readonly capabilities = RUNTIME_CAPABILITIES;
  readonly client: RuntimeClient;

  constructor(connection: RuntimeConnection, refresh: () => Promise<RuntimeConnection>, readonly workspace: string) {
    this.client = new RuntimeClient(connection, refresh);
  }

  get endpoint(): string { return this.client.endpoint; }

  // ---- connection / runtime metadata ----
  async health(signal?: AbortSignal): Promise<HealthInfo & { contract: number; instance: string; sdk: string; host: "local" | "remote"; hostId?: string }> {
    const health = await this.client.health(signal);
    // hostId: stable identity of this runtime's command ledger (lost-ACK authority).
    return { healthy: health.healthy, version: health.version, contract: health.contract, instance: health.instance, sdk: health.sdk, host: health.host,
      ...(typeof health.hostId === "string" ? { hostId: health.hostId } : {}) };
  }
  async providers(signal?: AbortSignal): Promise<ProviderResponse> {
    const providers = await this.client.providers(signal);
    return { all: providers.all, connected: providers.connected, default: providers.default };
  }
  /** The runtime has one primary agent; there is no agent catalogue to choose from. */
  async agents() { return []; }
  async config(): Promise<AgentRuntimeConfig> { return {}; }

  // ---- workspaces ----
  projects(signal?: AbortSignal) { return this.client.projects(signal); }
  async paths(directory?: string | null): Promise<AgentPaths> {
    const paths = await this.client.paths(directory);
    return { home: paths.home, directory: paths.directory, worktree: paths.worktree };
  }
  vcs(directory: string, signal?: AbortSignal) { return this.client.vcs(directory, signal); }

  // ---- sessions ----
  async listSessions(directory: string | null, opts: { limit?: number; signal?: AbortSignal } = {}) {
    if (!directory) return [];
    return (await this.client.listSessions(directory, opts)).map(sessionOf);
  }
  async recentSessions(archived = false, cursor?: number, filter: { search?: string; directory?: string } = {}) {
    const page = await this.client.recentSessions({ archived, cursor, limit: 20, ...filter });
    return { sessions: page.sessions.map(sessionOf), cursor: page.cursor };
  }
  async getSession(sessionID: string, directory: string | null, signal?: AbortSignal) {
    return sessionOf(await this.client.getSession(sessionID, directory, signal));
  }
  async createSession(input: CreateSessionInput & { workshop?: boolean }) {
    return sessionOf(await this.client.createSession({
      directory: input.directory, title: input.title, permission: input.permission ?? null,
      model: input.model ? { providerID: input.model.providerID, modelID: input.model.id, variant: input.model.variant ?? null } : null,
      ...(input.workshop ? { workshop: true } : {}),
    }, input.signal));
  }
  async updateSession(sessionID: string, patch: SessionPatch & { workshop?: boolean }, directory: string | null) {
    return sessionOf(await this.client.updateSession(sessionID, directory, patch));
  }
  async forkSession(sessionID: string, directory: string, messageID: string) {
    return sessionOf(await this.client.forkSession(sessionID, directory, messageID));
  }
  deleteSession(sessionID: string, directory: string | null) { return this.client.deleteSession(sessionID, directory); }
  async sessionStatuses(directory: string | null, signal?: AbortSignal): Promise<Record<string, SessionStatus>> {
    const map = await this.client.sessionStatuses(directory, signal);
    return Object.fromEntries(Object.entries(map).map(([id, status]) => [id, normalizeStatusType(status)]));
  }
  async continueLegacy(sessionID: string, directory: string) { return sessionOf(await this.client.continueLegacy(sessionID, directory)); }

  // ---- history / execution ----
  async messages(sessionID: string, opts: { directory?: string | null; limit?: number; before?: string; signal?: AbortSignal } = {}) {
    const page = await this.client.messages(sessionID, opts);
    const messages: MessageResponse[] = [];
    for (const item of page.messages) {
      const info = normalizeMessage(item.info as unknown as Record<string, unknown>);
      if (!info) continue;
      messages.push({ info: { ...info, ...(item.info.timingKey ? { timingKey: item.info.timingKey } : {}), ...(item.info.timingSource ? { timingSource: item.info.timingSource } : {}) },
        parts: item.parts as unknown as MessagePart[] });
    }
    return { messages, before: page.before ?? undefined };
  }

  /** Durable command; the id is reused verbatim if the acknowledgement was lost. */
  async submit(request: CommandRequest, signal?: AbortSignal): Promise<CommandReceipt> {
    try { return acceptedReceipt(await this.client.command(request, signal)); }
    catch (error) {
      // The ledger is idempotent by id: retrying a lost acknowledgement returns
      // the original receipt and never starts the turn (or its tools) twice.
      if (!(error instanceof ConnectionError) || signal?.aborted) throw error;
      return acceptedReceipt(await this.client.command(request, signal));
    }
  }

  private promptCommand(kind: "prompt" | "steer", sessionID: string, directory: string, body: PromptRequest): CommandRequest {
    if (!body.messageID) throw new ApiError(400, "Нет идентификатора команды.");
    return {
      id: body.messageID, kind, sessionID, directory,
      payload: {
        parts: body.parts as PromptPart[], model: modelOf(body),
        ...(body.source ? { source: body.source } : {}), ...(body.sourceId ? { sourceId: body.sourceId } : {}),
        ...(body.hubRoute ? { hubRoute: true } : {}),
      },
    };
  }
  async prompt(sessionID: string, directory: string, body: PromptRequest, signal?: AbortSignal) {
    await this.submit(this.promptCommand("prompt", sessionID, directory, body), signal);
  }
  async steer(sessionID: string, directory: string, body: PromptRequest) {
    await this.submit(this.promptCommand("steer", sessionID, directory, body));
  }
  /** Stop: disarms the queue, withdraws gated work and aborts the running turn. */
  async abort(sessionID: string, directory: string) { await this.client.stop(sessionID, directory); }
  async summarize(sessionID: string, directory: string, providerID: string, modelID: string) {
    await this.submit({ id: `compact-${crypto.randomUUID()}`, kind: "compact", sessionID, directory, payload: { model: { providerID, modelID } } });
  }

  // ---- interaction ----
  async pendingPermissions(directory: string | null, signal?: AbortSignal) {
    return (await this.client.permissions(directory, signal)) as PermissionRequest[];
  }
  replyPermission(requestID: string, reply: "once" | "always" | "reject") { return this.client.replyPermission(requestID, reply); }
  /** Structured questions from the runtime `question` tool (never a permission). */
  async pendingQuestions(directory: string | null, signal?: AbortSignal): Promise<QuestionRequest[]> {
    return this.client.questions(directory, signal);
  }
  replyQuestion(requestID: string, answers: string[][], directory: string) { return this.client.replyQuestion(requestID, answers, directory); }
  rejectQuestion(requestID: string, directory: string) { return this.client.rejectQuestion(requestID, directory); }
  dialogs(directory: string | null, signal?: AbortSignal): Promise<DialogRequestDTO[]> { return this.client.dialogs(directory, signal); }
  replyDialog(id: string, answer: { value?: string; confirmed?: boolean; cancelled?: boolean }) { return this.client.replyDialog(id, answer); }

  // ---- queue / schedules (owned by the runtime) ----
  queue(sessionID: string, directory: string): Promise<QueueStateDTO> { return this.client.queue(sessionID, directory); }
  schedules(directory?: string): Promise<{ tasks: ScheduleDTO[] }> { return this.client.schedules(directory ? { directory } : {}); }

  // ---- events ----
  subscribeDirectory(directory: string, subscription: EventSubscription<import("../../api/types").ServerEvent>): void {
    void runRuntimeStream({
      client: this.client, scope: { directory }, signal: subscription.signal,
      onEnvelope: (envelope: EventEnvelope) => subscription.onEvent(envelope.event),
      onState: subscription.onState,
      onReset: reason => subscription.onReset?.(reason),
    });
  }
  subscribeAll(subscription: EventSubscription<DirectoryEvent>): void {
    void runRuntimeStream({
      client: this.client, scope: { all: true }, signal: subscription.signal,
      onEnvelope: (envelope: EventEnvelope) => subscription.onEvent({ directory: envelope.directory ?? undefined, payload: envelope.event }),
      onState: subscription.onState,
      onReset: reason => subscription.onReset?.(reason),
    });
  }
}
