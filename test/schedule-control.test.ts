// Agent-control `schedule` command (src/schedules/control.ts) over the runtime
// mirror. Explicit scope only: it never selects a chat, stops work, sends a
// prompt or changes the visible chat's model. Request-key idempotency and
// due-time execution are runtime authorities (scheduler-unit.test.ts); the
// route table below only stores what the runtime would return.
//
// Fixed in the final UI review: control.ts resolves the background chat's own
// model through Store.modelChoiceForSession and awaits every runtime edit.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ScheduleDTO } from "../src-tauri/resources/agent/src/protocol";
import { store } from "../src/state/store";
import { scheduleCommand } from "../src/schedules/control";
import { taskScheduler } from "../src/schedules/tasks";
import { bindStore, runtimeFixture, type RuntimeFixture } from "./helpers/runtime-fixture";

const args = { action: "create", directory: "/p", session_id: "s", mode: "repeat", minutes: 5, title: "CI", prompt: "Check CI", request_key: "ci", provider_id: "p", model_id: "m" };
let fx: RuntimeFixture, original: typeof store.state, sessionDirectory: string, archived: number | null;

beforeEach(async () => {
  original = store.state;
  sessionDirectory = "/p"; archived = null;
  fx = runtimeFixture();
  const tasks = new Map<string, ScheduleDTO>();
  let n = 0;
  fx.on("GET", "/sessions/:id", c => ({ id: c.params.id, directory: sessionDirectory, title: "chat", projectID: "p", time: { created: 1, updated: 1, archived } }));
  fx.on("GET", "/schedules", () => ({ tasks: [...tasks.values()] }));
  fx.on("POST", "/schedules", c => {
    const body = c.body as ScheduleDTO;
    const same = [...tasks.values()].find(t => t.sessionID === body.sessionID && t.requestKey === body.requestKey);
    if (same) return same;
    const task: ScheduleDTO = { ...body, id: `t${++n}`, enabled: true, nextAt: Date.now() + body.minutes * 60_000, state: "ready" };
    tasks.set(task.id, task);
    return task;
  });
  fx.on("PATCH", "/schedules/:id", c => { const t = { ...tasks.get(c.params.id)!, ...(c.body as object) }; tasks.set(t.id, t); return t; });
  fx.on("DELETE", "/schedules/:id", c => { tasks.delete(c.params.id); return undefined; });
  bindStore(store, fx, { directory: "/elsewhere", activeSessionId: "visible" });
  const scheduler = taskScheduler();
  scheduler.attach(null, store.state.prefs.workspaceKey!);
  scheduler.attach(fx.backend, store.state.prefs.workspaceKey!);
  await vi.waitFor(() => expect(scheduler.status().storage).toBe("ok"));
});
afterEach(() => { store.state = original; (store as unknown as { runtime: unknown }).runtime = null; taskScheduler().attach(null, ""); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("creates/lists/pauses/resumes/removes in the explicit chat without selecting or interrupting the visible one", async () => {
  const select = vi.spyOn(store, "selectSession"), stop = vi.spyOn(store, "stopSession"), prompt = vi.spyOn(store, "sendPrompt");
  const result = await scheduleCommand(args);
  expect(result.task).toMatchObject({ title: "CI", sessionID: "s", directory: "/p", model: { providerID: "p", modelID: "m" } });
  const id = (result.task as { id: string }).id;
  expect(((await scheduleCommand(args)).task as { id: string }).id).toBe(id);
  expect((await scheduleCommand({ ...args, action: "list" })).tasks).toHaveLength(1);
  await expect(scheduleCommand({ ...args, session_id: "foreign", action: "remove", id })).rejects.toThrow("не найден");
  await scheduleCommand({ ...args, action: "pause", id });
  expect(taskScheduler().snapshot()[0].enabled).toBe(false);
  await scheduleCommand({ ...args, action: "resume", id });
  expect(taskScheduler().snapshot()[0].enabled).toBe(true);
  await scheduleCommand({ ...args, action: "remove", id });
  expect(taskScheduler().snapshot()).toHaveLength(0);
  expect(store.state.activeSessionId).toBe("visible");
  expect(store.state.directory).toBe("/elsewhere");
  for (const spy of [select, stop, prompt]) expect(spy).not.toHaveBeenCalled();
  expect(fx.made("POST", "/commands")).toHaveLength(0);
  expect(fx.made("POST", "/sessions/:id/stop")).toHaveLength(0);
});

it("refuses archived, moved and invalid scope/dates before saving", async () => {
  await expect(scheduleCommand({ ...args, run_at: 1 })).rejects.toThrow("Время");
  await expect(scheduleCommand({ ...args, minutes: 0 })).rejects.toThrow("Интервал");
  sessionDirectory = "/other";
  await expect(scheduleCommand(args)).rejects.toThrow("перенесён");
  sessionDirectory = "/p"; archived = 5;
  await expect(scheduleCommand(args)).rejects.toThrow("архивирован");
  expect(fx.made("POST", "/schedules")).toHaveLength(0);
  expect(taskScheduler().snapshot()).toHaveLength(0);
});

it("captures the background chat's own saved model rather than the visible chat selection", async () => {
  store.state = { ...store.state, connectedProviderIds: ["p"], prefs: { ...store.state.prefs, modelChoice: {
    ...store.state.prefs.modelChoice, "session:s": { providerID: "p", modelID: "own", variant: "medium" }, "session:visible": { providerID: "p", modelID: "visible" } } } };
  const before = store.state.prefs.modelChoice;
  const { provider_id: _provider, model_id: _model, ...scoped } = args;
  const result = await scheduleCommand(scoped);
  expect(result.task).toMatchObject({ sessionID: "s", model: { providerID: "p", modelID: "own", variant: "medium" } });
  expect(fx.made("POST", "/schedules")[0].body).toMatchObject({ model: { providerID: "p", modelID: "own", variant: "medium" } });
  expect(store.state.activeSessionId).toBe("visible");
  expect(store.state.prefs.modelChoice).toEqual(before);
});
