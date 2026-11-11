// LAN remote-control client. This is a transport adapter over the existing
// Runtime, not another agent loop: Hub stores snapshots/commands, this Runtime
// executes them through its dispatcher, queue and interaction broker.
import type { Runtime, RuntimeSettings } from "./core/runtime.ts";
import { validSettings } from "./core/runtime.ts";
import { providers } from "./models/catalog.ts";
import { refreshCatalog } from "./sdk/adapter.ts";
import { sessionDTO, type SessionRecord } from "./sessions/catalog.ts";
import path from "node:path";
import { validDirectory } from "./platform/paths.ts";
import { isModelRef, isReadOnlyOrigin, type CommandRequest, type MessageDTO, type ModelRef } from "./protocol.ts";

type RemoteCommand = { id: string; session: string | null; kind: string; payload: Record<string, unknown> };
type SyncAnswer = { commands?: RemoteCommand[]; watch?: string | null };

function text(value: unknown, limit = 200_000): string {
  if (typeof value !== "string") throw new Error("Нужен текст.");
  if (value.length > limit) throw new Error("Текст слишком длинный.");
  return value;
}

function boundedMessages(messages: MessageDTO[]): MessageDTO[] {
  // Remote views are bounded. The full local transcript is never rewritten.
  return messages.map(message => ({ ...message, parts: message.parts.map(part => part.type === "tool" && part.state
    ? { ...part, state: { ...part.state, output: typeof part.state.output === "string" ? part.state.output.slice(-12_000) : part.state.output, metadata: undefined } }
    : part) }));
}

export class RemoteControl {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private readonly results = new Map<string, { ok: boolean; result: unknown }>();
  private updates: unknown = null;
  private updatesAt = 0;
  private readonly abort = new AbortController();

  constructor(private readonly runtime: Runtime, private readonly intervalMs = 2_000) {}

  start(): void {
    if (this.timer || this.running || this.stopped) return;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { this.timer = null; void this.tick(); }, this.intervalMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped || this.runtime.draining) { this.schedule(); return; }
    this.running = true;
    try {
      const identity = await this.runtime.config.broker.call<{ scope: string | null }>("hub.identity", {}, this.abort.signal, 5_000);
      if (!identity.scope) return;
      if (Date.now()-this.updatesAt > 10_000) {
        try {
          this.updates = await this.runtime.config.broker.call("updates.control", { action: "status" }, this.abort.signal, 5_000);
          this.updatesAt = Date.now();
        } catch { /* older Enki or remote runtimes without update control */ }
      }
      const response = await this.runtime.config.broker.call<SyncAnswer>("hub.request", {
        path: "remote/sync", scope: identity.scope,
        body: { overview: this.overview() },
      }, this.abort.signal, 15_000);
      // Commands are completed individually: one bad session never blocks others.
      for (const command of response.commands ?? []) {
        if (this.stopped) break;
        let result: unknown, ok = false;
        const previous = this.results.get(command.id);
        if (previous) { ok = previous.ok; result = previous.result; }
        else {
          try { result = await this.execute(command); ok = true; }
          catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
          this.results.set(command.id, { ok, result });
          if (this.results.size > 500) this.results.delete(this.results.keys().next().value!);
        }
        try {
          await this.runtime.config.broker.call("hub.request", { path: "remote/complete", scope: identity.scope,
            body: { id: command.id, ok, result } }, this.abort.signal, 10_000);
        } catch { /* delivered state is retried only by an explicit owner action */ }
      }
      if (response.watch) {
        await this.runtime.config.broker.call("hub.request", { path: "remote/sync", scope: identity.scope,
          body: { overview: this.overview(), detail: this.detail(response.watch) } }, this.abort.signal, 15_000);
      }
    } catch {
      // Hub absence must not affect local chats. The next bounded poll reconnects.
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  overview(): Record<string, unknown> {
    const sessions = this.runtime.catalog.recent({ archived: false, limit: 200 }).records.map(sessionDTO);
    const providersDTO = providers(this.runtime.modelRuntime, null, this.runtime.modelAccess?.snapshot());
    return {
      version: this.runtime.config.version, instance: this.runtime.instance, startedAt: this.runtime.startedAt,
      host: this.runtime.config.host, hostId: this.runtime.hostId, platform: process.platform,
      sessions, statuses: this.runtime.statuses(null), providers: providersDTO,
      settings: this.runtime.settings(), projects: this.runtime.catalog.directories(),
      questions: this.runtime.interactions.pendingQuestions(), permissions: this.runtime.interactions.pendingPermissions(),
      activity: this.runtime.activity(), queues: this.runtime.queue.sessions(null), updates: this.updates,
    };
  }

  detail(sessionID: string): Record<string, unknown> {
    const record = this.runtime.catalog.get(sessionID);
    if (!record) return { session: sessionID, missing: true, messages: [] };
    const history = this.runtime.registry.historyPage(record, 100);
    return {
      session: sessionID, info: sessionDTO(record), messages: boundedMessages(history.messages),
      queue: this.runtime.queue.state(sessionID), status: this.runtime.statuses(record.directory)[sessionID] ?? { type: "idle" },
      questions: this.runtime.interactions.pendingQuestions(record.directory).filter(q => q.sessionID === sessionID),
      permissions: this.runtime.interactions.pendingPermissions(record.directory).filter(p => p.sessionID === sessionID),
    };
  }

  private record(command: RemoteCommand): SessionRecord {
    if (!command.session) throw new Error("Не указана сессия.");
    const record = this.runtime.catalog.get(command.session);
    if (!record) throw new Error("Сессия не найдена.");
    return record;
  }

  private submit(command: RemoteCommand, kind: CommandRequest["kind"], payload: CommandRequest["payload"]): unknown {
    if (!command.session) throw new Error("Не указана сессия.");
    const record = this.record(command);
    const request = { id: command.id, sessionID: record.id, directory: record.directory, kind, payload } as CommandRequest;
    return this.runtime.dispatcher.submit(request,
      kind === "prompt" || kind === "steer" ? { source: "manual", sourceId: null } : undefined);
  }

  private async execute(command: RemoteCommand): Promise<unknown> {
    const payload = command.payload;
    switch (command.kind) {
      case "prompt": {
        const record = this.record(command);
        if (isReadOnlyOrigin(record.origin)) throw new Error("Архив доступен только для чтения.");
        const model = payload.model;
        if (!isModelRef(model)) throw new Error("Выберите модель.");
        const value = text(payload.text);
        if (!value.trim()) throw new Error("Пустой запрос.");
        if (this.runtime.dispatcher.inFlight(record.id)) {
          return { queued: true, queue: this.runtime.queue.enqueue(record.id, record.directory, { id: command.id, text: value, parts: [], model }) };
        }
        return { receipt: this.submit(command, "prompt", { parts: [{ type: "text", text: value }], model }) };
      }
      case "stop": {
        const record = this.record(command);
        this.runtime.queue.stop(record.id);
        await this.runtime.dispatcher.abort(record.id);
        return { stopped: true };
      }
      case "model.set": {
        if (!isModelRef(payload.model)) throw new Error("Некорректная модель.");
        return { receipt: this.submit(command, "model.set", { model: payload.model }) };
      }
      case "compact": return { receipt: this.submit(command, "compact", {}) };
      case "question.reply":
        if (!runtimeId(payload.id)) throw new Error("Некорректный вопрос.");
        if (!this.runtime.interactions.replyQuestion(payload.id, payload.answers)) throw new Error("Вопрос уже закрыт.");
        return { answered: true };
      case "question.reject":
        if (!runtimeId(payload.id) || !this.runtime.interactions.rejectQuestion(payload.id)) throw new Error("Вопрос уже закрыт.");
        return { rejected: true };
      case "permission.reply": {
        if (!runtimeId(payload.id) || !["once", "always", "reject"].includes(String(payload.reply))) throw new Error("Некорректный ответ.");
        if (!this.runtime.interactions.replyPermission(payload.id, payload.reply as "once" | "always" | "reject")) throw new Error("Запрос уже закрыт.");
        return { answered: true };
      }
      case "session.create": {
        const directory = text(payload.directory, 4096);
        if (!path.isAbsolute(directory) || !validDirectory(directory)) throw new Error("Папка проекта недоступна на этом компьютере.");
        const model = payload.model;
        if (model !== undefined && model !== null && !isModelRef(model)) throw new Error("Некорректная модель.");
        const created = this.runtime.registry.create({ directory, model: isModelRef(model) ? model : this.runtime.configDefaults().model });
        let receipt: unknown = null;
        const prompt = payload.prompt === undefined ? "" : text(payload.prompt);
        if (prompt.trim()) {
          const selected = created.model ?? this.runtime.configDefaults().model;
          if (!selected) throw new Error("Выберите модель для нового задания.");
          receipt = this.runtime.dispatcher.submit({ id: `${command.id}:prompt`, sessionID: created.id, directory,
            kind: "prompt", payload: { parts: [{ type: "text", text: prompt }], model: selected } }, { source: "manual", sourceId: null });
        }
        return { session: sessionDTO(created), receipt };
      }
      case "settings.update": {
        const patch = payload.patch;
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Некорректные настройки.");
        const p = patch as Record<string, unknown>;
        const allowed = new Set(["defaultPolicy", "browserEnabled", "lspEnabled", "compaction"]);
        if (Object.keys(p).some(key => !allowed.has(key))) throw new Error("Эта настройка пока не доступна удалённо.");
        const next = { ...this.runtime.settings(), ...p } as RuntimeSettings;
        if (!validSettings(next)) throw new Error("Некорректные настройки.");
        return { settings: this.runtime.saveSettings(next) };
      }
      case "queue.pause": {
        const record = this.record(command); this.runtime.queue.pause(record.id, null); return this.runtime.queue.state(record.id);
      }
      case "queue.resume": {
        const record = this.record(command);
        return this.runtime.queue.resume(record.id, isModelRef(payload.model) ? payload.model as ModelRef : undefined);
      }
      case "update.check": case "update.prepare": case "update.apply": {
        const action = command.kind.slice("update.".length);
        const result = await this.runtime.config.broker.call("updates.control", { action }, this.abort.signal, 120_000);
        this.updatesAt = 0;
        return { update: result };
      }
      case "providers.refresh": {
        const errors = await refreshCatalog(this.runtime.modelRuntime, AbortSignal.timeout(30_000));
        this.runtime.modelAccess?.invalidate(); void this.runtime.modelAccess?.refresh();
        return { errors };
      }
      default: throw new Error("Неподдерживаемая операция.");
    }
  }
}

function runtimeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
}
