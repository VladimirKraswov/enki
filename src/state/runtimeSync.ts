// Runtime-only state mirrored by the store: extension dialogs, prompt queues,
// schedules, extension notices and Hub broker relays for remote runtimes.
//
// Pure routing. The store supplies the effects, so this stays testable without
// a runtime. Nothing here answers a dialog or a permission on its own: a dialog
// leaves the list only when the runtime reports it replied or expired.
import type { DialogRequestDTO, QueueStateDTO, ScheduleDTO } from "../../src-tauri/resources/agent/src/protocol";
import type { ServerEvent } from "../api/types";
import type { RuntimeSettingsDTO, SnapshotDTO } from "../agent/runtime/client";
import type { RuntimeServerStatus } from "../capabilities/registry";
import { parseTransitionProgress, type ContextTransitionProgress } from "./modelTransition";

export interface RuntimeSyncHost {
  queue(queue: QueueStateDTO): void;
  replaceQueues(queues: QueueStateDTO[], scope: (sessionID: string) => boolean): void;
  dialog(current: DialogRequestDTO | null): void;
  schedule(sessionID: string, task: ScheduleDTO | null, id: string): void;
  notice(sessionID: string | null, text: string): void;
  broker(request: { id: string; method: string; params: Record<string, unknown> }): void;
  /** Live shared-MCP status reported by one session worker. */
  mcp?(sessionID: string, servers: RuntimeServerStatus[], error?: string): void;
  /** Progress/outcome of the runtime's single model/context transition authority. */
  contextTransition?(progress: ContextTransitionProgress): void;
  /** The runtime saved new settings (this or another window, or another client). */
  settings?(settings: RuntimeSettingsDTO): void;
}

function isRuntimeSettings(value: unknown): value is RuntimeSettingsDTO {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return ["ask", "read", "full"].includes(String(v.defaultPolicy)) && Array.isArray(v.extensionPaths)
    && typeof v.browserEnabled === "boolean" && !!v.compaction && typeof v.compaction === "object";
}

function isServerStatus(value: unknown): value is RuntimeServerStatus {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.signature === "string" && typeof v.state === "string"
    && Array.isArray(v.tools) && v.tools.every(tool => typeof tool === "string");
}

/** Blocking extension dialogs in arrival order; the first one is shown. */
export class AgentDialogs {
  private list: DialogRequestDTO[] = [];

  current(): DialogRequestDTO | null { return this.list[0] ?? null; }
  all(): readonly DialogRequestDTO[] { return this.list; }

  add(dialog: DialogRequestDTO): void {
    if (!this.list.some(d => d.id === dialog.id)) this.list.push(dialog);
  }
  remove(id: string): boolean {
    const before = this.list.length;
    this.list = this.list.filter(d => d.id !== id);
    return this.list.length !== before;
  }
  /** Authoritative list for `scope` (a directory snapshot); others are kept. */
  replace(dialogs: DialogRequestDTO[], scope: (dialog: DialogRequestDTO) => boolean): void {
    this.list = [...this.list.filter(d => !scope(d)), ...dialogs];
  }
  clear(): void { this.list = []; }
}

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/**
 * Applies a runtime-only event. Returns true when the event was consumed and
 * must not reach the chat reducer.
 */
export function routeRuntimeEvent(event: ServerEvent, host: RuntimeSyncHost, dialogs: AgentDialogs): boolean {
  const p = event.properties ?? {};
  switch (event.type) {
    case "queue.updated": {
      const queue = p.queue as QueueStateDTO | undefined;
      if (queue?.sessionID) host.queue(queue);
      return true;
    }
    case "dialog.asked": {
      const dialog = p.dialog as DialogRequestDTO | undefined;
      if (dialog?.id) { dialogs.add(dialog); host.dialog(dialogs.current()); }
      return true;
    }
    case "dialog.replied":
    case "dialog.expired": {
      const id = str(p.requestID);
      if (id && dialogs.remove(id)) host.dialog(dialogs.current());
      if (event.type === "dialog.expired" && id)
        host.notice(str(p.sessionID), "Запрос расширения истёк. Действие не выполнено.");
      return true;
    }
    case "schedule.updated": {
      const task = p.task as ScheduleDTO | undefined;
      if (task?.id) host.schedule(str(p.sessionID) ?? "", task, task.id);
      return true;
    }
    case "schedule.removed": {
      const id = str(p.id);
      if (id) host.schedule(str(p.sessionID) ?? "", null, id);
      return true;
    }
    case "extension.notify":
    case "extension.ui.error":
    case "extension.error": {
      const text = str(p.message) ?? str(p.error);
      if (text) host.notice(str(p.sessionID), text);
      return true;
    }
    case "broker.request": {
      const id = str(p.id), method = str(p.method);
      if (id && method) host.broker({ id, method, params: (p.params ?? {}) as Record<string, unknown> });
      return true;
    }
    case "mcp.status": {
      const sessionID = str(p.sessionID);
      if (sessionID && Array.isArray(p.servers)) host.mcp?.(sessionID, p.servers.filter(isServerStatus), str(p.error)?.slice(0, 500));
      return true;
    }
    case "session.context_transition": {
      const progress = parseTransitionProgress(p);
      if (progress) host.contextTransition?.(progress);
      return true;
    }
    case "runtime.settings":
      if (isRuntimeSettings(p.settings)) host.settings?.(p.settings);
      return true;
    case "runtime.draining":
    case "command.updated":
      // Observed elsewhere (quit flow, delivery journal).
      return true;
    default:
      // Plugin surface/draft projections are consumed by the session UI stream
      // (GET /sessions/:id/ui/*), which is scope- and epoch-fenced.
      return event.type.startsWith("extension.ui.") || event.type.startsWith("extension.draft");
  }
}

/**
 * Snapshot for one directory (or the whole runtime when `directory` is null).
 * `ownsSession` tells which mirrored queues the snapshot is authoritative for,
 * so a queue emptied while the stream was away does not linger.
 */
export function applySnapshot(
  snapshot: SnapshotDTO, directory: string | null, ownsSession: (sessionID: string) => boolean,
  host: RuntimeSyncHost, dialogs: AgentDialogs,
): void {
  const listed = new Set(snapshot.queues.map(q => q.sessionID));
  host.replaceQueues(snapshot.queues, id => directory === null || listed.has(id) || ownsSession(id));
  dialogs.replace(snapshot.dialogs, d => directory === null || d.directory === directory);
  host.dialog(dialogs.current());
}
