// Remote snapshot authority. This module reads Runtime state only; it never
// executes work and never rewrites the full local transcript.
import type { Runtime } from "../core/runtime.ts";
import { providers } from "../models/catalog.ts";
import { sessionDTO } from "../sessions/catalog.ts";
import type { MessageDTO } from "../protocol.ts";

function boundedMessages(messages: MessageDTO[], textLimit = 30_000): MessageDTO[] {
  return messages.map(message => ({ ...message, parts: message.parts.map(part => {
    if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string" && part.text.length > textLimit)
      return { ...part, text: "[… начало сокращено для Remote …]\n" + part.text.slice(-textLimit) };
    return part.type === "tool" && part.state
      ? { ...part, state: { ...part.state, output: typeof part.state.output === "string" ? part.state.output.slice(-12_000) : part.state.output, metadata: undefined } }
      : part;
  }) }));
}

// Hub's whole HTTP body is 2 MiB; leave room for the overview and envelope.
export const REMOTE_DETAIL_BUDGET = 1_200_000;
function remoteBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }

export function fitRemoteDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const original = Array.isArray(detail.messages) ? detail.messages as MessageDTO[] : [];
  let messages = boundedMessages(original);
  let result: Record<string, unknown> = { ...detail, messages };
  if (remoteBytes(result) <= REMOTE_DETAIL_BUDGET) return result;
  messages = boundedMessages(original, 4_000);
  result = { ...detail, messages };
  while (messages.length > 1 && remoteBytes(result) > REMOTE_DETAIL_BUDGET) {
    messages = messages.slice(Math.max(1, Math.ceil(messages.length / 2)));
    result = { ...detail, messages };
  }
  if (remoteBytes(result) > REMOTE_DETAIL_BUDGET)
    return { ...detail, messages: [], historyError: "История слишком велика для Remote. Актуальные статус и очередь показаны; полная история доступна на компьютере." };
  return { ...result, historyError: "Показан сокращённый конец истории. Полная история сохранена на компьютере." };
}

export function remoteOverview(runtime: Runtime, updates: unknown): Record<string, unknown> {
  const sessions = runtime.catalog.recent({ archived: false, limit: 200 }).records.map(sessionDTO);
  return {
    version: runtime.config.version, instance: runtime.instance, startedAt: runtime.startedAt,
    host: runtime.config.host, hostId: runtime.hostId, platform: process.platform,
    sessions, statuses: runtime.statuses(null),
    providers: providers(runtime.modelRuntime, null, runtime.modelAccess?.snapshot()),
    settings: runtime.settings(), projects: runtime.catalog.directories(),
    questions: runtime.interactions.pendingQuestions(), permissions: runtime.interactions.pendingPermissions(),
    activity: runtime.activity(), queues: runtime.queue.sessions(null), updates,
  };
}

export function remoteDetail(runtime: Runtime, sessionID: string): Record<string, unknown> {
  const record = runtime.catalog.get(sessionID);
  if (!record) return { session: sessionID, missing: true, messages: [] };
  // This live envelope is deliberately independent of history availability.
  const live = {
    session: sessionID, info: sessionDTO(record),
    queue: runtime.queue.state(sessionID), status: runtime.statuses(record.directory)[sessionID] ?? { type: "idle" },
    questions: runtime.interactions.pendingQuestions(record.directory).filter(q => q.sessionID === sessionID),
    permissions: runtime.interactions.pendingPermissions(record.directory).filter(p => p.sessionID === sessionID),
  };
  try {
    const stamp = record.updated ?? 0;
    const cached = historyCache.get(runtime);
    let messages: MessageDTO[];
    if (cached?.session === sessionID && cached.stamp === stamp) messages = cached.messages;
    else {
      messages = runtime.registry.historyPage(record, 100).messages;
      historyCache.set(runtime, { session: sessionID, stamp, messages });
    }
    return fitRemoteDetail({ ...live, messages });
  } catch {
    return { ...live, messages: [], historyError: "Не удалось прочитать историю для Remote. Актуальные статус и очередь показаны; откройте историю на компьютере." };
  }
}

const historyCache = new WeakMap<Runtime, { session: string; stamp: number; messages: MessageDTO[] }>();
