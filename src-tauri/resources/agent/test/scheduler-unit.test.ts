// Runtime Scheduler against an owned host: the dispatch invariants formerly
// tested on the window-owned TaskScheduler (test/schedules.test.ts,
// schedule-wakeups, scheduler-delivery-storage, schedule-preflight) now belong
// here. No SDK, network or model is involved. Written, NOT RUN.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandReceipt, ScheduleDTO } from "../src/protocol.ts";
import { scheduleWakeReminder } from "../src/policy/prompt.ts";
import { MAX_ATTEMPTS, RETRY_MS, Scheduler, TASK_LIMIT, validSchedule, type NewSchedule, type SchedulerHost } from "../src/schedule/scheduler.ts";
import { Database } from "../src/store/db.ts";
import { EventJournal } from "../src/store/events.ts";
import { tempDir } from "./helpers.ts";

const MINUTE = 60_000;
const model = { providerID: "p", modelID: "m" };
const input = (extra: Partial<NewSchedule> = {}): NewSchedule =>
  ({ directory: "/project", sessionID: "s1", title: "CI", prompt: "Проверь CI", minutes: 15, mode: "repeat", model, ...extra });
const receipt = (id: string, state: CommandReceipt["state"], error?: string): CommandReceipt =>
  ({ id, kind: "prompt", sessionID: "s1", state, createdAt: 1, updatedAt: 1, ...(error ? { error } : {}) });

let db: Database, journal: EventJournal, scheduler: Scheduler;
let submitted: Array<{ task: ScheduleDTO; commandId: string; text: string; stored: ScheduleDTO["state"] }>;
let blocker: string | null, invalid: string | null, answer: (commandId: string) => CommandReceipt;
const stored = (id: string) => scheduler.list().tasks.find(t => t.id === id)!;
const host: SchedulerHost = {
  blocker: () => blocker,
  invalid: () => invalid,
  submit: (task, commandId, text) => { submitted.push({ task, commandId, text, stored: stored(task.id).state }); return answer(commandId); },
};

beforeEach(() => {
  db = new Database(path.join(tempDir("scheduler"), "runtime.db"));
  journal = new EventJournal(db);
  scheduler = new Scheduler(db, journal);
  scheduler.bind(host);
  submitted = []; blocker = null; invalid = null; answer = id => receipt(id, "running");
});
afterEach(() => db.close());

describe("delivery", () => {
  it("sends a due wake-up once with a stable command id and the hidden wake marker, persisted before the side effect", () => {
    const task = scheduler.add(input({ mode: "once", runAt: 1000 }), 0);
    scheduler.tick(999);
    expect(submitted).toHaveLength(0);
    scheduler.tick(1000);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ commandId: `schedule-${task.id}-1000`, stored: "dispatching", text: `Проверь CI\n\n${scheduleWakeReminder("s1", task.id)}` });
    expect(submitted[0].task.model).toEqual(model);
    expect(stored(task.id)).toMatchObject({ state: "sent", enabled: false });
    scheduler.tick(10 * MINUTE);
    expect(submitted).toHaveLength(1);
  });

  it("repeats a full interval after delivery and never catches up missed ticks", () => {
    const task = scheduler.add(input(), 0);
    scheduler.tick(100 * MINUTE);
    expect(submitted).toHaveLength(1);
    const next = stored(task.id).nextAt;
    expect(next).toBeGreaterThanOrEqual(Date.now() + 15 * MINUTE - 1000);
    scheduler.tick(next - 1);
    expect(submitted).toHaveLength(1);
  });

  it("a late start moves overdue repeats forward and dispatches at most one task per tick, oldest first", () => {
    const a = scheduler.add(input({ title: "a", minutes: 5 }), 0), b = scheduler.add(input({ title: "b", minutes: 10 }), 0);
    scheduler.recover(() => null, 60 * MINUTE);
    expect(stored(a.id).nextAt).toBe(65 * MINUTE);
    expect(stored(b.id).nextAt).toBe(70 * MINUTE);
    scheduler.tick(80 * MINUTE);
    expect(submitted.map(s => s.task.id)).toEqual([a.id]);
    scheduler.tick(80 * MINUTE);
    expect(submitted.map(s => s.task.id)).toEqual([a.id, b.id]);
  });

  it("waits while the chat is busy or has a pending question, without a backlog, then sends once", () => {
    const task = scheduler.add(input({ mode: "once", runAt: 1000 }), 0);
    blocker = "Ожидает вашего ответа в чате";
    scheduler.tick(2000);
    expect(stored(task.id)).toMatchObject({ state: "waiting", detail: blocker, enabled: true });
    blocker = null;
    scheduler.tick(2000 + RETRY_MS - 1);
    expect(submitted).toHaveLength(0);
    scheduler.tick(2000 + RETRY_MS);
    scheduler.tick(2000 + RETRY_MS);
    expect(submitted).toHaveLength(1);
  });

  it("a closed admission (maintenance) dispatches nothing", () => {
    scheduler.add(input({ mode: "once", runAt: 1 }), 0);
    scheduler.setAdmission(false);
    scheduler.tick(10 * MINUTE);
    expect(submitted).toHaveLength(0);
  });

  it("an invalid target (deleted/archived chat, unknown model) pauses with its reason and is never sent", () => {
    const task = scheduler.add(input({ mode: "once", runAt: 1 }), 0);
    invalid = "Чат удалён.";
    scheduler.tick(10);
    scheduler.tick(10 * MINUTE);
    expect(submitted).toHaveLength(0);
    expect(stored(task.id)).toMatchObject({ enabled: false, state: "error", detail: "Чат удалён." });
  });
});

describe("ambiguous and definite outcomes", () => {
  it("an uncertain outcome pauses with the app's own explanation and is never replayed", () => {
    const task = scheduler.add(input({ mode: "once", runAt: 1 }), 0);
    answer = id => receipt(id, "uncertain", "secret provider body");
    scheduler.tick(10);
    scheduler.tick(10 * MINUTE);
    expect(submitted).toHaveLength(1);
    expect(stored(task.id)).toMatchObject({ enabled: false, state: "error" });
    expect(stored(task.id).detail).not.toContain("secret");
  });

  it("a definite refusal waits with the runtime's reason and is retried later, never as 'uncertain'", () => {
    const task = scheduler.add(input({ mode: "once", runAt: 1 }), 0);
    answer = id => receipt(id, "rejected", "Модель недоступна");
    scheduler.tick(10);
    expect(stored(task.id)).toMatchObject({ state: "waiting", detail: "Модель недоступна", enabled: true });
    answer = id => receipt(id, "running");
    // The back-off is measured from the receipt (wall clock), not from the tick.
    scheduler.tick(Date.now() + RETRY_MS - 1000);
    expect(submitted).toHaveLength(1);
    scheduler.tick(Date.now() + RETRY_MS + 1000);
    expect(submitted).toHaveLength(2);
    expect(stored(task.id).state).toBe("sent");
  });

  it("a withdrawn (cancelled) check sends nothing durable and stays ready for the next tick", () => {
    const task = scheduler.add(input({ mode: "once", runAt: 1 }), 0);
    answer = id => receipt(id, "cancelled");
    scheduler.tick(10);
    expect(stored(task.id)).toMatchObject({ state: "ready", enabled: true });
  });

  it("a gated receipt completes only through its own command id", () => {
    const task = scheduler.add(input({ mode: "once", runAt: 1 }), 0);
    answer = id => receipt(id, "accepted");
    scheduler.tick(10);
    expect(stored(task.id).state).toBe("dispatching");
    scheduler.tick(10 * MINUTE);
    expect(submitted).toHaveLength(1);
    expect(() => scheduler.toggle(task.id, false)).toThrow(/отправляет/);
    expect(() => scheduler.remove(task.id)).toThrow(/отправляет/);
    scheduler.onReceipt(task.id, receipt(`schedule-${task.id}-999`, "completed"));
    expect(stored(task.id).state).toBe("dispatching");
    expect(scheduler.taskForCommand(submitted[0].commandId)).toBe(task.id);
    scheduler.onReceipt(task.id, receipt(submitted[0].commandId, "completed"));
    expect(stored(task.id)).toMatchObject({ state: "sent", enabled: false });
  });

  it("a submit that throws is never re-sent by a later tick", () => {
    const task = scheduler.add(input({ mode: "once", runAt: 1 }), 0);
    answer = () => { throw new Error("dispatcher failure"); };
    expect(() => scheduler.tick(10)).toThrow("dispatcher failure");
    answer = id => receipt(id, "running");
    scheduler.tick(10 * MINUTE);
    expect(submitted).toHaveLength(1);
    expect(stored(task.id).state).toBe("dispatching");
  });
});

// Remainder review: the real Dispatcher dedupes by command id (a reused id
// returns the FIRST receipt and executes nothing). The host below models that,
// which the per-call `answer` fake above cannot.
describe("against a host that dedupes command ids like the dispatcher", () => {
  let ledger: Map<string, CommandReceipt>;
  let fresh: (commandId: string) => CommandReceipt;
  beforeEach(() => {
    ledger = new Map(); fresh = id => receipt(id, "running");
    answer = id => { const known = ledger.get(id); if (known) return known; const r = fresh(id); ledger.set(id, r); return r; };
  });

  it("a refused occurrence is re-attempted under NEW ids with growing back-off, then pauses after the bound", () => {
    const task = scheduler.add(input({ mode: "repeat", minutes: 30 }), 0);
    fresh = id => receipt(id, "rejected", "Hub недоступен");
    let now = 30 * MINUTE;
    scheduler.tick(now);
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      expect(stored(task.id)).toMatchObject({ state: "waiting", attempt, enabled: true, detail: "Hub недоступен" });
      now = Date.now() + RETRY_MS * 2 ** (attempt - 1) + 1_000;
      scheduler.tick(now);
    }
    const ids = submitted.map(s => s.commandId);
    expect(ids).toHaveLength(MAX_ATTEMPTS);
    expect(new Set(ids).size).toBe(MAX_ATTEMPTS);
    expect(ids[0]).toBe(`schedule-${task.id}-${30 * MINUTE}`);
    expect(ids.slice(1)).toEqual(Array.from({ length: MAX_ATTEMPTS - 1 }, (_, i) => `schedule-${task.id}-${30 * MINUTE}-${i + 1}`));
    expect(stored(task.id)).toMatchObject({ enabled: false, state: "error" });
    expect(stored(task.id).attempt).toBeUndefined();
    expect(stored(task.id).detail).toMatch(/приостановлен.*Hub недоступен/);
    scheduler.tick(Number.MAX_SAFE_INTEGER);
    expect(submitted).toHaveLength(MAX_ATTEMPTS);
    // Resume is explicit, resets the attempt budget and sends nothing now.
    expect(scheduler.toggle(task.id, true, now)).toMatchObject({ enabled: true, state: "ready" });
    expect(stored(task.id).attempt).toBeUndefined();
    expect(submitted).toHaveLength(MAX_ATTEMPTS);
  });

  it("a recovered outage delivers on a fresh attempt id exactly once; the sent occurrence clears the attempt", () => {
    const task = scheduler.add(input({ mode: "once", runAt: 1 }), 0);
    fresh = id => receipt(id, "rejected", "Модель недоступна");
    scheduler.tick(10);
    fresh = id => receipt(id, "running");
    scheduler.tick(Date.now() + RETRY_MS + 1_000);
    expect(submitted.map(s => s.commandId)).toEqual([`schedule-${task.id}-1`, `schedule-${task.id}-1-1`]);
    expect(ledger.get(`schedule-${task.id}-1-1`)?.state).toBe("running");
    expect(stored(task.id)).toMatchObject({ state: "sent", enabled: false });
    expect(stored(task.id).attempt).toBeUndefined();
    scheduler.tick(Number.MAX_SAFE_INTEGER);
    expect(submitted).toHaveLength(2);
    // Each id reached the dispatcher once; no stale refusal was reused.
    expect(new Set(submitted.map(s => s.commandId)).size).toBe(2);
  });

  it("a withdrawn (cancelled) wake is never re-run as is and cannot starve another due timer", () => {
    const stopped = scheduler.add(input({ title: "stopped", mode: "once", runAt: 1, minutes: 60 }), 0);
    const other = scheduler.add(input({ title: "other", sessionID: "s2", mode: "once", runAt: 2 }), 0);
    fresh = id => id.startsWith(`schedule-${stopped.id}-`) ? receipt(id, "cancelled") : receipt(id, "running");
    const now = Date.now();
    scheduler.tick(now);
    expect(submitted.map(s => s.task.id)).toEqual([stopped.id]);
    // Still enabled and ready, but its occurrence moved a full interval ahead.
    expect(stored(stopped.id)).toMatchObject({ state: "ready", enabled: true });
    expect(stored(stopped.id).nextAt).toBeGreaterThanOrEqual(now + 60 * MINUTE);
    scheduler.tick(now + 1);
    scheduler.tick(now + 2);
    expect(submitted.map(s => s.task.id)).toEqual([stopped.id, other.id]);
    expect(stored(other.id)).toMatchObject({ state: "sent" });
    // The deferred occurrence is a NEW id, never the withdrawn one.
    scheduler.tick(stored(stopped.id).nextAt);
    expect(submitted).toHaveLength(3);
    expect(submitted[2].commandId).not.toBe(submitted[0].commandId);
  });

  it("a restart reconciles an in-flight re-attempt through its own attempt id", () => {
    const task = scheduler.add(input({ mode: "once", runAt: 1 }), 0);
    fresh = id => receipt(id, "rejected", "Hub недоступен");
    scheduler.tick(10);
    db.run("UPDATE schedules SET body=json_set(body,'$.state','dispatching') WHERE id=?", task.id);
    const restarted = new Scheduler(db, journal);
    restarted.bind(host);
    expect(restarted.taskForCommand(`schedule-${task.id}-1-1`)).toBe(task.id);
    expect(restarted.taskForCommand(`schedule-${task.id}-1`)).toBeNull();
    restarted.recover(id => id === `schedule-${task.id}-1-1` ? receipt(id, "completed") : null, 20);
    expect(stored(task.id)).toMatchObject({ state: "sent", enabled: false });
  });

  it("stored attempt values outside the bound are refused, never executed", () => {
    const good = scheduler.add(input(), 0);
    for (const attempt of [0, -1, 1.5, MAX_ATTEMPTS, "1"]) expect(validSchedule({ ...good, attempt }), String(attempt)).toBe(false);
    expect(validSchedule({ ...good, attempt: 1 })).toBe(true);
  });
});

describe("wake-ups after relaunch and storage faults (ported from schedule-wakeups / scheduler-delivery-storage)", () => {
  it("delivers an overdue one-shot once after a restart, never losing or repeating it", () => {
    const task = scheduler.add(input({ mode: "once", runAt: 1_100_000 }), 1_000_000);
    const restarted = new Scheduler(db, journal);
    restarted.bind(host);
    restarted.recover(() => null, 2_000_000);
    expect(stored(task.id).nextAt).toBe(1_100_000);
    restarted.tick(2_000_000);
    restarted.tick(3_000_000);
    const again = new Scheduler(db, journal);
    again.bind(host);
    again.recover(() => null, 4_000_000);
    again.tick(4_000_000);
    expect(submitted).toHaveLength(1);
    expect(stored(task.id)).toMatchObject({ enabled: false, state: "sent" });
  });

  it("rejects malformed new fields before storing anything", () => {
    for (const extra of [{ mode: "forever" }, { runAt: Number.NaN }, { requestKey: "x".repeat(129) }, { minutes: 0 }, { title: "t".repeat(121) }])
      expect(() => scheduler.add(input(extra as Partial<NewSchedule>), 0), JSON.stringify(extra)).toThrow();
    expect(scheduler.list().tasks).toEqual([]);
  });

  it("never re-delivers an accepted wake-up when recording its acknowledgement fails", () => {
    const task = scheduler.add(input({ mode: "once", runAt: 1 }), 0);
    const run = db.run.bind(db);
    let failed = false;
    db.run = (sql, ...params) => {
      if (!failed && sql.startsWith("INSERT INTO schedules") && String(params[3]).includes('"state":"sent"')) { failed = true; throw new Error("disk I/O error"); }
      return run(sql, ...params);
    };
    expect(() => scheduler.tick(10)).toThrow("disk I/O error");
    db.run = run;
    scheduler.tick(10 * MINUTE);
    expect(submitted).toHaveLength(1);
    // The occurrence is still the in-flight one; a restart reconciles it from the ledger.
    scheduler.recover(id => receipt(id, "running"), 20 * MINUTE);
    expect(stored(task.id)).toMatchObject({ state: "sent", enabled: false });
  });
});

describe("durable storage and restart", () => {
  it("a dispatch interrupted by a restart pauses for review unless its receipt proves the outcome", () => {
    const lost = scheduler.add(input({ title: "lost", mode: "once", runAt: 1 }), 0);
    const proven = scheduler.add(input({ title: "proven", mode: "once", runAt: 1 }), 0);
    for (const task of [lost, proven])
      db.run("UPDATE schedules SET body=json_set(body,'$.state','dispatching') WHERE id=?", task.id);
    const restarted = new Scheduler(db, journal);
    restarted.bind(host);
    restarted.recover(id => id === `schedule-${proven.id}-1` ? receipt(id, "completed") : null, 10);
    expect(stored(lost.id)).toMatchObject({ enabled: false, state: "error" });
    expect(stored(proven.id)).toMatchObject({ state: "sent", enabled: false });
    restarted.tick(10 * MINUTE);
    expect(submitted).toHaveLength(0);
  });

  it("skips and counts corrupted or unbounded rows instead of executing them", () => {
    const good = scheduler.add(input(), 0);
    db.run("INSERT INTO schedules(id,session_id,directory,body) VALUES(?,?,?,?)", "bad", "s1", "/project", "{not json");
    db.run("INSERT INTO schedules(id,session_id,directory,body) VALUES(?,?,?,?)", "zero", "s1", "/project",
      JSON.stringify({ ...good, id: "zero", minutes: 0, nextAt: 1 }));
    expect(scheduler.list()).toMatchObject({ skipped: 2, tasks: [expect.objectContaining({ id: good.id })] });
    scheduler.tick(Number.MAX_SAFE_INTEGER);
    expect(submitted.map(s => s.task.id)).toEqual([good.id]);
    expect(validSchedule({ ...good, prompt: "   " })).toBe(false);
    expect(validSchedule({ ...good, minutes: 10081 })).toBe(false);
    expect(validSchedule({ ...good, extra: 1, state: "unknown" })).toBe(false);
    expect(() => scheduler.add(input({ prompt: " ".repeat(5) }), 0)).toThrow();
  });

  it("a retried create with the same request key is idempotent; a changed payload is refused", () => {
    const first = scheduler.add(input({ requestKey: "ci-watch" }), 0);
    expect(scheduler.add(input({ requestKey: "ci-watch" }), 5).id).toBe(first.id);
    expect(() => scheduler.add(input({ requestKey: "ci-watch", prompt: "другое" }), 0)).toThrow(/другими параметрами/);
    // The same key in another chat is another task.
    expect(scheduler.add(input({ requestKey: "ci-watch", sessionID: "s2" }), 0).id).not.toBe(first.id);
    expect(scheduler.list().tasks).toHaveLength(2);
  });

  it("bounds the number of stored tasks", () => {
    for (let i = 0; i < TASK_LIMIT; i++) scheduler.add(input({ title: `t${i}` }), 0);
    expect(() => scheduler.add(input({ title: "over" }), 0)).toThrow(String(TASK_LIMIT));
  });

  it("pause/resume/delete are explicit; resuming starts a full interval and sends nothing", () => {
    const task = scheduler.add(input(), 0);
    expect(scheduler.toggle(task.id, false, 1000)).toMatchObject({ enabled: false });
    scheduler.tick(Number.MAX_SAFE_INTEGER);
    expect(submitted).toHaveLength(0);
    expect(scheduler.toggle(task.id, true, 1000)).toMatchObject({ enabled: true, state: "ready", nextAt: 1000 + 15 * MINUTE });
    expect(submitted).toHaveLength(0);
    const later = scheduler.add(input({ title: "later", mode: "once", runAt: 50 * MINUTE }), 0);
    scheduler.toggle(later.id, false, 1000);
    expect(scheduler.toggle(later.id, true, 2000).nextAt).toBe(50 * MINUTE);
    expect(scheduler.remove(task.id)).toBe(true);
    expect(scheduler.remove(task.id)).toBe(false);
    expect(scheduler.list().tasks.map(t => t.id)).toEqual([later.id]);
  });
});
