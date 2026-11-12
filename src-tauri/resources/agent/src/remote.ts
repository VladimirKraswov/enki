// LAN remote-control client. This is a transport adapter over the existing
// Runtime, not another agent loop: Hub stores snapshots/commands, this Runtime
// executes them through its dispatcher, queue and interaction broker.
import type { Runtime, RuntimeSettings } from "./core/runtime.ts";
import { validSettings } from "./core/runtime.ts";
import { refreshCatalog } from "./sdk/adapter.ts";
import { sessionDTO, type SessionRecord } from "./sessions/catalog.ts";
import path from "node:path";
import { validDirectory } from "./platform/paths.ts";
import { isModelRef, isReadOnlyOrigin, type CommandRequest, type ModelRef } from "./protocol.ts";
import { remoteOverview, remoteDetail } from "./remote/snapshot.ts";
import { RemoteSyncTransport, type RemoteCommand } from "./remote/sync.ts";
import { hubRequest } from "./remote/hub.ts";
export { fitRemoteDetail } from "./remote/snapshot.ts";

function text(value: unknown, limit = 200_000): string {
  if (typeof value !== "string") throw new Error("Нужен текст.");
  if (value.length > limit) throw new Error("Текст слишком длинный.");
  return value;
}

export class RemoteControl {
  private updates: unknown = null;
  private readonly transport: RemoteSyncTransport;

  constructor(private readonly runtime: Runtime, intervalMs = 1_000) {
    this.transport = new RemoteSyncTransport(runtime, intervalMs, {
      request: hubRequest(runtime), overview: () => this.overview(),
      detail: session => this.detail(session), execute: (command, signal) => this.execute(command, signal),
    });
  }
  start(): void { this.transport.start(); }
  stop(): void { this.transport.stop(); }

  overview(): Record<string, unknown> { return remoteOverview(this.runtime, this.updates); }
  detail(sessionID: string): Record<string, unknown> { return remoteDetail(this.runtime, sessionID); }

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

  private async execute(command: RemoteCommand, signal: AbortSignal): Promise<unknown> {
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
        const result = await this.runtime.config.broker.call("updates.control", { action }, signal, 120_000);
        this.updates = result;
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
