// Enki Runtime API v1 route table. All handlers validate their input and are
// directory-scoped where the resource belongs to a project.

import fs from "node:fs";
import path from "node:path";
import { ClientRelayBroker } from "../control/broker.ts";
import { InteractionInputError } from "../interaction/broker.ts";
import { addUiRoutes } from "./ui-routes.ts";
import type { Runtime } from "../core/runtime.ts";
import { validSettings } from "../core/runtime.ts";
import { PiConfigError } from "../legacy/pi-agent.ts";
import { legacyPiDigest, type PiCliMeta } from "../legacy/pi-cli.ts";
import { validPiId } from "../legacy/pi-jsonl.ts";
import { CutoverInputError, validBatch } from "../migration/cutover.ts";
import { checkModelAccess } from "../models/check.ts";
import { providers } from "../models/catalog.ts";
import { VaultCredentialStore } from "../models/credentials.ts";
import { fileContent, listFiles } from "../platform/files.ts";
import { validDirectory } from "../platform/paths.ts";
import {
  API_PREFIX, CONTRACT_VERSION, EVENT_FRAME_CHARACTERS, SCHEMA_VERSION, SDK_VERSION, isId, isModelRef, isPromptPart, isReadOnlyOrigin, validateCommand,
  type CapabilitiesDTO, type EventEnvelope, type HealthDTO, type ModelRef, type PermissionRule, type PromptPart, type SessionDTO,
} from "../protocol.ts";
import { refreshCatalog, trustStore } from "../sdk/adapter.ts";
import { MAX_MINUTES } from "../schedule/scheduler.ts";
import { sessionDTO, validRules, type SessionRecord } from "../sessions/catalog.ts";
import { ForkRefused } from "../sessions/registry.ts";
import { HttpError, int, openEventStream, Router, STREAMING, str, withStatus, type Request } from "./http.ts";
import { wireEnvelope } from "./wire.ts";

/** Journal replay page and the most pages one reconnect replays (synchronously,
 * on the shared event loop) before an explicit reset is cheaper and honest. */
const REPLAY_PAGE = 5_000;
const REPLAY_PAGES = 8;

function object(body: unknown): Record<string, unknown> {
  if (body === undefined) return {};
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Ожидался объект.");
  return body as Record<string, unknown>;
}

function directoryParam(value: unknown, mustExist = true): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.length > 4096) throw new HttpError(400, "Укажите абсолютный путь каталога.");
  if (mustExist && !validDirectory(value)) throw new HttpError(404, "Каталог недоступен на этом компьютере.");
  return value;
}

function textParam(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new HttpError(400, `Некорректное поле ${field}.`);
  return value;
}

function partsParam(value: unknown): PromptPart[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64 || !value.every(isPromptPart)) throw new HttpError(400, "Некорректные вложения.");
  return value;
}

export function buildRoutes(runtime: Runtime, relay: ClientRelayBroker | null): Router {
  const router = new Router();
  // `mutation` defaults to non-GET/HEAD. GETs that open/adopt workers pass true
  // so they share the synchronous maintenance admission fence.
  const r = (method: string, route: string, handler: (request: Request) => unknown, options: { mutation?: boolean } = {}) =>
    router.add(method, `${API_PREFIX}${route}`, handler, options);

  const record = (id: string): SessionRecord => {
    if (!isId(id)) throw new HttpError(400, "Некорректный идентификатор сессии.");
    const found = runtime.catalog.get(id);
    if (!found) throw new HttpError(404, "Сессия не найдена.");
    return found;
  };
  const scoped = (request: Request): SessionRecord => {
    const found = record(request.params.id);
    const directory = str(request.query, "directory");
    if (directory && directory !== found.directory) throw new HttpError(409, "Сессия относится к другой папке.");
    return found;
  };

  // ------------------------------------------------------------ runtime
  r("GET", "/health", (): HealthDTO => ({
    healthy: true, version: runtime.config.version, contract: CONTRACT_VERSION, schema: SCHEMA_VERSION, sdk: SDK_VERSION,
    node: process.version, platform: process.platform, arch: process.arch, instance: runtime.instance, startedAt: runtime.startedAt,
    host: runtime.config.host, draining: runtime.draining, hostId: runtime.hostId,
  }));
  r("GET", "/capabilities", async (): Promise<CapabilitiesDTO> => ({
    pty: await runtime.pty.available(), permissions: true, questions: true, attachments: true, fork: true, compaction: true,
    vcsDiff: true, projectlessChat: true, queue: true, schedules: true, legacyImport: true,
    extensionUi: { dialogs: true, notify: true, status: true, widgetsText: true, tui: true },
  }));
  // After a CONFIRMED shared-registry/skill/capability commit for this host:
  // new workers use the new scope at once, open ones reopen only when idle.
  r("POST", "/capabilities/refresh", async (request) => {
    const body = object(request.body), directory = body.directory;
    if (directory !== undefined && directory !== null && (typeof directory !== "string" || !path.isAbsolute(directory)))
      throw new HttpError(400, "Укажите абсолютный каталог проекта или не указывайте его.");
    return runtime.refreshCapabilities(typeof directory === "string" ? directory : null);
  });
  r("GET", "/runtime/idle", () => ({ ...runtime.activity(), draining: runtime.draining, instance: runtime.instance }));
  // No HTTP drain: its own admission reservation kept the runtime non-quiescent,
  // so it waited on itself. Quit/update use the authenticated supervisor
  // lifecycle (control channel + maintenance gate) exclusively.
  r("GET", "/settings", () => runtime.settings());
  // Explicit resource paths of this host: which exist (missing ones are not loaded).
  r("GET", "/settings/resources", () => runtime.resourceStatus());
  r("PUT", "/settings", (request) => {
    const next = { ...runtime.settings(), ...object(request.body) };
    if (!validSettings(next)) throw new HttpError(400, "Некорректные настройки.");
    return runtime.saveSettings(next);
  });

  // ---------------------------------------------------------- workspaces
  r("GET", "/projects", () => runtime.catalog.directories().map((directory) => ({
    id: `enki:${directory}`, worktree: directory, vcs: fs.existsSync(path.join(directory, ".git")) ? "git" : null, sandboxes: [],
  })));
  r("GET", "/paths", async (request) => {
    const directory = str(request.query, "directory");
    const home = runtime.home();
    if (!directory) return { home, directory: home, worktree: home, chats: runtime.paths.chats };
    const info = validDirectory(directory) ? await runtime.git.info(directory).catch(() => null) : null;
    return { home, directory, worktree: info?.project ?? directory, chats: runtime.paths.chats };
  });
  r("POST", "/workspaces/chat", (request) => runtime.prepareChatWorkspace(textParam(object(request.body).id, "id", 80)));
  r("POST", "/projects/trust", (request) => {
    const body = object(request.body);
    const directory = directoryParam(body.directory);
    if (typeof body.trusted !== "boolean") throw new HttpError(400, "Укажите решение.");
    trustStore(runtime.paths.agentDir).set(directory, body.trusted);
    return { directory, trusted: body.trusted };
  });
  r("GET", "/vcs", (request) => runtime.git.info(directoryParam(str(request.query, "directory"))).catch(() => null));
  r("GET", "/vcs/status", (request) => runtime.git.status(directoryParam(str(request.query, "directory"))));
  r("GET", "/vcs/diff", (request) => {
    const mode = str(request.query, "mode") === "branch" ? "branch" : "git";
    return runtime.git.diff(directoryParam(str(request.query, "directory")), mode, int(request.query, "context") ?? 3);
  });
  r("GET", "/files", (request) => listFiles(directoryParam(str(request.query, "directory")), request.query.get("path") ?? ""));
  r("GET", "/files/content", (request) => fileContent(directoryParam(str(request.query, "directory")), request.query.get("path") ?? ""));

  // ------------------------------------------------------------ sessions
  r("GET", "/sessions", async (request) => {
    const directory = directoryParam(str(request.query, "directory"), false);
    if (validDirectory(directory)) await runtime.registry.adopt(directory).catch(() => 0);
    return runtime.catalog.list(directory, int(request.query, "limit") ?? 200).map(sessionDTO);
  }, { mutation: true });
  r("GET", "/sessions/recent", (request) => {
    const page = runtime.catalog.recent({
      archived: request.query.get("archived") === "true", cursor: int(request.query, "cursor"), limit: int(request.query, "limit"),
      search: str(request.query, "search"), directory: str(request.query, "directory"),
    });
    if (page.cursor !== null) request.response.setHeader("X-Next-Cursor", String(page.cursor));
    return { sessions: page.records.map(sessionDTO), cursor: page.cursor };
  });
  r("GET", "/sessions/status", (request) => runtime.statuses(str(request.query, "directory") ?? null));
  r("POST", "/sessions", (request): SessionDTO => {
    const body = object(request.body);
    const directory = directoryParam(body.directory);
    if (body.permission !== undefined && body.permission !== null && !validRules(body.permission)) throw new HttpError(400, "Некорректные правила доступа.");
    if (body.model !== undefined && body.model !== null && !isModelRef(body.model)) throw new HttpError(400, "Некорректная модель.");
    const created = runtime.registry.create({
      directory, title: typeof body.title === "string" ? body.title : undefined,
      // Without an explicit model: the validated imported default, if any.
      permission: validRules(body.permission) ? body.permission : null, model: isModelRef(body.model) ? body.model : runtime.configDefaults().model, workshop: body.workshop === true,
    });
    return sessionDTO(created);
  });
  r("GET", "/sessions/:id", (request) => sessionDTO(scoped(request)));
  r("PATCH", "/sessions/:id", (request) => {
    const current = scoped(request);
    const body = object(request.body);
    const rules = body.permission;
    const permission: PermissionRule[] | null | undefined = rules === undefined ? undefined : rules === null ? null : validRules(rules) ? rules : undefined;
    if (body.permission !== undefined && permission === undefined) throw new HttpError(400, "Некорректные правила доступа.");
    // A streaming turn keeps its access mode until it stops. A turn PARKED on a
    // tool permission may change it in place: the exact waiting call is then
    // re-decided once below (full → runs, read → refused, still ask → stays).
    // Model/directory changes remain fenced by their own routes.
    if (permission !== undefined && runtime.dispatcher.inFlight(current.id) && !runtime.interactions.hasPendingPermission(current.id))
      throw new HttpError(409, "Остановите ответ, чтобы изменить режим доступа.");
    const time = body.time && typeof body.time === "object" ? (body.time as Record<string, unknown>) : null;
    const archived = time && "archived" in time ? (typeof time.archived === "number" && time.archived > 0 ? time.archived : null) : undefined;
    if (isReadOnlyOrigin(current.origin) && (permission !== undefined || typeof body.title === "string" || typeof body.workshop === "boolean"))
      throw new HttpError(409, "Архив доступен только для чтения.");
    const updated = runtime.catalog.update(current.id, {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(permission !== undefined ? { permission } : {}),
      ...(archived !== undefined ? { archived } : {}),
      ...(typeof body.workshop === "boolean" ? { workshop: body.workshop } : {}),
    });
    if (typeof body.title === "string") runtime.registry.live(current.id)?.rename(updated.title);
    // E.g. switched to full access while a tool waits: the CURRENT rules settle
    // that pending request exactly once (by "policy"); the user is not re-asked.
    if (permission !== undefined) runtime.interactions.reevaluatePermissions(current.id);
    return sessionDTO(updated);
  });
  r("DELETE", "/sessions/:id", async (request) => {
    const current = scoped(request);
    if (runtime.dispatcher.inFlight(current.id)) throw new HttpError(409, "Сначала остановите ответ.");
    await runtime.deleteSession(current.id);
    return undefined;
  });
  r("POST", "/sessions/:id/fork", async (request) => {
    const current = scoped(request);
    const body = object(request.body);
    if (isReadOnlyOrigin(current.origin)) throw new HttpError(409, "Архив доступен только для чтения. Сначала продолжите его.");
    const messageID = body.messageID === undefined || body.messageID === null ? null : textParam(body.messageID, "messageID", 200);
    try { return sessionDTO(await runtime.registry.fork(current.id, messageID, typeof body.title === "string" ? body.title : undefined)); }
    catch (error) { if (error instanceof ForkRefused) throw new HttpError(409, error.message); throw error; }
  });
  // Explicit user action: verified archive → new writable SDK session seeded
  // from the raw read-only reader with a bounded, model-aware budget. Repeating
  // it returns the existing continuation; nothing historical is replayed.
  r("POST", "/sessions/:id/continue", async (request) => {
    const current = scoped(request);
    if (current.origin.kind !== "opencode") throw new HttpError(409, "Продолжить можно только архивный чат OpenCode.");
    const body = object(request.body);
    if (body.model !== undefined && body.model !== null && !isModelRef(body.model)) throw new HttpError(400, "Некорректная модель.");
    try {
      return sessionDTO(await runtime.continueArchive(current, { model: isModelRef(body.model) ? body.model : null, signal: request.signal }));
    } catch (error) {
      throw new HttpError(409, error instanceof Error ? error.message : String(error));
    }
  });
  r("GET", "/sessions/:id/messages", (request) => {
    const current = scoped(request);
    // Only the requested page is converted (old attachments/tool output outside
    // it are never re-encoded); semantics equal slicing the full history.
    const page = runtime.registry.historyPage(current, int(request.query, "limit") ?? 200, str(request.query, "before"));
    if (page.before) request.response.setHeader("X-Next-Cursor", page.before);
    return { messages: page.messages, before: page.before ?? null };
  });
  r("GET", "/sessions/:id/children", (request) => {
    const current = scoped(request);
    return runtime.catalog.list(current.directory, 2000).filter((s) => s.parentId === current.id).map(sessionDTO);
  });
  r("GET", "/sessions/:id/diff", (request) => {
    const current = scoped(request);
    const touched = new Map<string, { file: string; status: string; patch?: string }>();
    for (const message of runtime.registry.history(current)) for (const part of message.parts) {
      if (part.type !== "tool" || !part.tool || !["edit", "write"].includes(part.tool)) continue;
      const input = part.state?.input && typeof part.state.input === "object" ? (part.state.input as Record<string, unknown>) : {};
      const file = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : null;
      if (!file || part.state?.status !== "completed") continue;
      const details = part.state.metadata && typeof part.state.metadata === "object" ? (part.state.metadata as Record<string, unknown>) : {};
      const patch = typeof details.patch === "string" ? details.patch : undefined;
      const previous = touched.get(file);
      touched.set(file, { file, status: part.tool === "write" && !previous ? "touched" : "modified", ...(patch ? { patch: previous?.patch ? `${previous.patch}\n${patch}` : patch } : previous?.patch ? { patch: previous.patch } : {}) });
    }
    return [...touched.values()];
  });
  r("GET", "/sessions/:id/usage", (request) => runtime.registry.live(scoped(request).id)?.usage() ?? null);
  r("POST", "/sessions/:id/stop", async (request) => {
    const current = scoped(request);
    runtime.queue.stop(current.id);
    await runtime.dispatcher.abort(current.id);
    return { stopped: true };
  });

  // --------------------------------------------------------------- queue
  r("GET", "/sessions/:id/queue", (request) => runtime.queue.state(scoped(request).id));
  r("POST", "/sessions/:id/queue", (request) => {
    const current = scoped(request);
    if (isReadOnlyOrigin(current.origin)) throw new HttpError(409, "Архив доступен только для чтения. Сначала продолжите его.");
    const body = object(request.body);
    if (!isId(body.id)) throw new HttpError(400, "Некорректный идентификатор элемента.");
    if (!isModelRef(body.model)) throw new HttpError(400, "Не указана модель.");
    const text = typeof body.text === "string" ? body.text.slice(0, 200_000) : "";
    const parts = partsParam(body.parts);
    if (!text.trim() && !parts.length) throw new HttpError(400, "Пустой запрос.");
    return runtime.queue.enqueue(current.id, current.directory, { id: body.id, text, parts, model: body.model });
  });
  // Item routes act only on an item of the scoped chat (ids are global).
  const ownedItem = (request: Request): string => {
    const current = scoped(request), item = textParam(request.params.item, "item", 128);
    const owner = runtime.queue.ownerOf(item);
    if (owner !== null && owner !== current.id) throw new HttpError(409, "Запрос очереди относится к другому чату.");
    return item;
  };
  r("PATCH", "/sessions/:id/queue/:item", (request) => {
    const item = ownedItem(request);
    const body = object(request.body);
    const removeAttachments = body.removeAttachments;
    if (removeAttachments !== undefined && (!Array.isArray(removeAttachments) || removeAttachments.length > 64 || !removeAttachments.every(isId)))
      throw new HttpError(400, "Некорректный список вложений.");
    return runtime.queue.edit(item, {
      ...(typeof body.text === "string" ? { text: body.text.slice(0, 200_000) } : {}),
      ...(body.parts !== undefined ? { parts: partsParam(body.parts) } : {}),
      ...(body.addParts !== undefined ? { addParts: partsParam(body.addParts) } : {}),
      ...(Array.isArray(removeAttachments) ? { removeAttachments } : {}),
      ...(isModelRef(body.model) ? { model: body.model } : {}),
    });
  });
  r("DELETE", "/sessions/:id/queue/:item", (request) => runtime.queue.remove(ownedItem(request)));
  r("POST", "/sessions/:id/queue/reorder", (request) => {
    const current = scoped(request);
    const body = object(request.body);
    return runtime.queue.reorder(current.id, textParam(body.id, "id", 128), typeof body.before === "string" ? body.before : null);
  });
  r("POST", "/sessions/:id/queue/resume", (request) => {
    const current = scoped(request);
    const body = object(request.body);
    return runtime.queue.resume(current.id, isModelRef(body.model) ? body.model : undefined);
  });
  r("POST", "/sessions/:id/queue/pause", (request) => { const current = scoped(request); runtime.queue.pause(current.id, null); return runtime.queue.state(current.id); });
  r("POST", "/sessions/:id/queue/:item/steer", (request) => withStatus(202, runtime.queue.steer(ownedItem(request))));
  r("POST", "/sessions/:id/queue/:item/acknowledge", (request) => {
    const item = ownedItem(request);
    const action = object(request.body).action;
    if (action !== "drop" && action !== "requeue") throw new HttpError(400, "Укажите действие.");
    return runtime.queue.acknowledge(item, action);
  });

  // ------------------------------------------------------------ commands
  r("POST", "/commands", (request) => {
    const command = validateCommand(request.body);
    if (typeof command === "string") throw new HttpError(400, command);
    const result = runtime.dispatcher.submit(command, command.kind === "prompt" || command.kind === "steer"
      ? { source: command.payload.source ?? "manual", sourceId: command.payload.sourceId ?? null } : undefined);
    return withStatus(result.status, result.receipt);
  });
  r("GET", "/commands/:id", (request) => {
    if (!isId(request.params.id)) throw new HttpError(400, "Некорректный идентификатор команды.");
    const receipt = runtime.ledger.get(request.params.id);
    if (!receipt) throw new HttpError(404, "Команда не найдена.");
    return receipt;
  });

  // --------------------------------------------------------- interaction
  r("GET", "/permissions", (request) => runtime.interactions.pendingPermissions(str(request.query, "directory")));
  r("POST", "/permissions/:id/reply", (request) => {
    const reply = object(request.body).reply;
    if (reply !== "once" && reply !== "always" && reply !== "reject") throw new HttpError(400, "Некорректный ответ.");
    if (!runtime.interactions.replyPermission(request.params.id, reply)) throw new HttpError(404, "Запрос уже закрыт.");
    return undefined;
  });
  r("GET", "/questions", (request) => runtime.interactions.pendingQuestions(str(request.query, "directory")));
  r("POST", "/questions/:id/reply", (request) => {
    let replied: boolean;
    try { replied = runtime.interactions.replyQuestion(request.params.id, object(request.body).answers, str(request.query, "directory")); }
    catch (error) { if (error instanceof InteractionInputError) throw new HttpError(400, error.message); throw error; }
    if (!replied) throw new HttpError(404, "Вопрос уже закрыт.");
    return undefined;
  });
  r("POST", "/questions/:id/reject", (request) => {
    if (!runtime.interactions.rejectQuestion(request.params.id, str(request.query, "directory"))) throw new HttpError(404, "Вопрос уже закрыт.");
    return undefined;
  });
  r("GET", "/dialogs", (request) => runtime.interactions.pendingDialogs(str(request.query, "directory")));
  r("POST", "/dialogs/:id/reply", (request) => {
    const body = object(request.body);
    if (!runtime.interactions.replyDialog(request.params.id, {
      ...(typeof body.value === "string" ? { value: body.value } : {}),
      ...(body.confirmed === true ? { confirmed: true } : {}),
      ...(body.cancelled === true ? { cancelled: true } : {}),
    })) throw new HttpError(404, "Запрос уже закрыт.");
    return undefined;
  });

  // -------------------------------------------------------------- events
  r("GET", "/snapshot", (request) => {
    const directory = str(request.query, "directory") ?? null;
    return {
      seq: runtime.journal.head, instance: runtime.instance,
      statuses: runtime.statuses(directory),
      permissions: runtime.interactions.pendingPermissions(directory),
      questions: runtime.interactions.pendingQuestions(directory),
      dialogs: runtime.interactions.pendingDialogs(directory),
      queues: runtime.queue.sessions(directory),
      schedules: runtime.scheduler.list(directory ? { directory } : {}).tasks,
      activity: runtime.activity(),
    };
  });
  r("GET", "/events", (request) => {
    const all = request.query.get("all") === "1";
    const directory = str(request.query, "directory");
    const sessionID = str(request.query, "session");
    const headerCursor = request.raw.headers["last-event-id"];
    const cursorText = str(request.query, "after") ?? (typeof headerCursor === "string" ? headerCursor : undefined);
    const filter = { ...(all ? { all: true } : {}), ...(directory ? { directory } : {}), ...(sessionID ? { sessionID } : {}) };
    // Every frame fits the client's decoder (wireEnvelope); the socket buffer
    // budget stays large enough for a bounded replay burst.
    const stream = openEventStream(request, { maxEventBytes: EVENT_FRAME_CHARACTERS, maxBufferedBytes: 64 * 1024 * 1024 + 64 * 1024 });
    const deliver = (envelope: EventEnvelope): boolean => stream.sendSerialized(envelope.seq, wireEnvelope(envelope));
    const detachRelay = relay?.attach();
    stream.send(null, { type: "stream.hello", instance: runtime.instance, head: runtime.journal.head, contract: CONTRACT_VERSION });
    const buffered: EventEnvelope[] = [];
    let replaying = true;
    const unsubscribe = runtime.journal.subscribe(filter, (envelope) => {
      if (replaying) { buffered.push(envelope); return; }
      if (!deliver(envelope)) stream.close();
    });
    let last = cursorText !== undefined ? Number(cursorText) : runtime.journal.head;
    if (!Number.isSafeInteger(last)) last = runtime.journal.head;
    if (cursorText !== undefined) {
      // Replay is paged; the rest of a long gap is fetched page by page, never
      // skipped. A gap too long to replay is an explicit reset (snapshot reload).
      const head = runtime.journal.head;
      for (let page = 0, open = true; open && last < head; page++) {
        const replay = page < REPLAY_PAGES ? runtime.journal.replay(filter, last, REPLAY_PAGE) : null;
        if (replay === null) { stream.send(null, { type: "stream.reset", reason: "cursor_expired", head: runtime.journal.head }); last = runtime.journal.head; break; }
        for (const envelope of replay) { if (!deliver(envelope)) { stream.close(); open = false; break; } last = envelope.seq; }
        if (replay.length < REPLAY_PAGE) break;
      }
    }
    replaying = false;
    for (const envelope of buffered) if (envelope.seq > last && !deliver(envelope)) { stream.close(); break; }
    stream.onClose(() => { unsubscribe(); detachRelay?.(); });
    return STREAMING;
  });
  r("POST", "/broker/:id", (request) => {
    if (!relay) throw new HttpError(404, "Нет ожидающих запросов.");
    const body = object(request.body);
    const settled = body.ok === true ? relay.pending.settle(request.params.id, { ok: true, value: body.value })
      : relay.pending.settle(request.params.id, { ok: false, error: typeof body.error === "string" ? body.error : "Ошибка Enki." });
    if (!settled) throw new HttpError(404, "Запрос уже закрыт.");
    return undefined;
  });

  // ----------------------------------------------------------- schedules
  r("GET", "/schedules", (request) => runtime.scheduler.list({ ...(str(request.query, "directory") ? { directory: str(request.query, "directory") } : {}), ...(str(request.query, "session") ? { sessionID: str(request.query, "session") } : {}) }));
  r("POST", "/schedules", (request) => {
    const body = object(request.body);
    const sessionID = textParam(body.sessionID, "sessionID", 128);
    const current = record(sessionID);
    const directory = directoryParam(body.directory);
    if (directory !== current.directory) throw new HttpError(409, "Сессия относится к другой папке.");
    if (isReadOnlyOrigin(current.origin)) throw new HttpError(409, "Архив доступен только для чтения. Создайте таймер в продолжении чата.");
    if (!isModelRef(body.model)) throw new HttpError(400, "Не указана модель.");
    const minutes = Number(body.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) throw new HttpError(400, "Интервал: от 1 минуты до 7 дней.");
    return runtime.scheduler.add({
      directory, sessionID, title: textParam(body.title, "title", 120), prompt: textParam(body.prompt, "prompt", 20000), minutes,
      mode: body.mode === "once" ? "once" : "repeat", ...(typeof body.runAt === "number" ? { runAt: body.runAt } : {}),
      ...(typeof body.requestKey === "string" ? { requestKey: body.requestKey.slice(0, 128) } : {}), model: body.model,
    });
  });
  r("PATCH", "/schedules/:id", (request) => {
    const enabled = object(request.body).enabled;
    if (typeof enabled !== "boolean") throw new HttpError(400, "Укажите enabled.");
    return runtime.scheduler.toggle(request.params.id, enabled);
  });
  r("DELETE", "/schedules/:id", (request) => { if (!runtime.scheduler.remove(request.params.id)) throw new HttpError(404, "Таймер не найден."); return undefined; });
  // Desktop schedule MCP semantics (explicit scope; never selects a chat or edits a draft).
  r("POST", "/schedules/command", (request) => {
    const p = object(request.body);
    const required = (key: string) => textParam(p[key], key, 4096).trim();
    const directory = required("directory"), sessionID = required("session_id"), action = required("action");
    const current = record(sessionID);
    if (current.directory !== directory) throw new HttpError(409, "Чат удалён, архивирован или перенесён.");
    const list = () => runtime.scheduler.list({ directory, sessionID }).tasks;
    if (action === "list") return { tasks: list(), storage: "ok" };
    if (action === "remove" || action === "pause" || action === "resume") {
      const id = required("id");
      if (!list().some((t) => t.id === id)) throw new HttpError(404, "Таймер не найден в этом чате.");
      if (action === "remove") runtime.scheduler.remove(id); else runtime.scheduler.toggle(id, action === "resume");
      return { tasks: list(), pending: null };
    }
    if (action !== "create") throw new HttpError(400, "Неизвестное действие расписания.");
    if (current.archived || isReadOnlyOrigin(current.origin)) throw new HttpError(409, "Чат архивирован или доступен только для чтения.");
    const model: ModelRef | null = p.provider_id !== undefined || p.model_id !== undefined
      ? { providerID: required("provider_id"), modelID: required("model_id") } : current.model;
    if (!model) throw new HttpError(400, "Не удалось определить модель этого чата. Укажите provider_id и model_id.");
    const mode = p.mode ?? "repeat", minutes = p.minutes ?? 15;
    if ((mode !== "once" && mode !== "repeat") || typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES)
      throw new HttpError(400, "Интервал: от 1 минуты до 7 дней.");
    const runAt = p.run_at;
    const existing = list().find((t) => t.requestKey === p.request_key);
    if (runAt !== undefined && (typeof runAt !== "number" || !Number.isFinite(runAt) || (runAt < Date.now() && existing?.runAt !== runAt) || runAt > Date.now() + MAX_MINUTES * 60_000))
      throw new HttpError(400, "Время запуска должно быть в пределах следующих 7 дней.");
    let task;
    try {
      task = runtime.scheduler.add({ directory, sessionID, title: required("title").slice(0, 120), prompt: required("prompt"), minutes, mode,
        ...(typeof runAt === "number" ? { runAt } : {}), requestKey: required("request_key").slice(0, 128), model });
    } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : String(error)); }
    return { task, notice: "Таймер сохранён в Enki Runtime этого компьютера. Работает, пока Enki запущена, в том числе в трее. Полный выход останавливает пробуждения." };
  });

  // --------------------------------------------------------------- models
  r("GET", "/providers", () => {
    const first = runtime.modelRuntime.getAvailableSnapshot()[0];
    return providers(runtime.modelRuntime, first ? { providerID: first.provider, modelID: first.id } : null);
  });
  r("POST", "/providers/refresh", async (request) => ({ errors: await refreshCatalog(runtime.modelRuntime, AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])) }));
  r("POST", "/models/check", async (request) => {
    const body = object(request.body);
    const providerID = textParam(body.providerID, "providerID", 512), modelID = textParam(body.modelID, "modelID", 512);
    let routed: boolean;
    try { routed = !!(await runtime.hub.resolve(providerID, modelID, request.signal)); }
    catch (error) { throw new HttpError(503, error instanceof Error ? error.message : String(error)); }
    if (routed) throw new HttpError(409, "Модель управляется Hub; её готовность проверяет Hub, а не прямой запрос.");
    try {
      return { ok: true, detail: await checkModelAccess(runtime.modelRuntime, { providerID, modelID, cwd: runtime.paths.agentDir, agentDir: runtime.paths.agentDir, settings: runtime.sdkSettings(), signal: request.signal }) };
    } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) }; }
  });
  r("GET", "/models/hub", () => ({ available: runtime.config.broker.available() }));
  r("POST", "/credentials/:provider", async (request) => {
    const provider = textParam(request.params.provider, "provider", 128);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(provider)) throw new HttpError(400, "Некорректный провайдер.");
    const key = object(request.body).apiKey;
    if (runtime.config.credentials !== "vault") throw new HttpError(409, "На этом компьютере ключи хранятся в настройках Pi; хранилище Enki недоступно.");
    const store = new VaultCredentialStore(runtime.config.broker, runtime.configProjection);
    if (key === null) await store.delete(provider);
    else await store.modify(provider, async () => ({ type: "api_key", key: textParam(key, "apiKey", 4096).trim() }));
    await refreshCatalog(runtime.modelRuntime, AbortSignal.timeout(15_000)).catch(() => []);
    return { provider, configured: key !== null };
  });
  // An active imported generation (ready, or blocked with its own models.json)
  // is what the SDK actually reads. It is shown read-only; writing the owner
  // file over it would shadow the import on the next start and silently drop
  // its header/key bindings, so PUT refuses until an explicit merge exists.
  const importedGeneration = () => {
    const projection = runtime.configProjection;
    return (projection.state === "ready" || projection.state === "blocked") && projection.modelsPath ? projection : null;
  };
  r("GET", "/config/models", () => {
    const file = path.join(runtime.paths.agentDir, "models.json");
    const generation = importedGeneration();
    if (generation) {
      const status = generation.status();
      return { path: file, content: fs.readFileSync(generation.modelsPath!, "utf8"), readOnly: true,
        source: "imported", state: status.state, configRevision: status.configRevision };
    }
    return { path: file, content: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", readOnly: false, source: "owner", state: runtime.configStatus().state };
  });
  r("PUT", "/config/models", (request) => {
    const body = object(request.body);
    if (importedGeneration()) throw new HttpError(409, "CONFIG_IMPORTED_READ_ONLY: активны импортированные настройки моделей. Их нельзя перезаписать здесь: это отключило бы перенесённые заголовки и ключи. Изменения не сохранены.");
    const file = path.join(runtime.paths.agentDir, "models.json");
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (typeof body.expected !== "string" || body.expected !== current) throw new HttpError(409, "Настройки моделей изменились на диске. Обновите и повторите.");
    if (typeof body.content !== "string" || body.content.length > 1024 * 1024) throw new HttpError(400, "Некорректное содержимое.");
    try { JSON.parse(body.content); } catch { throw new HttpError(400, "models.json должен быть корректным JSON."); }
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, body.content, { mode: 0o600 });
    if (current) fs.copyFileSync(file, `${file}.backup-${Date.now()}`);
    fs.renameSync(temporary, file);
    return { path: file, content: body.content };
  });
  r("GET", "/extensions", (request) => {
    const directory = str(request.query, "directory");
    const sessions = runtime.catalog.all().filter((s) => !directory || s.directory === directory).flatMap((s) => {
      const worker = runtime.registry.live(s.id);
      return worker ? [{ sessionID: s.id, errors: worker.extensionErrors, unsupported: [...worker.diagnostics.unsupported] }] : [];
    });
    return { sessions, mcp: runtime.pool.status() };
  });

  // --------------------------------------------------------------- legacy
  r("GET", "/migrations", () => ({
    archives: runtime.importer.archives(),
    journal: runtime.db.all("SELECT id,kind,state,detail,updated FROM migration_journal ORDER BY updated DESC LIMIT 50")
      .map((row) => ({ id: String(row.id), kind: String(row.kind), state: String(row.state), ...(typeof row.detail === "string" ? { detail: row.detail } : {}), updatedAt: Number(row.updated) })),
    sources: { opencode: runtime.config.legacy.opencodeDb ?? null, piCli: runtime.config.legacy.piCliRoot ?? null },
    recovery: runtime.recoveryIssues,
    piAgent: { available: runtime.config.host === "local" && runtime.config.credentials === "vault" && runtime.config.broker.kind === "supervisor", status: runtime.configStatus() },
  }));
  r("POST", "/migrations/opencode", async (request) => {
    // Only the trusted source the supervisor passed at launch; a client cannot
    // point the runtime at an arbitrary file. Origin stays the importer's
    // stable per-path identity so repeated imports are idempotent.
    const body = object(request.body);
    const source = runtime.config.legacy.opencodeDb;
    if (!source || !fs.existsSync(source)) throw new HttpError(404, "База OpenCode не найдена на этом компьютере.");
    if (body.source !== undefined && body.source !== source) throw new HttpError(400, "Можно импортировать только базу прежней версии этого компьютера.");
    return runtime.importer.import(source);
  });
  // Read-only identity lookup, not a raw-ID alias for execution. A caller can
  // name the saved ID/directory but cannot choose an origin or database path.
  r("POST", "/migrations/opencode/session", (request) => {
    const body = object(request.body), source = runtime.config.legacy.opencodeDb;
    if (Object.keys(body).some(key => key !== "legacyID" && key !== "directory"))
      throw new HttpError(400, "Укажите только исходный идентификатор и каталог чата.");
    const legacyID = textParam(body.legacyID, "legacyID", 512), directory = directoryParam(body.directory);
    if (runtime.config.host !== "local" || !source) throw new HttpError(409, "Источник истории этого компьютера пока недоступен. Прежняя привязка мастерской сохранена.");
    try { return sessionDTO(runtime.importer.resolveSession(source, legacyID, directory)); }
    catch (error) { throw new HttpError(409, error instanceof Error ? error.message : "Не удалось проверить архив мастерской."); }
  }, { mutation: false });
  // Former Pi CLI chats from this host's explicit root only. Each chat is a
  // separate journaled import (immutable original + owned working copy); a
  // failure is reported per chat with a code and never skips silently.
  r("POST", "/migrations/pi-cli", async (request) => {
    const root = runtime.config.legacy.piCliRoot;
    if (!root || !validDirectory(root)) throw new HttpError(404, "Каталог прежних чатов Pi неизвестен.");
    const sessions = object(request.body).sessions;
    if (!Array.isArray(sessions) || sessions.length > 5000) throw new HttpError(400, "Некорректный список чатов.");
    const origin = runtime.piCliOrigin(root), results: Array<Record<string, unknown>> = [];
    for (const value of sessions) {
      request.signal.throwIfAborted();
      const m = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
      const legacyId = typeof m.id === "string" ? m.id.slice(0, 512) : "";
      if (!validPiId(m.id) || typeof m.directory !== "string" || !path.isAbsolute(m.directory) || typeof m.title !== "string"
        || (m.permission !== undefined && !validRules(m.permission))) { results.push({ legacyId, code: "invalid_meta", error: "Метаданные чата не прошли проверку." }); continue; }
      const meta: PiCliMeta = { id: m.id, directory: m.directory, title: m.title.slice(0, 300),
        created: Number.isSafeInteger(m.created) && Number(m.created) >= 0 ? Number(m.created) : 0,
        updated: Number.isSafeInteger(m.updated) && Number(m.updated) >= 0 ? Number(m.updated) : 0,
        ...(Number.isSafeInteger(m.archived) && Number(m.archived) > 0 ? { archived: Number(m.archived) } : {}),
        ...(validRules(m.permission) ? { permission: m.permission } : {}) };
      // ≤0.2.115 layout: <root>/<fnv64(directory)>/<timestamp>_<id>.jsonl. Only a
      // regular file whose name ends with the exact id is a candidate; the
      // importer then validates header id/cwd against this metadata.
      const folder = path.join(root, legacyPiDigest(meta.directory));
      const names = validDirectory(folder) ? fs.readdirSync(folder, { withFileTypes: true })
        .filter((entry) => entry.isFile() && (entry.name === `${meta.id}.jsonl` || entry.name.endsWith(`_${meta.id}.jsonl`))).map((entry) => entry.name) : [];
      if (names.length !== 1) { results.push({ legacyId, code: names.length ? "ambiguous_source" : "source_missing",
        error: names.length ? "Найдено несколько файлов этого чата; импорт остановлен." : "Файл чата не найден в каталоге прежней версии." }); continue; }
      try { results.push({ legacyId, ...(await runtime.piCli.import(path.join(folder, names[0]), meta, { origin })) }); }
      catch (error) { results.push({ legacyId, code: error instanceof Error ? error.name : "ERROR", error: error instanceof Error ? error.message : String(error) }); }
    }
    return { origin, results };
  });
  // Native vault + journal commit through the frozen planner; applies on
  // restart. Only the configured userPiAgentDir is read (no body path). There
  // is no caller operation id: after a lost HTTP ACK the client must show
  // "unknown" and reconcile via GET + restart, never repeat the POST blindly.
  r("POST", "/migrations/pi-agent", async (request) => {
    try { return await runtime.importPiConfig(request.signal); }
    catch (error) {
      if (error instanceof PiConfigError) throw new HttpError(409, error.message);
      const message = error instanceof Error ? error.message : String(error);
      const code = /^(CONFIG_[A-Z_]+):/.exec(message)?.[1];
      if (code === "CONFIG_NATIVE_UNAVAILABLE" || code === "CONFIG_SOURCE_UNCONFIGURED") throw new HttpError(501, message);
      if (code === "CONFIG_MAINTENANCE") throw new HttpError(503, message);
      if (code === "CONFIG_EXISTING_MODELS_CONFLICT" || code === "CONFIG_OPERATION_CONFLICT" || code === "CONFIG_REVISION_CHANGED") throw new HttpError(409, message);
      throw error;
    }
  });
  r("GET", "/migrations/pi-agent", () => runtime.configStatus());
  r("GET", "/config/defaults", () => runtime.configDefaults());

  // Pre-2.0 UI queues/timers → this runtime, through the durable cutover journal.
  r("GET", "/migrations/cutover", (request) => runtime.cutover.list({
    ...(str(request.query, "installation") ? { installation: str(request.query, "installation") } : {}),
    ...(str(request.query, "workspace") ? { workspace: str(request.query, "workspace") } : {}),
  }));
  r("POST", "/migrations/cutover", async (request) => {
    try { return { receipts: await runtime.cutover.submit(validBatch(request.body), request.signal) }; }
    catch (error) { if (error instanceof CutoverInputError) throw new HttpError(400, error.message); throw error; }
  });
  r("POST", "/migrations/cutover/:id/retry", async (request) => {
    try { return await runtime.cutover.retry(textParam(request.params.id, "id", 128), request.signal); }
    catch (error) { if (error instanceof CutoverInputError) throw new HttpError(404, error.message); throw error; }
  });
  r("POST", "/migrations/cutover/:id/resolve", (request) => {
    try { return runtime.cutover.resolve(textParam(request.params.id, "id", 128)); }
    catch (error) { if (error instanceof CutoverInputError) throw new HttpError(409, error.message); throw error; }
  });
  // Origin-bound delivery evidence for a pre-2.0 lost-ACK send. Only positive
  // evidence is ever reported; absence from an archive (or from THIS runtime's
  // ledger) never proves that the old engine received nothing.
  r("POST", "/migrations/evidence", (request) => {
    const body = object(request.body);
    const engine = body.engine, sessionID = textParam(body.sessionID, "sessionID", 512), messageID = textParam(body.messageID, "messageID", 512);
    const directory = directoryParam(body.directory, false), text = typeof body.text === "string" ? body.text.trim() : "";
    if (engine !== "opencode" && engine !== "pi-cli") throw new HttpError(400, "Укажите исходный движок.");
    const sources = runtime.catalog.all().filter((s) => s.origin.kind === engine && "legacyId" in s.origin && s.origin.legacyId === sessionID && s.directory === directory);
    if (!sources.length) return { evidence: "archive_missing", detail: "История исходного чата не импортирована: доставку проверить нельзя. Повторная отправка не выполнялась." };
    for (const source of sources) {
      if (source.origin.kind === "opencode") {
        const raw = runtime.archiveReader(source.origin.archive).messages(sessionID);
        if (raw.some((m) => m.info.role === "user" && m.info.id === messageID))
          return { evidence: "delivered", sessionID: source.id, detail: "Это сообщение есть в архиве прежней версии: оно было доставлено. Повторять его не нужно." };
      } else if (text && runtime.registry.history(source).some((m) => m.info.role === "user" && m.parts.some((p) => p.type === "text" && p.text?.trim() === text)))
        return { evidence: "likely_delivered", sessionID: source.id, detail: "В истории чата Pi есть пользовательское сообщение с тем же текстом: вероятно, оно было доставлено." };
    }
    return { evidence: "unknown", detail: "В сохранённой истории нет этого сообщения, но прежний движок мог принять его позже снимка. Исход неизвестен; автоматического повтора не будет." };
  });

  // ------------------------------------------------------------------ pty
  r("GET", "/pty", (request) => runtime.pty.list(directoryParam(str(request.query, "directory"))));
  r("POST", "/pty", (request) => {
    const body = object(request.body);
    const size = { cols: typeof body.cols === "number" ? body.cols : 100, rows: typeof body.rows === "number" ? body.rows : 30 };
    return runtime.pty.create(directoryParam(body.directory), typeof body.title === "string" ? body.title.slice(0, 120) : "Enki", size);
  });
  // Closed shells whose cleanup is unconfirmed (closing / cleanup-unknown):
  // they keep blocking automatic maintenance until explicitly detached.
  r("GET", "/pty/closing", (request) => runtime.pty.closingList(directoryParam(str(request.query, "directory"))));
  r("POST", "/pty/:id/detach", (request) => {
    // Relinquishes ownership only: nothing is signalled, cleanup stays "unknown".
    try { return runtime.pty.detach(request.params.id, directoryParam(object(request.body).directory, false)); }
    catch (error) { throw new HttpError(404, error instanceof Error ? error.message : String(error)); }
  });
  r("GET", "/pty/:id", (request) => runtime.pty.get(request.params.id, directoryParam(str(request.query, "directory"))));
  r("PUT", "/pty/:id", (request) => {
    const body = object(request.body);
    const directory = directoryParam(body.directory);
    const size = body.size && typeof body.size === "object" ? (body.size as { rows?: unknown; cols?: unknown }) : null;
    if (size && typeof size.rows === "number" && typeof size.cols === "number") runtime.pty.resize(request.params.id, directory, size.cols, size.rows);
    if (typeof body.title === "string") runtime.pty.rename(request.params.id, directory, body.title);
    return undefined;
  });
  r("DELETE", "/pty/:id", (request) => { runtime.pty.kill(request.params.id, directoryParam(str(request.query, "directory"))); return undefined; });
  r("POST", "/pty/:id/input", (request) => {
    const body = object(request.body);
    if (typeof body.data !== "string") throw new HttpError(400, "Нет данных.");
    runtime.pty.input(request.params.id, directoryParam(body.directory), body.data);
    return undefined;
  });
  r("GET", "/pty/:id/stream", (request) => {
    const directory = directoryParam(str(request.query, "directory"));
    const after = int(request.query, "after") ?? 0;
    runtime.pty.get(request.params.id, directory);
    const stream = openEventStream(request);
    const detach = runtime.pty.attach(request.params.id, directory, after,
      (chunk) => { stream.send(null, { type: "data", cursor: chunk.cursor, reset: chunk.reset === true, data: Buffer.from(chunk.data, "utf8").toString("base64") }); },
      () => { stream.send(null, { type: "exit" }); });
    stream.onClose(detach);
    return STREAMING;
  });

  // ------------------------------------------------------------ plugin UI
  addUiRoutes(router, runtime, scoped);

  return router;
}
