// Client mirror of the runtime-owned scheduler.
//
// Wake-ups are stored and fired by the Enki Runtime, so they keep working
// while the window is hidden, reloading or closed to the tray; a full quit
// stops them, and a missed interval is never replayed in a burst. This module
// keeps a reactive copy (snapshot + `schedule.*` events) and forwards edits.
import type { ScheduleDTO } from "../../src-tauri/resources/agent/src/protocol";
import type { RuntimeBackend } from "../agent/runtime/backend";
import type { CutoverReceiptDTO } from "../agent/runtime/client";
import { RUNTIME_AGENT_ID } from "../agent/runtime/ids";
import { acknowledged, timerCutoverItems } from "../state/cutover";

export interface ScheduledTask {
  id: string; server: string; directory: string; sessionID: string; engine: string;
  title: string; prompt: string; minutes: number;
  mode?: "once" | "repeat"; runAt?: number; requestKey?: string;
  model: { providerID: string; modelID: string; variant?: string | null }; agent?: string;
  enabled: boolean; nextAt: number; lastAt?: number;
  state: "ready" | "waiting" | "dispatching" | "sent" | "error"; detail?: string;
  /** Refused (provably unsent) attempts of the current occurrence so far; absent for the first. */
  attempt?: number;
}
export type NewScheduledTask = Omit<ScheduledTask, "id" | "enabled" | "nextAt" | "state" | "lastAt" | "detail" | "attempt">;

export interface SchedulerStatus {
  /** "unavailable": the runtime cannot be reached; nothing is lost, edits wait. */
  storage: "ok" | "unavailable";
  skipped: number;
  pending: Readonly<Record<string, "pause" | "remove">>;
  flight: string | null;
}

export const TASK_LIMIT = 50;
export const MAX_MINUTES = 10080;
export const STORAGE_FAILED = "Среда выполнения Enki недоступна. Таймеры сохранены в ней и продолжат работу после подключения.";

// Old window-scheduler records. An earlier blanket `.migrated` marker is
// ignored on purpose: it could hide timers another workspace never imported.
const LEGACY_KEY = "ocdesktop.scheduled-prompts.v1";

function taskOf(dto: ScheduleDTO, server: string): ScheduledTask {
  return {
    id: dto.id, server, directory: dto.directory, sessionID: dto.sessionID, engine: RUNTIME_AGENT_ID,
    title: dto.title, prompt: dto.prompt, minutes: dto.minutes, mode: dto.mode,
    ...(dto.runAt !== undefined ? { runAt: dto.runAt } : {}), ...(dto.requestKey ? { requestKey: dto.requestKey } : {}),
    model: { ...dto.model }, enabled: dto.enabled, nextAt: dto.nextAt, ...(dto.lastAt !== undefined ? { lastAt: dto.lastAt } : {}),
    state: dto.state, ...(dto.detail ? { detail: dto.detail } : {}),
    ...(typeof dto.attempt === "number" && Number.isInteger(dto.attempt) && dto.attempt > 0 ? { attempt: dto.attempt } : {}),
  };
}

export class TaskScheduler {
  private tasks: ScheduledTask[] = [];
  private info: SchedulerStatus = { storage: "ok", skipped: 0, pending: {}, flight: null };
  private listeners = new Set<() => void>();
  private backend: RuntimeBackend | null = null;
  private server = "";

  snapshot = () => this.tasks;
  status = () => this.info;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  /** Bind to the connected runtime (null while disconnected). */
  attach(backend: RuntimeBackend | null, server: string): void {
    this.backend = backend;
    this.server = server;
    if (!backend) { this.tasks = []; this.update({ storage: "unavailable" }); return; }
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const backend = this.backend;
    if (!backend) return;
    try {
      const { tasks } = await backend.schedules();
      if (backend !== this.backend) return;
      this.tasks = tasks.map(t => taskOf(t, this.server));
      this.update({ storage: "ok" });
    } catch {
      if (backend === this.backend) this.update({ storage: "unavailable" });
    }
  }

  /** `schedule.updated` / `schedule.removed` from the runtime event stream. */
  observe(event: { type: string; properties: Record<string, unknown> }): void {
    if (event.type === "schedule.updated") {
      const task = event.properties.task as ScheduleDTO | undefined;
      if (!task?.id) return;
      const next = taskOf(task, this.server);
      this.tasks = this.tasks.some(t => t.id === next.id) ? this.tasks.map(t => t.id === next.id ? next : t) : [...this.tasks, next];
      this.notify();
    } else if (event.type === "schedule.removed") {
      const id = event.properties.id;
      if (typeof id !== "string") return;
      this.tasks = this.tasks.filter(t => t.id !== id);
      this.notify();
    }
  }

  private connected(): RuntimeBackend {
    if (!this.backend) throw new Error(STORAGE_FAILED);
    return this.backend;
  }

  async add(input: NewScheduledTask): Promise<ScheduledTask> {
    if (this.tasks.length >= TASK_LIMIT && !this.tasks.some(t => t.requestKey && t.requestKey === input.requestKey))
      throw new Error(`Можно сохранить до ${TASK_LIMIT} заданий. Удалите ненужные.`);
    const created = await this.connected().client.addSchedule({
      directory: input.directory, sessionID: input.sessionID, title: input.title, prompt: input.prompt, minutes: input.minutes,
      mode: input.mode ?? "repeat", ...(input.runAt !== undefined ? { runAt: input.runAt } : {}),
      ...(input.requestKey ? { requestKey: input.requestKey } : {}), model: input.model,
    });
    const task = taskOf(created, this.server);
    this.observe({ type: "schedule.updated", properties: { task: created } });
    return task;
  }

  /** Pause or resume. Resuming starts a full interval from now; nothing is sent immediately. */
  async toggle(id: string): Promise<void> {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return;
    this.update({ pending: { ...this.info.pending, [id]: "pause" } });
    try { this.observe({ type: "schedule.updated", properties: { task: await this.connected().client.toggleSchedule(id, !task.enabled) } }); }
    finally { const pending = { ...this.info.pending }; delete pending[id]; this.update({ pending }); }
  }

  async remove(id: string): Promise<void> {
    this.update({ pending: { ...this.info.pending, [id]: "remove" } });
    try {
      await this.connected().client.removeSchedule(id);
      this.observe({ type: "schedule.removed", properties: { id } });
    } finally { const pending = { ...this.info.pending }; delete pending[id]; this.update({ pending }); }
  }

  /**
   * Wake-ups saved by the previous, window-owned scheduler move into the
   * runtime through its durable cutover journal, for ONE workspace (`servers`
   * are the old origins of this workspace; other workspaces' records are not
   * touched). The runtime stores each complete record first and publishes it
   * atomically in its final state: a paused timer is created disabled, an
   * uncertain occurrence stays disabled with its explanation, an archive is
   * mapped only through its verified continuation, and anything unmappable is
   * quarantined visibly. The old record is removed from storage only for items
   * whose receipt is accepted/resolved; there is no global "done" marker, so a
   * transient failure retries next start with the same ids (no duplicates).
   */
  async migrateLegacy(storage: Pick<Storage, "getItem" | "setItem">, backend: RuntimeBackend, scope: { installation: string; workspace: string; servers: readonly string[] }):
    Promise<{ accepted: number; quarantined: CutoverReceiptDTO[]; pending: number; invalid: number; backupRetained?: boolean }> {
    const none = { accepted: 0, quarantined: [], pending: 0, invalid: 0 };
    let raw: string | null;
    try { raw = storage.getItem(LEGACY_KEY); } catch { return none; }
    if (!raw) return none;
    let list: unknown;
    try { list = JSON.parse(raw); } catch { return { ...none, invalid: 1 }; } // kept untouched for the user
    const { items, invalid } = timerCutoverItems(list, scope.servers);
    if (!items.length) return { ...none, invalid };
    // Throws on transport failure: nothing is marked, the backup stays, a retry reuses the same ids.
    const { receipts } = await backend.client.cutover({ installation: scope.installation, workspace: scope.workspace, source: "ui-timers", items });
    const done = acknowledged(receipts);
    let backupRetained = false;
    if (done.size) {
      // Re-read: only acknowledged records leave, in one write; everything else stays verbatim.
      // The runtime already holds them: a failed backup write keeps the raw copy,
      // and the next start resubmits the same ids (the journal answers the same receipts).
      try {
        const current = storage.getItem(LEGACY_KEY);
        const latest: unknown = current ? JSON.parse(current) : [];
        if (Array.isArray(latest)) {
          const remaining = latest.filter((value) => !(value && typeof value === "object" && done.has(String((value as { id?: unknown }).id))));
          storage.setItem(LEGACY_KEY, JSON.stringify(remaining));
        }
      } catch { backupRetained = true; }
    }
    if (backend === this.backend) await this.refresh();
    const quarantined = receipts.filter((r) => r.state === "quarantined");
    return { accepted: done.size, quarantined, pending: receipts.length - done.size - quarantined.length, invalid, ...(backupRetained ? { backupRetained } : {}) };
  }

  private update(patch: Partial<SchedulerStatus>) { this.info = { ...this.info, ...patch }; this.notify(); }
  private notify() { this.listeners.forEach(listener => listener()); }
}

let instance: TaskScheduler | undefined;
export function taskScheduler(): TaskScheduler {
  return instance ??= new TaskScheduler();
}
