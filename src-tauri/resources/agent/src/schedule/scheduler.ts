// Runtime-owned session timers ("wake-ups").
//
// A due timer sends its saved prompt to its saved chat with its saved model,
// through the same dispatcher as a manual prompt. It never consumes the user's
// draft or queue, never answers a permission, and never runs while the chat is
// busy, waiting for the user or has queued work. A late runtime start never
// produces a burst of missed prompts. Each due occurrence has a stable command
// id, so a crash cannot send it twice; an uncertain occurrence pauses the
// timer with an explanation instead of being replayed.
//
// The dispatcher dedupes by command id, so reusing an id never re-executes
// anything — it only returns the old receipt. A provably unexecuted
// (rejected) attempt is therefore re-attempted under a NEW id derived from a
// durable attempt counter, a bounded number of times; a cancelled (withdrawn)
// occurrence is consumed and deferred by a full interval, never re-run as is.

import { randomUUID } from "node:crypto";
import type { CommandReceipt, ModelRef, ScheduleDTO } from "../protocol.ts";
import { isModelRef, SCHEDULE_MAX_ATTEMPTS } from "../protocol.ts";
import { wakeText } from "../policy/prompt.ts";
import { text, type Database } from "../store/db.ts";
import type { EventJournal } from "../store/events.ts";

export const TASK_LIMIT = 50;
export const MAX_MINUTES = 10080;
const MINUTE = 60_000;
export const RETRY_MS = 15_000;
/** Attempts of one occurrence that may be refused before the timer pauses. */
export const MAX_ATTEMPTS = SCHEDULE_MAX_ATTEMPTS;

const UNCERTAIN = "Отправку не удалось подтвердить. Проверьте историю чата; затем возобновите таймер вручную.";
const INTERRUPTED = "Enki Runtime остановилась во время отправки. Проверьте историю чата перед возобновлением.";

const bounded = (s: unknown, max: number): s is string => typeof s === "string" && !!s.trim() && s.length <= max;

export function validSchedule(value: unknown): value is ScheduleDTO {
  if (!value || typeof value !== "object") return false;
  const t = value as ScheduleDTO;
  return bounded(t.id, 128) && bounded(t.directory, 4096) && bounded(t.sessionID, 512) && bounded(t.title, 120) && bounded(t.prompt, 20000)
    && Number.isInteger(t.minutes) && t.minutes >= 1 && t.minutes <= MAX_MINUTES && (t.mode === "once" || t.mode === "repeat")
    && (t.runAt === undefined || (Number.isFinite(t.runAt) && t.runAt >= 0)) && (t.requestKey === undefined || bounded(t.requestKey, 128))
    && isModelRef(t.model) && typeof t.enabled === "boolean" && Number.isFinite(t.nextAt)
    && (t.lastAt === undefined || Number.isFinite(t.lastAt))
    && ["ready", "waiting", "dispatching", "sent", "error"].includes(t.state)
    && (t.detail === undefined || (typeof t.detail === "string" && t.detail.length <= 2000))
    && (t.attempt === undefined || (Number.isInteger(t.attempt) && t.attempt >= 1 && t.attempt < MAX_ATTEMPTS));
}

export interface NewSchedule {
  directory: string; sessionID: string; title: string; prompt: string; minutes: number;
  mode: "once" | "repeat"; runAt?: number; requestKey?: string; model: ModelRef;
}

export interface ImportedSchedule extends NewSchedule {
  id: string;
  /** The source's enabled intent; false for paused, uncertain or blocked timers. */
  enabled: boolean;
  nextAt?: number;
  lastAt?: number;
  /** Set for an uncertain/blocked source occurrence; stored as a disabled error. */
  detail?: string;
}

export interface SchedulerHost {
  /** Why the chat cannot take a wake-up now, or null when it can. */
  blocker(sessionID: string): string | null;
  /** Permanent reasons: chat deleted/archived/moved, read-only archive, unknown model. */
  invalid(task: ScheduleDTO): string | null;
  submit(task: ScheduleDTO, commandId: string, text: string): CommandReceipt;
}

export class Scheduler {
  private host: SchedulerHost | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private retryAt = new Map<string, number>();
  private admission = true;

  constructor(private readonly db: Database, private readonly journal: EventJournal) {}

  bind(host: SchedulerHost): void { this.host = host; }

  private load(): ScheduleDTO[] {
    const out: ScheduleDTO[] = [];
    for (const row of this.db.all("SELECT body FROM schedules")) {
      try {
        const value: unknown = JSON.parse(text(row, "body"));
        if (validSchedule(value)) out.push(value);
      } catch { /* Unreadable rows are skipped and reported by list(). */ }
    }
    return out;
  }

  private save(task: ScheduleDTO): void {
    this.db.run("INSERT INTO schedules(id,session_id,directory,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      task.id, task.sessionID, task.directory, JSON.stringify(task));
    this.journal.append(task.directory, task.sessionID, { type: "schedule.updated", properties: { sessionID: task.sessionID, task } });
  }

  list(filter: { directory?: string; sessionID?: string } = {}): { tasks: ScheduleDTO[]; skipped: number } {
    const rows = this.db.all("SELECT body FROM schedules");
    const tasks = this.load();
    return {
      tasks: tasks.filter((t) => (!filter.directory || t.directory === filter.directory) && (!filter.sessionID || t.sessionID === filter.sessionID)),
      skipped: rows.length - tasks.length,
    };
  }

  add(input: NewSchedule, now = Date.now()): ScheduleDTO {
    const tasks = this.load();
    if (input.requestKey) {
      const existing = tasks.find((t) => t.directory === input.directory && t.sessionID === input.sessionID && t.requestKey === input.requestKey);
      if (existing) {
        if (existing.title !== input.title || existing.prompt !== input.prompt || existing.minutes !== input.minutes || existing.mode !== input.mode
            || existing.runAt !== input.runAt || JSON.stringify(existing.model) !== JSON.stringify(input.model))
          throw new Error("Этот ключ таймера уже использован с другими параметрами.");
        return existing;
      }
    }
    if (tasks.length >= TASK_LIMIT) throw new Error(`Можно сохранить до ${TASK_LIMIT} заданий. Удалите ненужные.`);
    const task: ScheduleDTO = {
      id: randomUUID(), directory: input.directory, sessionID: input.sessionID, title: input.title.trim(), prompt: input.prompt,
      minutes: input.minutes, mode: input.mode, ...(input.runAt !== undefined ? { runAt: input.runAt } : {}),
      ...(input.requestKey ? { requestKey: input.requestKey } : {}), model: input.model,
      enabled: true, nextAt: input.runAt ?? now + input.minutes * MINUTE, state: "ready",
    };
    if (!validSchedule(task)) throw new Error("Проверьте название, текст и интервал задания.");
    this.save(task);
    return task;
  }

  /**
   * Cutover publication of a pre-2.0 timer under a caller-chosen stable id, in
   * the caller's transaction. The row is written once in its final state: a
   * paused timer is stored disabled (never created enabled and then paused),
   * an uncertain one stays disabled with its explanation, and an overdue
   * occurrence never becomes immediately due work.
   */
  importTask(input: ImportedSchedule, now = Date.now()): ScheduleDTO {
    const tasks = this.load();
    const existing = tasks.find((t) => t.id === input.id);
    if (existing) {
      if (existing.sessionID !== input.sessionID || existing.prompt !== input.prompt || existing.minutes !== input.minutes)
        throw new Error("Идентификатор перенесённого таймера уже занят другим заданием.");
      return existing;
    }
    if (tasks.length >= TASK_LIMIT) throw new Error(`Можно сохранить до ${TASK_LIMIT} заданий. Удалите ненужные и повторите перенос.`);
    let enabled = input.enabled, state: ScheduleDTO["state"] = input.detail ? "error" : "ready", detail = input.detail;
    let nextAt = input.nextAt ?? input.runAt ?? now + input.minutes * MINUTE;
    if (enabled && nextAt <= now) {
      if (input.mode === "repeat") nextAt = now + input.minutes * MINUTE;
      else { enabled = false; state = "error"; detail = "Время однократного запуска прошло во время обновления. Проверьте чат и запустите таймер заново вручную."; }
    }
    const task: ScheduleDTO = {
      id: input.id, directory: input.directory, sessionID: input.sessionID, title: input.title.trim().slice(0, 120), prompt: input.prompt,
      minutes: input.minutes, mode: input.mode, ...(input.runAt !== undefined ? { runAt: input.runAt } : {}),
      ...(input.requestKey ? { requestKey: input.requestKey } : {}), model: input.model,
      enabled, nextAt, ...(input.lastAt !== undefined ? { lastAt: input.lastAt } : {}), state, ...(detail ? { detail: detail.slice(0, 2000) } : {}),
    };
    if (!validSchedule(task)) throw new Error("Перенесённый таймер не прошёл проверку.");
    this.save(task);
    return task;
  }

  /** Pause/resume. Resuming starts a full interval from now; nothing is sent immediately. */
  toggle(id: string, enabled: boolean, now = Date.now()): ScheduleDTO {
    const task = this.load().find((t) => t.id === id);
    if (!task) throw new Error("Таймер не найден.");
    if (task.state === "dispatching") throw new Error("Таймер сейчас отправляет запрос; повторите через несколько секунд.");
    this.retryAt.delete(id);
    const next: ScheduleDTO = { ...task, enabled, state: "ready", detail: undefined, attempt: undefined, nextAt: enabled ? (task.mode === "once" && task.runAt && task.runAt > now ? task.runAt : now + task.minutes * MINUTE) : task.nextAt };
    this.save(next);
    return next;
  }

  remove(id: string): boolean {
    const task = this.load().find((t) => t.id === id);
    if (!task) return false;
    if (task.state === "dispatching") throw new Error("Таймер сейчас отправляет запрос; повторите через несколько секунд.");
    this.db.run("DELETE FROM schedules WHERE id=?", id);
    this.retryAt.delete(id);
    this.journal.append(task.directory, task.sessionID, { type: "schedule.removed", properties: { sessionID: task.sessionID, id } });
    return true;
  }

  /** Startup: overdue repeats move forward, in-flight dispatches are reconciled. */
  recover(receipt: (commandId: string) => CommandReceipt | null, now = Date.now()): void {
    for (const task of this.load()) {
      if (task.state === "dispatching") {
        const found = receipt(this.commandId(task));
        if (found) this.onReceipt(task.id, found);
        else this.save({ ...task, enabled: false, state: "error", detail: INTERRUPTED });
        continue;
      }
      if (task.enabled && task.mode === "repeat" && task.nextAt < now) this.save({ ...task, nextAt: now + task.minutes * MINUTE });
    }
  }

  /** Stable per occurrence AND attempt; the first attempt keeps the pre-attempt
   * form, so a dispatching row written by an older runtime still reconciles. */
  private commandId(task: ScheduleDTO): string {
    return `schedule-${task.id}-${task.nextAt}${task.attempt ? `-${task.attempt}` : ""}`;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 5_000);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  setAdmission(allowed: boolean): void { this.admission = allowed; }

  /** One due task per tick, oldest first. */
  tick(now = Date.now()): void {
    if (!this.host || !this.admission) return;
    const due = this.load()
      .filter((t) => t.enabled && t.state !== "dispatching" && t.nextAt <= now && (this.retryAt.get(t.id) ?? 0) <= now)
      .sort((a, b) => a.nextAt - b.nextAt)[0];
    if (!due) return;
    const invalid = this.host.invalid(due);
    if (invalid) { this.save({ ...due, enabled: false, state: "error", detail: invalid }); return; }
    const blocker = this.host.blocker(due.sessionID);
    if (blocker) {
      this.retryAt.set(due.id, now + RETRY_MS);
      if (due.state !== "waiting" || due.detail !== blocker) this.save({ ...due, state: "waiting", detail: blocker });
      return;
    }
    this.retryAt.delete(due.id);
    const dispatching: ScheduleDTO = { ...due, state: "dispatching", detail: undefined };
    // Durable before any side effect: a crash from here on pauses the task.
    this.save(dispatching);
    const receipt = this.host.submit(dispatching, this.commandId(dispatching), wakeText(due.sessionID, due.id, due.prompt));
    this.onReceipt(due.id, receipt);
  }

  onReceipt(taskId: string, receipt: CommandReceipt): void {
    const task = this.load().find((t) => t.id === taskId);
    if (!task || task.state !== "dispatching" || receipt.id !== this.commandId(task)) return;
    const at = Date.now();
    switch (receipt.state) {
      case "running":
      case "completed":
      case "failed":
        this.retryAt.delete(task.id);
        this.save({ ...task, state: "sent", enabled: task.mode === "once" ? false : task.enabled, detail: undefined, attempt: undefined, lastAt: at, nextAt: at + task.minutes * MINUTE });
        return;
      case "rejected": {
        // Provably not executed: the next attempt needs its own command id (the
        // old one is deduped to this same refusal), within a bounded budget.
        const reason = receipt.error ?? "Запрос не отправлен.";
        const attempt = (task.attempt ?? 0) + 1;
        if (attempt >= MAX_ATTEMPTS) {
          this.retryAt.delete(task.id);
          this.save({ ...task, enabled: false, state: "error", attempt: undefined,
            detail: `Таймер приостановлен: пробуждение не отправлено после ${MAX_ATTEMPTS} попыток; возобновите его вручную. ${reason}`.slice(0, 2000) });
          return;
        }
        this.retryAt.set(task.id, at + RETRY_MS * 2 ** (attempt - 1));
        this.save({ ...task, state: "waiting", attempt, detail: reason.slice(0, 2000) });
        return;
      }
      case "cancelled":
        // Withdrawn before the SDK (Stop or maintenance). Never re-run this
        // occurrence as is: it is consumed and the next one is a full interval
        // away (a fresh command id), so it also cannot starve other timers.
        this.retryAt.delete(task.id);
        this.save({ ...task, state: "ready", attempt: undefined, nextAt: at + task.minutes * MINUTE,
          detail: "Пробуждение отменено до отправки; следующее — через полный интервал." });
        return;
      case "uncertain":
        this.retryAt.delete(task.id);
        this.save({ ...task, enabled: false, state: "error", attempt: undefined, detail: UNCERTAIN });
        return;
      default:
        return;
    }
  }

  /** Lookup for receipts arriving after submit (gated dispatch). */
  taskForCommand(commandId: string): string | null {
    // The CURRENT occurrence/attempt id of a stored task, exactly. A pattern
    // cannot split it: ids contain '-' and an attempt suffix may follow.
    return this.load().find((task) => this.commandId(task) === commandId)?.id ?? null;
  }
}
