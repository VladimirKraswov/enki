import {scheduleCommand} from "../schedules/control";
// Native agent-control bridge.
//
// Commands arrive through the private native socket/MCP adapter, but are
// executed against the same Store instance as the visible UI.  This prevents a
// second automation state machine from drifting away from what the user sees.

import type { PermissionRequest, QuestionRequest } from "../api/types";
import type { EngineId } from "../state/engines";
import { RUNTIME_AGENT_ID } from "../agent/runtime/ids";
import { store } from "../state/store";
import { applyHistory, emptyChatRoot, type SessionChatState } from "../state/chatReducer";
import { isNative } from "../native/platform";
import { installAgentControlMcp } from "./install";
import {
  getManagedRun,
  listManagedRuns,
  managedRunSummary,
  putManagedRun,
  removeManagedRun,
  type ManagedRun,
} from "./managedRuns";

interface ControlCommand {
  id: string;
  method: string;
  params?: unknown;
}

type Params = Record<string, unknown>;

const MAX_MALFORMED_TOOL_RECOVERIES = 2;
const TOOL_RECOVERY_PROMPT =
  "Системное восстановление: предыдущий ответ завершился без выполнения, потому что вызов инструмента был выведен как обычный текст. Повтори тот же шаг сейчас через настоящий встроенный инструмент агента с корректными структурированными аргументами, затем продолжи исходную задачу. Не описывай XML-теги и не завершай работу до проверки результата.";

const COMPLETION_MARKER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_CHECKPOINT_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/ -]{1,240}$/;
const inFlightWaits = new Map<
  string,
  { promise: Promise<unknown>; controller: AbortController }
>();

function object(value: unknown): Params {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("parameters must be an object");
  return value as Params;
}

function text(params: Params, name: string, required = true): string | undefined {
  const value = params[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim()))
    throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function integer(
  params: Params,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = params[name] ?? fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value as number;
}

function boolean(params: Params, name: string, fallback: boolean): boolean {
  const value = params[name] ?? fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

/**
 * The bundled runtime (tag "pi") executes every chat. A request naming the
 * retired OpenCode engine is refused before anything is selected or sent, so
 * an automation caller is never silently served by a different engine.
 */
function engine(params: Params, required = false): EngineId | undefined {
  const id = text(params, "engine", required);
  if (id === undefined) return undefined;
  if (id === "opencode")
    throw new Error("engine opencode is retired: every chat runs in the bundled Enki runtime (engine \"pi\" or omit it). Nothing was sent.");
  if (id !== RUNTIME_AGENT_ID) throw new Error(`engine must be "${RUNTIME_AGENT_ID}" or omitted`);
  return id;
}

function activeStatus(sessionId: string | null = store.state.activeSessionId) {
  if (!sessionId) return { type: "idle" };
  return (
    store.state.activityStatuses[sessionId] ??
    store.state.statuses[sessionId] ??
    store.state.chat.sessions[sessionId]?.status ??
    { type: "idle" }
  );
}

function sessionSummary(session: (typeof store.state.sessions)[number]) {
  return {
    id: session.id,
    title: session.title,
    directory: session.directory,
    engine: store.engineIdFor(session.id, session.directory),
    status: activeStatus(session.id),
    updated: session.time.updated,
    archived: session.time.archived ?? null,
    agent: session.agent ?? null,
    model: session.model ?? null,
  };
}

function pending(sessionId: string) {
  const interactions = store.pendingInteraction(sessionId);
  return {
    permissions: interactions.permissions,
    questions: interactions.questions,
  };
}

function status() {
  const id = store.state.activeSessionId;
  const model = store.getModelChoice();
  const interactions = id ? pending(id) : { permissions: [], questions: [] };
  const serverKey = store.state.prefs.workspaceKey ?? store.state.prefs.endpoint;
  return {
    connection: store.state.connection,
    directory: store.state.directory,
    sessionId: id,
    engine: store.engineIdFor(),
    model,
    agent: store.getAgentChoice(),
    status: activeStatus(id),
    sending: store.state.ui.sending,
    error: store.state.ui.sendError ?? store.state.ui.historyError,
    pending: {
      permissions: interactions.permissions.length,
      questions: interactions.questions.length,
    },
    managedRun: id ? managedRunSummary(getManagedRun(serverKey, id)) : null,
    view: {
      settingsOpen: store.state.ui.settingsOpen,
      sidebarOpen: store.state.prefs.layout.sidebarOpen,
      reviewOpen: store.state.prefs.layout.rightOpen,
      terminalOpen: store.state.prefs.layout.bottomOpen,
    },
  };
}

async function selectDirectory(directory: string): Promise<void> {
  if (store.state.directory === directory) return;
  const known = store.state.projects.some((project) => project.worktree === directory);
  if (known) await store.setDirectory(directory);
  else await store.addProjectDirectory(directory);
  if (store.state.directory !== directory)
    throw new Error(`Enki did not select ${directory}`);
}

async function selectSession(directory: string, sessionId?: string): Promise<void> {
  await selectDirectory(directory);
  if (sessionId) {
    if (!store.state.sessions.some((session) => session.id === sessionId))
      await store.refreshSessions();
    if (!store.state.sessions.some((session) => session.id === sessionId))
      throw new Error(`session ${sessionId} is not available in ${directory}`);
    await store.selectSession(sessionId);
  }
}

function configure(params: Params): void {
  const providerID = text(params, "provider_id", false);
  const modelID = text(params, "model_id", false);
  if (Boolean(providerID) !== Boolean(modelID))
    throw new Error("provider_id and model_id must be supplied together");
  if (providerID && modelID) {
    const variant = params.variant;
    if (variant !== undefined && variant !== null && typeof variant !== "string")
      throw new Error("variant must be a string or null");
    store.setModelChoice(providerID, modelID, (variant as string | null | undefined) ?? null);
    const selected = store.getModelChoice();
    if (selected?.providerID !== providerID || selected.modelID !== modelID)
      throw new Error("Requested model is not selectable; verify model access and service policy in settings. No prompt was sent.");
  }
  const agent = text(params, "agent", false);
  if (agent) store.setAgentOverride(store.state.directory ?? "*", agent);
}

async function send(params: Params) {
  const directory = text(params, "directory")!;
  const sessionId = text(params, "session_id", false);
  engine(params); // only the runtime tag (or none) is accepted, before any selection
  await selectSession(directory, sessionId);
  if (!sessionId) await store.selectSession(null);
  configure(params);
  const completionMarker = text(params, "completion_marker", false) ?? null;
  if (completionMarker && !COMPLETION_MARKER.test(completionMarker))
    throw new Error(
      "completion_marker must be 1-128 ASCII letters, digits, dot, colon, underscore or dash",
    );
  const maxContinuations = integer(
    params,
    "max_continuations",
    completionMarker ? 6 : 0,
    0,
    20,
  );
  if (!completionMarker && maxContinuations)
    throw new Error("max_continuations requires completion_marker");
  const checkpointPath = text(params, "checkpoint_path", false) ?? null;
  if (checkpointPath && !SAFE_CHECKPOINT_PATH.test(checkpointPath))
    throw new Error("checkpoint_path must be a safe project-relative path without '..'");
  const currentOrder = store.state.activeSessionId
    ? (store.state.chat.sessions[store.state.activeSessionId]?.messageOrder ?? [])
    : [];
  const boundaryMessageId = currentOrder.length ? currentOrder[currentOrder.length - 1] : null;
  const originalPrompt = text(params, "text")!;
  const managedPrompt = completionMarker
    ? `${originalPrompt}\n\n---\nКонтракт управляемой длительной задачи:\n- Продолжай работу через инструменты и фактические проверки, а не только планирование.\n- После каждого значимого этапа сохраняй компактный checkpoint: цель, ограничения, проверенные факты, изменённые файлы, результаты тестов и точный следующий шаг.${checkpointPath ? ` Используй файл ${checkpointPath}.` : " Используй checkpoint, предусмотренный инструкциями проекта, если он есть."}\n- После сжатия контекста сначала перечитай checkpoint и проверь текущее состояние репозитория.\n- При необходимости решения человека задай штатный вопрос; не угадывай разрешения или требования.\n- Только когда все критерии исходной задачи действительно выполнены и проверены, выведи отдельной строкой точный маркер ${completionMarker}. Не упоминай и не выводи этот маркер раньше.`
    : originalPrompt;
  const accepted = await store.sendPrompt(managedPrompt);
  const acceptedSession = store.state.activeSessionId;
  if (!accepted || !acceptedSession) {
    throw new Error(store.state.ui.sendError ?? "the prompt was not accepted");
  }
  const now = Date.now();
  putManagedRun({
    version: 1,
    serverKey: store.state.prefs.workspaceKey ?? store.state.prefs.endpoint,
    sessionId: acceptedSession,
    directory,
    boundaryMessageId,
    turnBoundaryMessageId: boundaryMessageId,
    recoveredMessageIds: [],
    malformedAttempts: 0,
    continuationAttempts: 0,
    maxContinuations,
    completionMarker,
    checkpointPath,
    createdAt: now,
    updatedAt: now,
  });
  return {
    accepted: true,
    sessionId: acceptedSession,
    directory,
    engine: store.engineIdFor(acceptedSession, directory),
    status: activeStatus(acceptedSession),
  };
}

function waitForStateChange(
  sessionId: string,
  deadline: number,
  signal: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    let unsubscribe = () => {};
    const finish = (result: unknown) => {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", inspect);
      resolve(result);
    };
    const inspect = () => {
      const interaction = pending(sessionId);
      const runStatus = activeStatus(sessionId);
      const running =
        runStatus.type === "busy" ||
        runStatus.type === "retry" ||
        (store.state.activeSessionId === sessionId && store.state.ui.sending);
      if (signal.aborted) {
        finish({ outcome: "stopped", status: runStatus });
      } else if (interaction.permissions.length || interaction.questions.length) {
        finish({ outcome: "needs_input", status: runStatus, ...interaction });
      } else if (store.state.chat.sessions[sessionId]?.lastError) {
        finish({
          outcome: "failed",
          status: runStatus,
          error: store.state.chat.sessions[sessionId].lastError,
        });
      } else if (!running && store.state.chat.sessions[sessionId]?.lastOutcome?.state === "failed") {
        // Idle is delivery, not success: e.g. an unrecovered output-limit stop.
        const outcome = store.state.chat.sessions[sessionId].lastOutcome!;
        finish({ outcome: "failed", status: runStatus, error: outcome.error, reason: outcome.reason });
      } else if (!running) {
        finish({ outcome: "idle", status: runStatus });
      } else if (Date.now() >= deadline) {
        finish({ outcome: "timeout", status: runStatus });
      }
    };
    unsubscribe = store.subscribe(inspect);
    signal.addEventListener("abort", inspect, { once: true });
    timer = setTimeout(inspect, Math.max(0, deadline - Date.now()));
    inspect();
  });
}

function isFinalAssistant(message: { role: string; finish?: string | null }): boolean {
  return message.role === "assistant" && Boolean(message.finish && message.finish !== "tool-calls");
}

function finalAssistantSince(sessionId: string, boundaryMessageId: string | null, chat = store.state.chat.sessions[sessionId]): boolean {
  if (!chat) return false;
  for (const messageId of [...chat.messageOrder].reverse()) {
    if (messageId === boundaryMessageId) break;
    const message = chat.messages[messageId];
    if (!message || message.role !== "assistant") continue;
    return isFinalAssistant(message);
  }
  return false;
}

function malformedToolCallMessage(
  message: { id: string; role: string; finish?: string | null },
  parts: Array<{ type: string; text?: string }>,
): boolean {
  if (message.role !== "assistant" || message.finish !== "stop") return false;
  if (parts.some((part) => part.type === "tool")) return false;
  const output = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  return (
    output.includes("<tool_call>") &&
    output.includes("<function=") &&
    (output.includes("<parameter=") || output.includes("</parameter>"))
  );
}

function recoverableMalformedToolMessage(sessionId: string, run: ManagedRun, chat = store.state.chat.sessions[sessionId]) {
  if (!chat) return null;
  for (const messageId of [...chat.messageOrder].reverse()) {
    if (messageId === run.boundaryMessageId) break;
    if (run.recoveredMessageIds.includes(messageId)) continue;
    const message = chat.messages[messageId];
    if (!message || message.role !== "assistant") continue;
    const parts = (chat.partsByMessage[messageId] ?? [])
      .map((partId) => chat.parts[partId])
      .filter((part): part is NonNullable<typeof part> => Boolean(part));
    return malformedToolCallMessage(message, parts) ? message : null;
  }
  return null;
}

function containsCompletionMarker(text: string, marker: string): boolean {
  return text.split(/\r?\n/).some((line) => line.trim() === marker);
}

function completionMarkerSeen(sessionId: string, run: ManagedRun, chat = store.state.chat.sessions[sessionId]): boolean {
  if (!run.completionMarker) return true;
  if (!chat) return false;
  for (const messageId of [...chat.messageOrder].reverse()) {
    if (messageId === run.boundaryMessageId) break;
    const message = chat.messages[messageId];
    if (!message || message.role !== "assistant") continue;
    for (const partId of chat.partsByMessage[messageId] ?? []) {
      const part = chat.parts[partId];
      if (part?.type === "text" && containsCompletionMarker(part.text ?? "", run.completionMarker))
        return true;
    }
  }
  return false;
}

function continuationPrompt(run: ManagedRun): string {
  return `Управляемая длительная задача ещё не завершена: обязательный маркер ${run.completionMarker} отсутствует. Перечитай исходную задачу${run.checkpointPath ? ` и checkpoint ${run.checkpointPath}` : " и текущий checkpoint"}, проверь уже выполненное инструментами и продолжай с первого незакрытого шага. Не объявляй готовность и не выводи маркер, пока все критерии приёмки действительно не выполнены. Если необходимо решение человека, задай штатный вопрос.`;
}

type ManagedIdleDecision =
  | { kind: "retry_malformed"; messageId: string }
  | { kind: "recovery_exhausted"; messageId: string }
  | { kind: "completed" }
  | { kind: "continue" }
  | { kind: "incomplete" };

function decideManagedIdle(
  run: ManagedRun,
  malformedMessageId: string | null,
  markerSeen: boolean,
): ManagedIdleDecision {
  if (malformedMessageId) {
    return run.malformedAttempts >= MAX_MALFORMED_TOOL_RECOVERIES
      ? { kind: "recovery_exhausted", messageId: malformedMessageId }
      : { kind: "retry_malformed", messageId: malformedMessageId };
  }
  if (markerSeen) return { kind: "completed" };
  return run.continuationAttempts >= run.maxContinuations
    ? { kind: "incomplete" }
    : { kind: "continue" };
}

async function waitUntilSettled(
  sessionId: string,
  timeoutSeconds: number,
  signal: AbortSignal,
): Promise<unknown> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const pause = () => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, Math.max(0, Math.min(1000, deadline - Date.now())));
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
  for (;;) {
    if (signal.aborted) return { outcome: "stopped", status: activeStatus(sessionId) };
    const result = (await waitForStateChange(sessionId, deadline, signal)) as {
      outcome: string;
      status: unknown;
      [key: string]: unknown;
    };
    if (result.outcome !== "idle") return { ...result, timeoutSeconds };

    const serverKey = store.state.prefs.workspaceKey ?? store.state.prefs.endpoint;
    let run = getManagedRun(serverKey, sessionId);
    if (!run) return result;
    // A persisted run may be resumed while another chat is visible. Load its
    // authoritative history before deciding that a marker is absent; otherwise
    // an empty in-memory slot could cause a false continuation after restart.
    const { chat, session, backend, interactions } = await readChat(run.directory, sessionId, signal);
    if (signal.aborted) return { outcome: "stopped", status: activeStatus(sessionId) };
    run = getManagedRun(serverKey, sessionId);
    if (!run) return result;
    const refreshedInteraction = interactions;
    const refreshedStatus = chat.status;
    if (refreshedInteraction.permissions.length || refreshedInteraction.questions.length) {
      return {
        outcome: "needs_input",
        status: refreshedStatus,
        ...refreshedInteraction,
      };
    }
    if (chat.lastError) {
      return {
        outcome: "failed",
        status: refreshedStatus,
        error: chat.lastError,
      };
    }
    if (refreshedStatus.type === "busy" || refreshedStatus.type === "retry") {
      if (Date.now() >= deadline)
        return { outcome: "timeout", status: refreshedStatus, timeoutSeconds };
      await pause();
      continue;
    }
    if (!finalAssistantSince(sessionId, run.turnBoundaryMessageId, chat)) {
      // Background chats need no visible subscription. Read their durable page
      // again after a bounded wait, without stealing the user's selection.
      await pause();
      if (signal.aborted) return { outcome: "stopped", status: activeStatus(sessionId) };
      if (Date.now() >= deadline)
        return { outcome: "timeout", status: activeStatus(sessionId), timeoutSeconds };
      continue;
    }
    const malformed = recoverableMalformedToolMessage(sessionId, run, chat);
    const decision = decideManagedIdle(
      run,
      malformed?.id ?? null,
      completionMarkerSeen(sessionId, run, chat),
    );
    let prompt: string | null = null;
    let recoveryKind: "malformed_tool" | "incomplete" | null = null;
    if (decision.kind === "retry_malformed" || decision.kind === "recovery_exhausted") {
      if (decision.kind === "recovery_exhausted") {
        removeManagedRun(serverKey, sessionId);
        return {
          outcome: "recovery_exhausted",
          status: result.status,
          attempts: run.malformedAttempts,
          messageId: decision.messageId,
        };
      }
      run = putManagedRun({
        ...run,
        recoveredMessageIds: [...run.recoveredMessageIds, decision.messageId],
        malformedAttempts: run.malformedAttempts + 1,
      });
      prompt = TOOL_RECOVERY_PROMPT;
      recoveryKind = "malformed_tool";
    } else if (decision.kind === "completed") {
      removeManagedRun(serverKey, sessionId);
      return run.completionMarker
        ? { outcome: "completed", status: result.status, completionMarker: run.completionMarker }
        : result;
    } else if (decision.kind === "incomplete") {
      removeManagedRun(serverKey, sessionId);
      return {
        outcome: "incomplete",
        status: result.status,
        reason: "completion_marker_missing",
        completionMarker: run.completionMarker,
        attempts: run.continuationAttempts,
      };
    } else {
      run = putManagedRun({
        ...run,
        continuationAttempts: run.continuationAttempts + 1,
      });
      prompt = continuationPrompt(run);
      recoveryKind = "incomplete";
    }

    // Target the original runtime chat, never the currently visible composer,
    // model or draft. The runtime's idempotent ledger owns this command.
    const order = chat.messageOrder;
    run = putManagedRun({
      ...run,
      turnBoundaryMessageId: order.length ? order[order.length - 1] : run.turnBoundaryMessageId,
    });
    try {
      if (signal.aborted || backend !== store.backend || serverKey !== (store.state.prefs.workspaceKey ?? store.state.prefs.endpoint))
        return { outcome: "stopped", status: activeStatus(sessionId) };
      if (!session.model) throw new Error("В исходном чате не выбрана модель. Продолжение не отправлено.");
      await backend.prompt(sessionId, run.directory, {
        messageID: `managed-${crypto.randomUUID()}`,
        model: { providerID: session.model.providerID, modelID: session.model.id },
        variant: session.model.variant ?? undefined,
        parts: [{ type: "text", text: prompt }],
      }, signal);
    } catch (error) {
      removeManagedRun(serverKey, sessionId);
      return {
        outcome: "recovery_failed",
        status: activeStatus(sessionId),
        recoveryKind,
        error: error instanceof Error ? error.message : "the Enki runtime did not accept the recovery prompt",
      };
    }
    if (Date.now() >= deadline) {
      return {
        outcome: "timeout",
        status: activeStatus(sessionId),
        timeoutSeconds,
        recoveryAttempted: true,
        recoveryKind,
      };
    }
  }
}

function waitForSession(sessionId: string, timeoutSeconds: number): Promise<unknown> {
  const existing = inFlightWaits.get(sessionId);
  if (existing) return existing.promise;
  const controller = new AbortController();
  const pending = waitUntilSettled(sessionId, timeoutSeconds, controller.signal).finally(() => {
    if (inFlightWaits.get(sessionId)?.promise === pending) inFlightWaits.delete(sessionId);
  });
  inFlightWaits.set(sessionId, { promise: pending, controller });
  return pending;
}

/** Read-only projection, isolated from visible selection, draft and history cache. */
async function readChat(directory: string, sessionId: string, signal?: AbortSignal) {
  const backend = store.backend;
  const [session, page, snapshot] = await Promise.all([
    backend.getSession(sessionId, directory, signal),
    backend.messages(sessionId, { directory, limit: 200, signal }),
    backend.client.snapshot(directory, signal),
  ]);
  if (backend !== store.backend || signal?.aborted) throw new Error("Подключение изменилось; чтение отменено.");
  const root = emptyChatRoot();
  applyHistory(root, sessionId, page.messages);
  const chat = root.sessions[sessionId];
  chat.status = snapshot.statuses[sessionId] ?? { type: "idle" };
  return { session, chat, backend, interactions: {
    permissions: snapshot.permissions.filter(p => p.sessionID === sessionId),
    questions: (snapshot.questions ?? []).filter(q => q.sessionID === sessionId),
  } };
}

function conversation(sessionId: string, limit: number, maxChars: number, chat: SessionChatState | undefined = store.state.chat.sessions[sessionId]) {
  if (!chat) return { sessionId, status: activeStatus(sessionId), messages: [] };
  const selected = chat.messageOrder.slice(-limit);
  const messages: unknown[] = [];
  let chars = 0;
  // Prefer the newest turns when the caller's byte budget cannot hold all of
  // them. Tool payloads can contain megabytes, so project only useful fields.
  for (const id of [...selected].reverse()) {
    const info = chat.messages[id];
    const item = {
      info: info
        ? {
            id: info.id,
            role: info.role,
            time: info.time,
            error: info.error,
            ...("agent" in info ? { agent: info.agent } : {}),
            ...(info.role === "assistant"
              ? { modelID: info.modelID, providerID: info.providerID, finish: info.finish }
              : { model: info.model }),
          }
        : null,
      parts: (chat.partsByMessage[id] ?? []).map((partId) => {
        const part = chat.parts[partId];
        const state = part.state
          ? {
              status: part.state.status,
              title: part.state.title,
              output:
                typeof part.state.output === "string"
                  ? part.state.output.slice(0, 20_000)
                  : part.state.output,
              error: part.state.error,
            }
          : undefined;
        return {
          id: part.id,
          type: part.type,
          text: part.text?.slice(0, 40_000),
          tool: part.tool,
          state,
        };
      }),
    };
    const size = JSON.stringify(item).length;
    if (chars + size > maxChars) {
      if (!messages.length) {
        messages.push({
          info: item.info,
          parts: [{ type: "truncated", text: JSON.stringify(item).slice(0, maxChars) }],
        });
      }
      break;
    }
    messages.unshift(item);
    chars += size;
  }
  return {
    sessionId,
    status: chat.status,
    lastError: chat.lastError,
    truncated: selected.length > messages.length,
    messages,
  };
}

async function execute(method: string, raw: unknown): Promise<unknown> {
  const params = object(raw ?? {});
  switch (method) {
    case "schedule": return scheduleCommand(params);
    case "status":
      return status();
    case "projects":
      if (boolean(params, "refresh", true)) await store.refreshProjects();
      return store.state.projects.map((project) => ({
        id: project.id,
        directory: project.worktree,
        vcs: project.vcs,
        selected: project.worktree === store.state.directory,
      }));
    case "select": {
      const directory = text(params, "directory")!;
      const sessionId = text(params, "session_id", false);
      await selectSession(directory, sessionId);
      return status();
    }
    case "sessions": {
      const directory = text(params, "directory")!;
      return (await store.backend.listSessions(directory)).map(sessionSummary);
    }
    case "new_chat": {
      const directory = text(params, "directory")!;
      engine(params); // refuse a retired engine before changing the visible selection
      await selectDirectory(directory);
      await store.selectSession(null);
      return status();
    }
    case "configure":
      configure(params);
      return status();
    case "send":
      return send(params);
    case "wait":
      return waitForSession(
        text(params, "session_id")!,
        integer(params, "timeout_seconds", 120, 1, 300),
      );
    case "conversation": {
      const directory = text(params, "directory")!;
      const sessionId = text(params, "session_id")!;
      const { chat } = await readChat(directory, sessionId);
      return conversation(
        sessionId,
        integer(params, "limit", 40, 1, 200),
        integer(params, "max_chars", 120_000, 1_000, 500_000), chat,
      );
    }
    case "stop": {
      const sessionId = text(params, "session_id")!;
      removeManagedRun(store.state.prefs.workspaceKey ?? store.state.prefs.endpoint, sessionId);
      inFlightWaits.get(sessionId)?.controller.abort();
      await store.stopSession(sessionId);
      return { stopped: true, sessionId, status: activeStatus(sessionId) };
    }
    case "interactions":
      return pending(text(params, "session_id")!);
    case "managed_runs": {
      const serverKey = store.state.prefs.workspaceKey ?? store.state.prefs.endpoint;
      return listManagedRuns(serverKey).map((run) => ({
        sessionId: run.sessionId,
        directory: run.directory,
        ...managedRunSummary(run),
      }));
    }
    case "forget_managed_run": {
      const sessionId = text(params, "session_id")!;
      removeManagedRun(store.state.prefs.workspaceKey ?? store.state.prefs.endpoint, sessionId);
      return { forgotten: true, sessionId };
    }
    case "reply_permission": {
      const requestId = text(params, "request_id")!;
      const reply = text(params, "reply")!;
      if (reply !== "once" && reply !== "always" && reply !== "reject")
        throw new Error("reply must be once, always or reject");
      const request = store.state.chat.permissions[requestId] as PermissionRequest | undefined;
      if (!request) throw new Error(`permission request ${requestId} is not pending`);
      if (request.sessionID !== store.state.activeSessionId)
        throw new Error("open the permission request's session before replying");
      if (!await store.replyPermission(request, reply)) throw new Error("Ответ на разрешение не подтверждён. Запрос мог уже завершиться; проверьте его статус.");
      return { replied: true, requestId, reply };
    }
    case "answer_question": {
      const requestId = text(params, "request_id")!;
      const request = store.state.chat.questions[requestId] as QuestionRequest | undefined;
      if (!request) throw new Error(`question ${requestId} is not pending`);
      if (request.sessionID !== store.state.activeSessionId)
        throw new Error("open the question's session before replying");
      if (boolean(params, "reject", false)) {
        await store.rejectQuestion(request);
        return { rejected: true, requestId };
      }
      const answers = params.answers;
      if (
        !Array.isArray(answers) ||
        !answers.every(
          (answer) => Array.isArray(answer) && answer.every((item) => typeof item === "string"),
        )
      )
        throw new Error("answers must be an array of string arrays");
      await store.replyQuestion(request, answers as string[][]);
      return { answered: true, requestId };
    }
    case "set_view": {
      if (params.settings_open !== undefined)
        store.setUi({ settingsOpen: boolean(params, "settings_open", false) });
      const layout: Partial<typeof store.state.prefs.layout> = {};
      if (params.sidebar_open !== undefined)
        layout.sidebarOpen = boolean(params, "sidebar_open", false);
      if (params.review_open !== undefined)
        layout.rightOpen = boolean(params, "review_open", false);
      if (params.terminal_open !== undefined) {
        const open = boolean(params, "terminal_open", false);
        if (open !== store.state.prefs.layout.bottomOpen) await store.toggleTerminal();
      }
      if (Object.keys(layout).length) store.setLayout(layout);
      return status();
    }
    case "install_mcp":
      return {
        enabled: boolean(params, "enabled", true),
        notice: await installAgentControlMcp(boolean(params, "enabled", true)),
      };
    default:
      throw new Error(`unknown desktop control method: ${method}`);
  }
}

let stopBridge: (() => void) | null = null;

export async function startAgentControl(): Promise<() => void> {
  if (!isNative() || stopBridge) return stopBridge ?? (() => {});
  const [{ listen }, { invoke }] = await Promise.all([
    import("@tauri-apps/api/event"),
    import("@tauri-apps/api/core"),
  ]);
  const unlisten = await listen<ControlCommand>("agent-control://command", (event) => {
    const command = event.payload;
    void execute(command.method, command.params ?? {})
      .then((result) =>
        invoke("agent_control_complete", {
          completion: { id: command.id, result, error: null },
        }),
      )
      .catch((error) =>
        invoke("agent_control_complete", {
          completion: {
            id: command.id,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          },
        }),
      );
  });
  await invoke("agent_control_ready", { ready: true });
  stopBridge = () => {
    void invoke("agent_control_ready", { ready: false });
    unlisten();
    stopBridge = null;
  };
  return stopBridge;
}

export const agentControlForTest = {
  execute,
  malformedToolCallMessage,
  decideManagedIdle,
  containsCompletionMarker,
  isFinalAssistant,
};
