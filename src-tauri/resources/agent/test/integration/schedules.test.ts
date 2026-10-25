// Runtime timers: a due wake-up runs once with its saved model through the
// common dispatcher; busy chats wait; invalid targets pause; a crash while
// dispatching pauses instead of replaying; overdue repeats never burst.
import { afterEach, expect, it } from "vitest";
import path from "node:path";
import { fauxAssistantMessage, scriptedRuntime } from "../../src/sdk/testing.ts";
import { scheduleWakeReminder } from "../../src/policy/prompt.ts";
import { MAX_ATTEMPTS, RETRY_MS } from "../../src/schedule/scheduler.ts";
import { gate, harness, newSession, promptCommand, tempDir, type Harness } from "../helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

it("dispatches a due wake-up once, with the hidden wake marker", async () => {
  h = await harness();
  const dir = h.project("timer");
  const sid = await newSession(h, dir);
  const created = await h.request<{ id: string; nextAt: number }>("POST", "/schedules", { directory: dir, sessionID: sid, title: "check", prompt: "check status", minutes: 5, mode: "once", runAt: Date.now() + 10, model: h.model() });
  expect(created.status).toBe(200);
  let seen = "";
  h.scripted.setResponses([async (context) => { seen = JSON.stringify(context.messages); return fauxAssistantMessage("status ok"); }]);
  await new Promise((r) => setTimeout(r, 30));
  h.runtime.scheduler.tick();
  const commandId = `schedule-${created.body.id}-${created.body.nextAt}`;
  await h.waitReceipt(commandId, ["completed"]);
  expect(seen).toContain("check status");
  expect(seen).toContain(JSON.stringify(scheduleWakeReminder(sid, created.body.id)).slice(1, 40));
  const task = h.runtime.scheduler.list({ sessionID: sid }).tasks[0];
  expect(task).toMatchObject({ state: "sent", enabled: false });
  h.runtime.scheduler.tick();
  expect(h.scripted.calls()).toBe(1);
  // The user-visible history hides the app-owned wake marker.
  const history = await h.request<{ messages: Array<{ info: { role: string }; parts: Array<{ text?: string }> }> }>("GET", `/sessions/${sid}/messages`);
  expect(history.body.messages.find((m) => m.info.role === "user")?.parts[0].text).toBe("check status");
});

it("waits while the chat is busy and pauses for a deleted chat", async () => {
  h = await harness();
  const dir = h.project("busy");
  const sid = await newSession(h, dir);
  const hold = gate();
  h.scripted.setResponses([async () => { await hold.wait; return fauxAssistantMessage("long"); }]);
  await h.command(promptCommand(h, "busy-1", sid, dir, "long work"));
  await h.waitReceipt("busy-1", ["running"]);
  const created = await h.request<{ id: string }>("POST", "/schedules", { directory: dir, sessionID: sid, title: "t", prompt: "p", minutes: 1, mode: "once", runAt: Date.now() + 5, model: h.model() });
  await new Promise((r) => setTimeout(r, 20));
  h.runtime.scheduler.tick();
  expect(h.runtime.scheduler.list({ sessionID: sid }).tasks[0]).toMatchObject({ state: "waiting", detail: expect.stringContaining("текущей работы") });
  hold.open();
  await h.waitReceipt("busy-1", ["completed"]);
  await h.request("DELETE", `/sessions/${sid}`);
  h.runtime.scheduler.toggle(created.body.id, true);
  h.runtime.db.run("UPDATE schedules SET body=json_set(body,'$.nextAt',0) WHERE id=?", created.body.id);
  h.runtime.scheduler.tick();
  expect(h.runtime.scheduler.list({}).tasks.find((t) => t.id === created.body.id)).toMatchObject({ enabled: false, state: "error" });
});

it("a crash while dispatching pauses the timer; overdue repeats move forward", async () => {
  const data = tempDir("timer-crash");
  const scripted = await scriptedRuntime(path.join(data, "scripted-agent"));
  h = await harness({ data, scripted });
  const dir = h.project("crash-timer");
  const sid = await newSession(h, dir);
  const once = h.runtime.scheduler.add({ directory: dir, sessionID: sid, title: "a", prompt: "a", minutes: 5, mode: "once", runAt: Date.now() + 1000, model: h.model() });
  const repeat = h.runtime.scheduler.add({ directory: dir, sessionID: sid, title: "b", prompt: "b", minutes: 5, mode: "repeat", model: h.model() });
  h.runtime.db.run("UPDATE schedules SET body=json_set(body,'$.state','dispatching') WHERE id=?", once.id);
  h.runtime.db.run("UPDATE schedules SET body=json_set(body,'$.nextAt',1) WHERE id=?", repeat.id);
  await h.stop();
  h = await harness({ data, scripted });
  const tasks = h.runtime.scheduler.list({ sessionID: sid }).tasks;
  expect(tasks.find((t) => t.id === once.id)).toMatchObject({ state: "error", enabled: false });
  expect(tasks.find((t) => t.id === repeat.id)!.nextAt).toBeGreaterThan(Date.now());
  expect(scripted.calls()).toBe(0);
});

it("the desktop schedule MCP command is scoped to an explicit chat and idempotent by request key", async () => {
  h = await harness();
  const dir = h.project("mcp-timer");
  const sid = await newSession(h, dir, { model: h.model() });
  const body = { action: "create", directory: dir, session_id: sid, title: "watch", prompt: "watch CI", minutes: 15, request_key: "ci-watch" };
  const first = await h.request<{ task: { id: string } }>("POST", "/schedules/command", body);
  const second = await h.request<{ task: { id: string } }>("POST", "/schedules/command", body);
  expect(second.body.task.id).toBe(first.body.task.id);
  expect((await h.request("POST", "/schedules/command", { ...body, prompt: "different" })).status).toBe(409);
  const other = h.project("other");
  expect((await h.request("POST", "/schedules/command", { ...body, directory: other })).status).toBe(409);
  const listed = await h.request<{ tasks: unknown[] }>("POST", "/schedules/command", { action: "list", directory: dir, session_id: sid });
  expect(listed.body.tasks).toHaveLength(1);
});

// Retirement-gap port (old schedule-preflight) through the ACTUAL runtime
// binding: a saved model or effort that disappeared after creation pauses the
// timer with its reason; the saved intent stays; no SDK call, no other model.
// A missing SDK model now reaches the authoritative worker alias resolver,
// rather than being rejected by a generic preflight before an equivalent Hub
// choice can be discovered. Failed resolution uses the existing bounded
// delivery-refusal budget; invalid known effort still pauses in preflight.
it("a vanished saved model or unsupported saved effort pauses the timer without SDK inference", async () => {
  h = await harness();
  const dir = h.project("vanished-target"), sid = await newSession(h, dir);
  const saved = [
    { title: "gone", model: h.model("large"), vanish: true },
    { title: "bad effort", model: { ...h.model("large"), variant: "turbo" }, vanish: false },
    { title: "no reasoning", model: { ...h.model("small"), variant: "high" }, vanish: false },
  ].map(({ title, model, vanish }) => {
    const task = h.runtime.scheduler.add({ directory: dir, sessionID: sid, title, prompt: `keep ${title}`, minutes: 5, mode: "once", runAt: Date.now() + 1000, model });
    if (vanish) h.runtime.db.run("UPDATE schedules SET body=json_set(body,'$.model.modelID','vanished-model') WHERE id=?", task.id);
    h.runtime.db.run("UPDATE schedules SET body=json_set(body,'$.nextAt',1) WHERE id=?", task.id);
    return task.id;
  });
  for (let i = 0; i < MAX_ATTEMPTS + saved.length - 1; i++) {
    // Advance only the explicit tick argument past the finite retry backoff;
    // no global fake clock and no real 15-second sleeps/provider calls.
    h.runtime.scheduler.tick(Date.now() + RETRY_MS * 2 ** MAX_ATTEMPTS + 1000);
    await h.runtime.dispatcher.settled();
  }
  const tasks = h.runtime.scheduler.list({ sessionID: sid }).tasks;
  for (const [index, id] of saved.entries()) {
    const task = tasks.find((t) => t.id === id)!;
    expect(task).toMatchObject({ enabled: false, state: "error", prompt: `keep ${["gone", "bad effort", "no reasoning"][index]}` });
    expect(task.detail).toMatch(index === 0 ? /vanished-model.*недоступна/ : /Режим «(turbo|high)» больше недоступен/);
  }
  expect(h.scripted.calls()).toBe(0);
  expect(h.runtime.ledger.open(sid)).toEqual([]);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const id = `schedule-${saved[0]}-1${attempt ? `-${attempt}` : ""}`;
    expect(h.runtime.ledger.get(id)).toMatchObject({ state: "rejected" });
    expect(h.runtime.ledger.getRequest(id)?.payload).toMatchObject({ model: { ...h.model("large"), modelID: "vanished-model" } });
  }
});
