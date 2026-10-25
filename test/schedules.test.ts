// The window keeps only a mirror of the runtime-owned scheduler
// (src/schedules/tasks.ts). Due times, busy/permission waits, durable dispatch,
// ambiguous-delivery pauses, corrupt rows, request-key dedup and restart
// recovery moved to the runtime: src-tauri/resources/agent/test/scheduler-unit.test.ts
// and test/integration/schedules.test.ts. Here: the mirror never dispatches,
// forwards edits exactly, survives disconnects and migrates old records once.
import { afterEach, expect, it, vi } from "vitest";
import type { ScheduleDTO } from "../src-tauri/resources/agent/src/protocol";
import type { CutoverBatch, CutoverReceiptDTO } from "../src/agent/runtime/client";
import { STORAGE_FAILED, TASK_LIMIT, TaskScheduler } from "../src/schedules/tasks";
import { RuntimeReply, runtimeFixture } from "./helpers/runtime-fixture";

const model = { providerID: "p", modelID: "m", variant: "medium" };
const dto = (id: string, extra: Partial<ScheduleDTO> = {}): ScheduleDTO => ({ id, directory: "/project", sessionID: "s", title: "CI", prompt: "Проверь CI",
  minutes: 15, mode: "repeat", model, enabled: true, nextAt: 900000, state: "ready", ...extra });
const input = { server: "local", directory: "/project", sessionID: "s", engine: "pi", title: "CI", prompt: "Проверь CI", minutes: 15, model };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
/** Bind and wait for the initial list, so it cannot later overwrite observed events. */
async function connect(fx: ReturnType<typeof runtimeFixture>, server = "local"): Promise<TaskScheduler> {
  const scheduler = new TaskScheduler();
  scheduler.attach(null, server);
  scheduler.attach(fx.backend, server);
  await vi.waitFor(() => expect(scheduler.status().storage).toBe("ok"));
  return scheduler;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("mirrors the runtime list with its server and saved model, and never dispatches or ticks itself", async () => {
  const fx = runtimeFixture();
  fx.on("GET", "/schedules", () => ({ tasks: [dto("t1")] }));
  const scheduler = new TaskScheduler();
  scheduler.attach(fx.backend, "local");
  await vi.waitFor(() => expect(scheduler.snapshot()).toHaveLength(1));
  expect(scheduler.snapshot()).toEqual([expect.objectContaining({ id: "t1", server: "local", engine: "pi", model, state: "ready" })]);
  expect(scheduler.status().storage).toBe("ok");
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(24 * 3600_000);
  expect(fx.calls.map(c => `${c.method} ${c.path}`)).toEqual(["GET /schedules"]);
});

it("applies schedule events by id and ignores malformed ones", () => {
  const scheduler = new TaskScheduler(), seen = vi.fn();
  scheduler.subscribe(seen);
  scheduler.observe({ type: "schedule.updated", properties: { task: dto("a") } });
  scheduler.observe({ type: "schedule.updated", properties: { task: dto("b") } });
  scheduler.observe({ type: "schedule.updated", properties: { task: dto("a", { state: "waiting", detail: "Ожидает вашего ответа в чате" }) } });
  scheduler.observe({ type: "schedule.updated", properties: { task: { title: "no id" } } });
  scheduler.observe({ type: "schedule.removed", properties: { id: 7 } });
  expect(scheduler.snapshot().map(t => [t.id, t.state, t.detail])).toEqual([["a", "waiting", "Ожидает вашего ответа в чате"], ["b", "ready", undefined]]);
  scheduler.observe({ type: "schedule.removed", properties: { id: "a" } });
  expect(scheduler.snapshot().map(t => t.id)).toEqual(["b"]);
  expect(seen).toHaveBeenCalledTimes(4);
});

it("forwards a new timer exactly, with its saved model and request key, and shows the runtime's record", async () => {
  const fx = runtimeFixture();
  fx.on("POST", "/schedules", c => dto("srv-1", { ...(c.body as object), enabled: true, nextAt: 5, state: "ready" }));
  const scheduler = await connect(fx);
  const task = await scheduler.add({ ...input, mode: "once", runAt: 123, requestKey: "ci-watch" });
  expect(fx.made("POST", "/schedules")[0].body).toEqual({ directory: "/project", sessionID: "s", title: "CI", prompt: "Проверь CI", minutes: 15, mode: "once", runAt: 123, requestKey: "ci-watch", model });
  expect(task).toMatchObject({ id: "srv-1", model });
  expect(scheduler.snapshot().map(t => t.id)).toEqual(["srv-1"]);
  await scheduler.add(input);
  expect(fx.made("POST", "/schedules")[1].body).toMatchObject({ mode: "repeat" });
  expect(fx.made("POST", "/schedules")[1].body).not.toHaveProperty("requestKey");
  expect(fx.made("POST", "/commands")).toHaveLength(0);
});

it("a runtime refusal (duplicate key with another payload, limit) surfaces and records nothing", async () => {
  const fx = runtimeFixture();
  fx.on("POST", "/schedules", () => { throw new RuntimeReply(409, { message: "Этот ключ таймера уже использован с другими параметрами." }); });
  const scheduler = await connect(fx);
  await expect(scheduler.add({ ...input, requestKey: "k" })).rejects.toMatchObject({ status: 409, detail: expect.stringContaining("ключ") });
  expect(scheduler.snapshot()).toEqual([]);
  for (let i = 0; i < TASK_LIMIT; i++) scheduler.observe({ type: "schedule.updated", properties: { task: dto(`t${i}`, { requestKey: `k${i}` }) } });
  await expect(scheduler.add(input)).rejects.toThrow(String(TASK_LIMIT));
  expect(fx.made("POST", "/schedules")).toHaveLength(1);
  // A retried create of an existing key is the runtime's idempotent case, not a new task.
  fx.on("POST", "/schedules", () => dto("t3", { requestKey: "k3" }));
  await expect(scheduler.add({ ...input, requestKey: "k3" })).resolves.toMatchObject({ id: "t3" });
});

it("pause and delete are explicit runtime edits; the pending marker clears even when they fail", async () => {
  const fx = runtimeFixture();
  let release!: () => void;
  fx.on("PATCH", "/schedules/:id", c => new Promise(resolve => { release = () => resolve(dto(c.params.id, { enabled: (c.body as { enabled: boolean }).enabled })); }));
  fx.on("DELETE", "/schedules/:id", () => { throw new RuntimeReply(409, { message: "Таймер сейчас отправляет запрос; повторите через несколько секунд." }); });
  const scheduler = await connect(fx);
  scheduler.observe({ type: "schedule.updated", properties: { task: dto("t1") } });
  const pausing = scheduler.toggle("t1");
  await flush();
  expect(scheduler.status().pending).toEqual({ t1: "pause" });
  expect(fx.made("PATCH", "/schedules/:id")[0]).toMatchObject({ path: "/schedules/t1", body: { enabled: false } });
  release();
  await pausing;
  expect(scheduler.snapshot()[0].enabled).toBe(false);
  expect(scheduler.status().pending).toEqual({});
  await expect(scheduler.remove("t1")).rejects.toMatchObject({ status: 409 });
  expect(scheduler.snapshot().map(t => t.id)).toEqual(["t1"]);
  expect(scheduler.status().pending).toEqual({});
  await scheduler.toggle("unknown");
  expect(fx.made("PATCH", "/schedules/:id")).toHaveLength(1);
});

it("while disconnected nothing is invented: edits fail with the runtime explanation and no request is made", async () => {
  const fx = runtimeFixture();
  const scheduler = new TaskScheduler();
  scheduler.attach(null, "local");
  expect(scheduler.status().storage).toBe("unavailable");
  await expect(scheduler.add(input)).rejects.toThrow(STORAGE_FAILED);
  expect(fx.calls).toEqual([]);
  // A failed refresh keeps the last known mirror instead of showing an empty list.
  scheduler.attach(fx.backend, "local");
  await vi.waitFor(() => expect(scheduler.status().storage).toBe("ok"));
  scheduler.observe({ type: "schedule.updated", properties: { task: dto("t1") } });
  fx.on("GET", "/schedules", () => { throw new RuntimeReply(503); });
  await scheduler.refresh();
  expect(scheduler.status().storage).toBe("unavailable");
  expect(scheduler.snapshot().map(t => t.id)).toEqual(["t1"]);
});

it("moves old window-owned timers into the runtime once; in-flight or failed ones arrive paused and the old record stays as backup", async () => {
  const KEY = "ocdesktop.scheduled-prompts.v1";
  const old = (id: string, extra: Record<string, unknown> = {}) => ({ ...input, id, enabled: true, nextAt: 1, state: "ready", ...extra });
  const raw = JSON.stringify([old("ready"), old("flight", { state: "dispatching" }), old("failed", { state: "error" }), old("off", { enabled: false }),
    old("future", { mode: "once", runAt: Date.now() + 3600_000 }), old("past", { mode: "once", runAt: 1 }),
    old("remote", { server: "ssh:box" }), old("gone", { sessionID: "deleted" })]);
  const values = new Map([[KEY, raw]]);
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
  // The runtime cutover journal (POST /migrations/cutover) publishes each record
  // atomically in its final state: in-flight/failed/paused/missed arrive disabled
  // (agent test/cutover.test.ts "…paused intent…"); an unmappable chat is quarantined.
  const fx = runtimeFixture();
  const journal = new Map<string, CutoverReceiptDTO>();
  fx.on("POST", "/migrations/cutover", c => {
    const batch = c.body as CutoverBatch;
    return { receipts: batch.items.map(item => {
      const known = journal.get(item.legacyId); if (known) return known;
      const gone = item.session.id === "deleted";
      const receipt: CutoverReceiptDTO = { id: `cut-${item.legacyId}`, legacyId: item.legacyId, kind: "timer", workspace: batch.workspace, state: gone ? "quarantined" : "accepted",
        sessionID: gone ? null : "s", itemID: gone ? null : `srv-${item.legacyId}`, code: gone ? "source_not_imported" : null, reason: null, retryable: true, updatedAt: 1 };
      journal.set(item.legacyId, receipt); return receipt;
    }) };
  });
  const scheduler = await connect(fx);
  const scope = { installation: "inst-0001", workspace: "enki-runtime:local", servers: ["local"] };
  // Seven records of this workspace are submitted; six are accepted and the
  // seventh ("gone": its chat was never imported) is quarantined, not counted.
  const first = await scheduler.migrateLegacy(storage, fx.backend, scope);
  expect(first).toMatchObject({ accepted: 6, pending: 0, invalid: 0 });
  expect(first.quarantined).toEqual([expect.objectContaining({ legacyId: "gone", kind: "timer", state: "quarantined", sessionID: null, itemID: null, code: "source_not_imported", retryable: true })]);
  // Durable intent: the runtime journal holds an accepted receipt for every other record.
  expect([...journal.values()].filter(r => r.state === "accepted").map(r => r.legacyId)).toEqual(["ready", "flight", "failed", "off", "future", "past"]);
  const [batch] = fx.made("POST", "/migrations/cutover").map(c => c.body as CutoverBatch);
  // Only this workspace's records; every one with its own model and timing intent verbatim.
  expect(batch.items.map(i => i.legacyId)).toEqual(["ready", "flight", "failed", "off", "future", "past", "gone"]);
  expect(batch.items.every(i => JSON.stringify(i.timer?.model) === JSON.stringify(model))).toBe(true);
  expect(batch.items.map(i => [i.timer?.state, i.timer?.enabled])).toEqual([["ready", true], ["dispatching", true], ["error", true], ["ready", false], ["ready", true], ["ready", true], ["ready", true]]);
  expect(batch.items[4].timer).toMatchObject({ mode: "once", runAt: expect.any(Number) });
  expect(batch.items[5].timer).toMatchObject({ mode: "once", runAt: 1 });
  // The backup keeps exactly what the runtime has not accepted, plus the other workspace's record.
  expect((JSON.parse(values.get(KEY)!) as Array<{ id: string }>).map(t => t.id)).toEqual(["remote", "gone"]);
  expect(fx.made("POST", "/schedules")).toHaveLength(0);
  expect(fx.made("POST", "/commands")).toHaveLength(0);
  // Idempotent: a retry resubmits only the unaccepted record under its id and creates nothing new.
  expect(await scheduler.migrateLegacy(storage, fx.backend, scope)).toMatchObject({ accepted: 0, quarantined: [expect.objectContaining({ legacyId: "gone" })] });
  expect(fx.made("POST", "/migrations/cutover")[1].body).toMatchObject({ items: [expect.objectContaining({ legacyId: "gone" })] });
  expect(journal.size).toBe(7);
  // Unreadable or inaccessible old data is left alone.
  values.set(KEY, "{not json");
  expect(await scheduler.migrateLegacy(storage, fx.backend, scope)).toMatchObject({ accepted: 0, invalid: 1 });
  expect(values.get(KEY)).toBe("{not json");
  expect(await scheduler.migrateLegacy({ getItem: () => { throw new Error("denied"); }, setItem: () => {} }, fx.backend, scope)).toMatchObject({ accepted: 0 });
  expect(fx.made("POST", "/migrations/cutover")).toHaveLength(2);
});

it("a late list from the previous runtime cannot overwrite the current one", async () => {
  const old = runtimeFixture({ connection: { endpoint: "http://127.0.0.1:43001" } });
  let answerOld!: () => void;
  old.on("GET", "/schedules", () => new Promise(resolve => { answerOld = () => resolve({ tasks: [dto("old")] }); }));
  const scheduler = new TaskScheduler();
  scheduler.attach(old.backend, "a");
  await flush();
  const current = runtimeFixture({ connection: { endpoint: "http://127.0.0.1:43002" } });
  current.on("GET", "/schedules", () => ({ tasks: [dto("new")] }));
  scheduler.attach(current.backend, "b");
  await vi.waitFor(() => expect(scheduler.snapshot().map(t => t.id)).toEqual(["new"]));
  answerOld();
  for (let i = 0; i < 10; i++) await flush();
  expect(scheduler.snapshot().map(t => [t.id, t.server])).toEqual([["new", "b"]]);
  expect(old.made("GET", "/schedules")).toHaveLength(1);
});
