// Window side of the runtime-owned prompt queue (src/state/promptQueue.ts via
// the store). The window mirrors queue state and forwards intent; it never
// dispatches. Dispatch-time invariants of the former window-owned queue (exactly
// once on idle with the captured model, refusal vs uncertain, Stop, fatal vs
// recoverable errors, busy/permission races, recovery) are tested on their new
// owner: src-tauri/resources/agent/test/queue-unit.test.ts and
// test/integration/queue.test.ts. Retired: the window's dispatch journal,
// preparation races and localStorage persistence of queues.
import { beforeEach, expect, it, vi } from "vitest";
import type { QueueItemDTO, QueueStateDTO } from "../src-tauri/resources/agent/src/protocol";
import { accessRules, accessMode } from "../src/state/access";
import { newMessageId } from "../src/state/queue";
import { isQueuePausingError } from "../src/state/promptQueue";
import type { RuntimeFixture } from "./helpers/runtime-fixture";

let store: any, fx: RuntimeFixture, queues: Record<string, QueueStateDTO>, Reply: typeof import("./helpers/runtime-fixture").RuntimeReply;
const model = { providerID: "p", modelID: "m", variant: "medium" };
const session = (id: string) => ({ id, directory: "/test", title: id, projectID: "p", time: { created: 1, updated: 1 } });
const state = (sid: string) => (queues[sid] ??= { sessionID: sid, armed: true, pausedReason: null, items: [] });
const item = (sid: string, body: { id: string; text: string; model: QueueItemDTO["model"] }): QueueItemDTO =>
  ({ id: body.id, sessionID: sid, directory: "/test", text: body.text, model: body.model, state: "ready", queuedAt: 1, commandId: null });
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  const fixture = await import("./helpers/runtime-fixture");
  Reply = fixture.RuntimeReply;
  store = (await import("../src/state/store")).store;
  fx = fixture.runtimeFixture();
  queues = {};
  fx.on("GET", "/sessions", () => [session("ses_a")]);
  fx.on("GET", "/sessions/status", () => ({ ses_a: { type: "busy" } }));
  fx.on("GET", "/sessions/:id/queue", c => state(c.params.id));
  fx.on("POST", "/sessions/:id/queue", c => {
    const q = state(c.params.id), body = c.body as { id: string; text: string; model: QueueItemDTO["model"] };
    if (!q.items.some(i => i.id === body.id)) q.items.push(item(c.params.id, body));
    return q;
  });
  fx.on("POST", "/sessions/:id/queue/resume", c => { const q = state(c.params.id); q.armed = true; q.pausedReason = null;
    const next = (c.body as { model?: QueueItemDTO["model"] }).model; if (next) q.items = q.items.map(i => ({ ...i, model: next })); return q; });
  fx.on("POST", "/sessions/:id/queue/pause", c => { const q = state(c.params.id); q.armed = false; return q; });
  fx.on("POST", "/sessions/:id/queue/:item/steer", c => ({ id: `queue-${c.params.item}-1`, kind: "steer", sessionID: c.params.id, state: "accepted", createdAt: 1, updatedAt: 1 }));
  fx.on("POST", "/sessions/:id/stop", () => ({ stopped: true }));
  fixture.withProvider(fx);
  fixture.bindStore(store, fx);
  await store.setDirectory("/test", { sessionId: "ses_a" });
  store.setModelChoice("p", "m", "medium");
});
const queuePosts = () => fx.made("POST", "/sessions/:id/queue");
const emitQueue = (q: QueueStateDTO) => fx.emit({ type: "queue.updated", properties: { sessionID: q.sessionID, queue: q } } as never, "/test");

it("a runtime refusal to store the item keeps the text draft and shows why", async () => {
  fx.on("POST", "/sessions/:id/queue", () => { throw new Reply(507, { message: "Не удалось сохранить очередь: диск заполнен." }); });
  store.setDraft("keep this task");
  expect(await store.enqueuePrompt("keep this task")).toBe(false);
  expect(store.getDraft()).toBe("keep this task");
  expect(store.getQueue()).toEqual([]);
  expect(store.state.ui.sendError).toContain("сохранить");
});

it("queues with the captured model, clears only the captured draft and never dispatches from the window", async () => {
  store.setDraft("next");
  expect(await store.enqueuePrompt("next")).toBe(true);
  expect(queuePosts()).toEqual([expect.objectContaining({ path: "/sessions/ses_a/queue", query: { directory: "/test" },
    body: { id: expect.stringMatching(/^msg_/), text: "next", parts: [], model } })]);
  expect(store.getDraft()).toBe("");
  store.setModelChoice("p", "other");
  expect(store.getQueue()[0].model).toEqual(model);
  expect(store.queueHasDifferentModel()).toBe(true);
  expect(fx.made("POST", "/commands")).toEqual([]);
});

it("a lost acknowledgement retries the add once under the same id; a second failure keeps the draft", async () => {
  let failures = 1;
  fx.on("POST", "/sessions/:id/queue", c => {
    if (failures-- > 0) throw new TypeError("connection reset");
    const q = state(c.params.id); q.items.push(item(c.params.id, c.body as never)); return q;
  });
  expect(await store.enqueuePrompt("once")).toBe(true);
  expect(new Set(queuePosts().map(c => (c.body as { id: string }).id)).size).toBe(1);
  expect(queuePosts()).toHaveLength(2);
  expect(store.getQueue()).toHaveLength(1);
  failures = 2; store.setDraft("twice");
  expect(await store.enqueuePrompt("twice")).toBe(false);
  expect(store.getDraft()).toBe("twice");
});

it("Now steers the running turn through the runtime, never stops it, and a double click is one correction", async () => {
  // PromptQueueController.steerQueued fences a chat's in-flight correction: the
  // second click sends nothing (previously a second POST the runtime refused).
  await store.enqueuePrompt("correction");
  const id = store.getQueue()[0].id;
  await Promise.all([store.steerQueued(id), store.steerQueued(id)]);
  expect(fx.made("POST", "/sessions/:id/queue/:item/steer").map(c => c.params.item)).toEqual([id]);
  expect(fx.made("POST", "/sessions/:id/stop")).toEqual([]);
  expect(fx.made("POST", "/commands")).toEqual([]);
  expect(store.state.ui.toast).toContain("Уточнение передано");
});

it("a scoped 409 on an item route shows the runtime's reason and re-reads this chat's queue once, without retrying", async () => {
  await store.enqueuePrompt("stale");
  const id = store.getQueue()[0].id;
  // Meanwhile the runtime no longer holds it for this chat.
  queues.ses_a.items = [];
  fx.on("DELETE", "/sessions/:id/queue/:item", () => { throw new Reply(409, { message: "Запрос очереди относится к другому чату." }); });
  const reads = fx.made("GET", "/sessions/:id/queue").length;
  await store.removeQueued(id);
  expect(store.state.ui.sendError).toBe("Запрос очереди относится к другому чату.");
  await vi.waitFor(() => expect(fx.made("GET", "/sessions/:id/queue").length).toBeGreaterThan(reads));
  await vi.waitFor(() => expect(store.getQueue()).toEqual([]));
  expect(fx.made("DELETE", "/sessions/:id/queue/:item")).toHaveLength(1);
  expect(fx.made("POST", "/commands")).toEqual([]);
});

it("a delayed item refusal from the previous host never refreshes or changes the new host's queue", async () => {
  await store.enqueuePrompt("old host item");
  const id = store.getQueue()[0].id;
  let refuse!: () => void;
  fx.on("DELETE", "/sessions/:id/queue/:item", () => new Promise((_, reject) => {
    refuse = () => reject(new Reply(409, { message: "Old host refusal" }));
  }));
  const removing = store.removeQueued(id);
  await vi.waitFor(() => expect(fx.made("DELETE", "/sessions/:id/queue/:item")).toHaveLength(1));
  const fixture = await import("./helpers/runtime-fixture");
  const next = fixture.runtimeFixture({ connection: { endpoint: "http://127.0.0.1:43124" }, workspace: "host-b" });
  const kept: QueueStateDTO = { ...state("ses_a"), items: [item("ses_a", { id: "host-b-item", text: "keep host B", model })] };
  fixture.bindStore(store, next, { queues: { ses_a: kept }, ui: { ...store.state.ui, sendError: null } });
  const oldReads = fx.made("GET", "/sessions/:id/queue").length;
  refuse(); await removing;
  expect(next.made("GET", "/sessions/:id/queue")).toEqual([]);
  expect(fx.made("GET", "/sessions/:id/queue")).toHaveLength(oldReads);
  expect(store.getQueue().map((q: { id: string }) => q.id)).toEqual(["host-b-item"]);
  expect(store.state.ui.sendError).toBeNull();
  expect(fx.made("DELETE", "/sessions/:id/queue/:item")).toHaveLength(1);
  expect(next.calls.filter(c => c.method !== "GET")).toEqual([]);
});

it("a captured queue read that finishes after a host reset cannot replace the new host's snapshot", async () => {
  let complete!: (value: QueueStateDTO) => void;
  fx.on("GET", "/sessions/:id/queue", () => new Promise<QueueStateDTO>(resolve => { complete = resolve; }));
  // Exercise the controller's actual public read with the real RuntimeClient;
  // await its completion so this negative assertion cannot race the response.
  const reading = store.promptQueue.refresh("ses_a", "/test");
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  const fixture = await import("./helpers/runtime-fixture");
  const next = fixture.runtimeFixture({ connection: { endpoint: "http://127.0.0.1:43124" }, workspace: "host-b" });
  const kept: QueueStateDTO = { ...state("ses_a"), items: [item("ses_a", { id: "host-b-item", text: "keep host B", model })] };
  fixture.bindStore(store, next, { queues: { ses_a: kept } });
  complete({ sessionID: "ses_a", armed: false, pausedReason: "stale host A", items: [] });
  await reading;
  expect(store.getQueue().map((q: { id: string }) => q.id)).toEqual(["host-b-item"]);
  expect(store.isQueueArmed()).toBe(true);
  expect(next.made("GET", "/sessions/:id/queue")).toEqual([]);
  expect(next.calls.filter(c => c.method !== "GET")).toEqual([]);
});

it.each(["remove", "acknowledge"] as const)("a delayed successful %s on host A cannot replace host B's queue", async (operation) => {
  await store.enqueuePrompt("host A item");
  const id = store.getQueue()[0].id, method = operation === "remove" ? "DELETE" : "POST";
  const route = `/sessions/:id/queue/:item${operation === "acknowledge" ? "/acknowledge" : ""}`;
  let complete!: (value: QueueStateDTO) => void;
  fx.on(method, route, () => new Promise<QueueStateDTO>(resolve => { complete = resolve; }));
  const pending = operation === "remove" ? store.removeQueued(id) : store.acknowledgeQueued(id, "drop");
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  const fixture = await import("./helpers/runtime-fixture");
  const next = fixture.runtimeFixture({ connection: { endpoint: "http://127.0.0.1:43124" }, workspace: "host-b" });
  const kept: QueueStateDTO = { ...state("ses_a"), items: [item("ses_a", { id: "host-b-item", text: "keep B", model })] };
  fixture.bindStore(store, next, { queues: { ses_a: kept } });
  complete({ sessionID: "ses_a", armed: false, pausedReason: "old A response", items: [] });
  await pending;
  expect(store.getQueue().map((q: { id: string }) => q.id)).toEqual(["host-b-item"]);
  expect(store.isQueueArmed()).toBe(true);
  expect(fx.made(method, route)).toHaveLength(1);
  expect(next.calls.filter(c => c.method !== "GET")).toEqual([]);
});

it("an old attachment edit's success and finalizer cannot clear a new host's same-chat operation lock", async () => {
  await store.enqueuePrompt("host A item");
  const id = store.getQueue()[0].id;
  const attached = { id: "file-a", name: "a.txt", mime: "text/plain", size: 1 };
  const oldQueue = { ...state("ses_a"), items: state("ses_a").items.map(q => ({ ...q, attachments: [attached] })) };
  emitQueue(oldQueue);
  let finishA!: (value: QueueStateDTO) => void;
  fx.on("PATCH", "/sessions/:id/queue/:item", () => new Promise<QueueStateDTO>(resolve => { finishA = resolve; }));
  const oldEdit = store.removeQueuedAttachment(id, "file-a");
  await vi.waitFor(() => expect(finishA).toBeTypeOf("function"));
  const fixture = await import("./helpers/runtime-fixture");
  const next = fixture.runtimeFixture({ connection: { endpoint: "http://127.0.0.1:43124" }, workspace: "host-b" });
  const kept: QueueStateDTO = { ...state("ses_a"), items: [{ ...item("ses_a", { id: "host-b-item", text: "keep B", model }), attachments: [{ ...attached, id: "file-b" }] }] };
  fixture.bindStore(store, next, { queues: { ses_a: kept }, ui: { ...store.state.ui, sendError: "host B operation pending" } });
  let finishB!: (value: QueueStateDTO) => void;
  next.on("PATCH", "/sessions/:id/queue/:item", () => new Promise<QueueStateDTO>(resolve => { finishB = resolve; }));
  const newEdit = store.removeQueuedAttachment("host-b-item", "file-b");
  await vi.waitFor(() => expect(finishB).toBeTypeOf("function"));
  finishA({ sessionID: "ses_a", armed: false, pausedReason: "old A", items: [] }); await oldEdit;
  expect(store.isQueueLocked()).toBe(true);
  expect(store.getQueue()[0]).toMatchObject({ id: "host-b-item", attachments: { files: [expect.objectContaining({ id: "file-b" })] } });
  expect(store.state.ui.sendError).toBe("host B operation pending");
  finishB({ ...kept, items: kept.items.map(q => ({ ...q, attachments: [] })) }); await newEdit;
  expect(store.isQueueLocked()).toBe(false);
  expect(store.getQueue()[0].id).toBe("host-b-item");
  expect(store.getQueue()[0].attachments).toBeUndefined();
  expect(fx.made("PATCH", "/sessions/:id/queue/:item")).toHaveLength(1);
  expect(next.made("PATCH", "/sessions/:id/queue/:item")).toHaveLength(1);
});

it("an old steer finalizer cannot remove the new host's double-click fence for the same session id", async () => {
  await store.enqueuePrompt("host A item");
  const id = store.getQueue()[0].id;
  let finishA!: (value: unknown) => void;
  fx.on("POST", "/sessions/:id/queue/:item/steer", () => new Promise(resolve => { finishA = resolve; }));
  const oldSteer = store.steerQueued(id);
  await vi.waitFor(() => expect(finishA).toBeTypeOf("function"));
  const fixture = await import("./helpers/runtime-fixture");
  const next = fixture.runtimeFixture({ connection: { endpoint: "http://127.0.0.1:43124" }, workspace: "host-b" });
  const kept: QueueStateDTO = { ...state("ses_a"), items: [item("ses_a", { id: "host-b-item", text: "keep B", model })] };
  fixture.bindStore(store, next, { queues: { ses_a: kept }, ui: { ...store.state.ui, toast: "host B notice" } });
  let finishB!: (value: unknown) => void;
  next.on("POST", "/sessions/:id/queue/:item/steer", () => new Promise(resolve => { finishB = resolve; }));
  const newSteer = store.steerQueued("host-b-item");
  await vi.waitFor(() => expect(finishB).toBeTypeOf("function"));
  const receipt = (key: string) => ({ id: key, kind: "steer", sessionID: "ses_a", state: "accepted", createdAt: 1, updatedAt: 1 });
  finishA(receipt("old-a")); await oldSteer;
  expect(store.state.ui.toast).toBe("host B notice");
  await store.steerQueued("host-b-item");
  expect(next.made("POST", "/sessions/:id/queue/:item/steer")).toHaveLength(1);
  finishB(receipt("new-b")); await newSteer;
  expect(store.state.ui.toast).toContain("Уточнение передано");
  expect(fx.made("POST", "/sessions/:id/queue/:item/steer")).toHaveLength(1);
});

it("armed, paused and recovery state come only from the runtime; explicit recovery may switch the model", async () => {
  await store.enqueuePrompt("first"); await store.enqueuePrompt("second");
  const paused = { ...state("ses_a"), armed: false, pausedReason: "Insufficient Balance" };
  emitQueue(paused);
  expect(store.isQueueArmed()).toBe(false);
  expect(store.queueRecoveryReason()).toContain("Недостаточно средств");
  store.setModelChoice("p", "other", "medium");
  expect(store.queueHasDifferentModel()).toBe(true);
  await store.resumeQueue(true);
  expect(fx.made("POST", "/sessions/:id/queue/resume")[0].body).toEqual({ model: { providerID: "p", modelID: "other", variant: "medium" } });
  expect(store.isQueueArmed()).toBe(true);
  expect(store.state.ui.sendError).toBeNull();
  await store.pauseQueue();
  expect(store.isQueueArmed()).toBe(false);
  await store.resumeQueue();
  expect(fx.made("POST", "/sessions/:id/queue/resume")[1].body).toEqual({});
  expect(fx.made("POST", "/commands")).toEqual([]);
});

it("reordering is optimistic, the runtime's answer is authoritative, and a refusal rolls it back", async () => {
  for (const text of ["a", "b", "c"]) await store.enqueuePrompt(text);
  const [a, b, c] = store.getQueue();
  fx.on("POST", "/sessions/:id/queue/reorder", req => {
    const q = state(req.params.id), body = req.body as { id: string; before: string | null };
    const moving = q.items.find(i => i.id === body.id)!, rest = q.items.filter(i => i.id !== body.id);
    rest.splice(body.before === null ? rest.length : rest.findIndex(i => i.id === body.before), 0, moving);
    q.items = rest; return q;
  });
  expect(store.reorderQueued(c.id, a.id)).toBe(true);
  expect(store.getQueue().map((i: { id: string }) => i.id)).toEqual([c.id, a.id, b.id]);
  await vi.waitFor(() => expect(fx.made("POST", "/sessions/:id/queue/reorder")).toHaveLength(1));
  fx.on("POST", "/sessions/:id/queue/reorder", () => { throw new Reply(409, { message: "Дождитесь отправки текущего запроса." }); });
  expect(store.reorderQueued(b.id, c.id)).toBe(true);
  await vi.waitFor(() => expect(store.getQueue().map((i: { id: string }) => i.id)).toEqual([c.id, a.id, b.id]));
  expect(store.state.ui.sendError).toContain("Дождитесь");
});

it("reordering cannot bypass a sending or uncertain item, missing IDs or an active send", async () => {
  await store.enqueuePrompt("a"); await store.enqueuePrompt("b");
  const [a, b] = store.getQueue();
  expect(store.reorderQueued(a.id, a.id)).toBe(false);
  expect(store.reorderQueued("missing", a.id)).toBe(false);
  expect(store.reorderQueued(a.id, "missing")).toBe(false);
  for (const blocked of ["sending", "uncertain"] as const) {
    emitQueue({ ...state("ses_a"), items: state("ses_a").items.map(i => (i.id === a.id ? { ...i, state: blocked } : i)) });
    expect(store.reorderQueued(b.id, a.id)).toBe(false);
  }
  emitQueue(state("ses_a"));
  store.state = { ...store.state, ui: { ...store.state.ui, sending: true } };
  expect(store.reorderQueued(b.id, a.id)).toBe(false);
  expect(fx.made("POST", "/sessions/:id/queue/reorder")).toEqual([]);
});

it("an uncertain item is reviewable: the user drops or re-queues it, nothing is replayed automatically", async () => {
  await store.enqueuePrompt("task");
  const [q] = state("ses_a").items;
  emitQueue({ ...state("ses_a"), armed: false, items: [{ ...q, state: "uncertain", error: "Доставка не подтверждена." }] });
  expect(store.getQueue()[0]).toMatchObject({ state: "uncertain", error: "Доставка не подтверждена." });
  fx.on("POST", "/sessions/:id/queue/:item/acknowledge", c => ({ ...state("ses_a"), items: (c.body as { action: string }).action === "drop" ? [] : [q] }));
  await store.acknowledgeQueued(q.id, "requeue");
  expect(store.getQueue()[0].state).toBe("ready");
  await store.acknowledgeQueued(q.id, "drop");
  expect(store.getQueue()).toEqual([]);
  expect(fx.made("POST", "/sessions/:id/queue/:item/acknowledge").map(c => c.body)).toEqual([{ action: "requeue" }, { action: "drop" }]);
  expect(fx.made("POST", "/commands")).toEqual([]);
});

// Remapped from the retired lossy migrateLegacyQueues (files/uncertain → draft
// text). The durable cutover keeps complete records, attachments and the
// uncertain state; the old copy leaves only per accepted receipt; nothing is
// replayed or turned into draft text, and a retry reuses the same ids.
it("old window-owned queues move once through the runtime cutover journal without replay or loss", async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } });
  store.state.prefs.queues = { ses_a: [
    { id: "ready", text: "later", directory: "/test", sessionID: "ses_a", model, state: "ready" },
    { id: "files", text: "with file", directory: "/test", sessionID: "ses_a", model, state: "ready", attachments: { scope: "x", files: [{ id: "f", name: "a.png", mime: "image/png", size: 1 }] } },
    { id: "sending", text: "maybe sent", directory: "/test", sessionID: "ses_a", model, state: "sending" },
  ] };
  store.setDraft("");
  vi.spyOn(store, "importLegacyHistory").mockResolvedValue(undefined);
  vi.spyOn(store, "legacyAttachmentParts").mockResolvedValue({ parts: [{ type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,AAAA" }], missing: 0 });
  const batches: Array<{ source: string; items: Array<{ legacyId: string; queue: Record<string, unknown> }> }> = [];
  fx.on("POST", "/migrations/cutover", c => {
    const batch = c.body as (typeof batches)[number]; batches.push(batch);
    return { receipts: batch.items.map(i => ({ id: `cut-${i.legacyId}`, legacyId: i.legacyId, kind: "queue", workspace: "w", state: i.legacyId === "files" ? "quarantined" : "accepted",
      sessionID: null, itemID: null, code: null, reason: null, retryable: true, updatedAt: 1 })) };
  });
  fx.on("GET", "/migrations/cutover", () => []);
  await store.migrateLegacyQueueState(fx.backend, store.connectionGeneration);
  expect(batches.map(b => b.source)).toEqual(["ui-queue"]);
  const [ready, files, sending] = batches[0].items;
  expect(ready.queue).toMatchObject({ text: "later", state: "ready", model, parts: [] });
  expect(files.queue).toMatchObject({ text: "with file", parts: [expect.objectContaining({ filename: "a.png" })] });
  expect(sending.queue).toMatchObject({ text: "maybe sent", state: "uncertain" });
  expect(store.state.prefs.queues.ses_a.map((i: { id: string }) => i.id)).toEqual(["files"]); // quarantined backup stays
  expect(queuePosts()).toEqual([]); expect(fx.made("POST", "/commands")).toEqual([]);
  expect(store.getDraft()).toBe("");
  await store.migrateLegacyQueueState(fx.backend, store.connectionGeneration);
  expect(batches[1].items.map(i => i.legacyId)).toEqual(["files"]);
});

it("classifies fatal or explicit-stop errors as pausing, recoverable ones as retryable", () => {
  expect(isQueuePausingError("Insufficient Balance")).toBe(true);
  expect(isQueuePausingError("The response was aborted.")).toBe(true);
  expect(isQueuePausingError("Достигнут лимит ответа модели. Можно сжать контекст и продолжить работу.")).toBe(false);
  expect(isQueuePausingError("Нет соединения с API модели. Проверьте подключение к сервису модели.")).toBe(false);
  expect(isQueuePausingError("Internal error")).toBe(false);
  expect(isQueuePausingError(null)).toBe(false);
});

it("routes delayed dictation to its own workspace even when tunnels reuse one loopback endpoint", () => {
  store.state.prefs.endpointState = { "ssh:previous": { drafts: { ses_a: "old draft" } } };
  store.setDraft("current draft");
  store.appendDictation("ssh:previous", "ses_a", "recognized");
  expect(store.getDraft()).toBe("current draft");
  expect(store.state.prefs.endpointState["ssh:previous"].drafts.ses_a).toBe("old draft recognized");
  store.appendDictation(store.state.prefs.workspaceKey, "ses_a", "here");
  expect(store.getDraft()).toBe("current draft here");
});

it("applies permission changes only to the selected session and refuses them while it is busy", async () => {
  fx.on("PATCH", "/sessions/:id", c => ({ ...session(c.params.id), ...(c.body as object) }));
  await store.setAccessMode("read");
  expect(fx.made("PATCH", "/sessions/:id")).toEqual([]);
  expect(store.state.ui.toast).toContain("Остановите");
  fx.emit({ type: "session.status", properties: { sessionID: "ses_a", status: { type: "idle" } } } as never, "/test");
  await store.setAccessMode("read");
  expect(fx.made("PATCH", "/sessions/:id")).toEqual([expect.objectContaining({ path: "/sessions/ses_a", query: { directory: "/test" }, body: { permission: accessRules("read") } })]);
  expect(store.getAccessMode()).toBe("read");
});

// Regression: the runtime re-decides a call PARKED on a tool permission by the
// new access (routes.ts PATCH /sessions/:id), but the window refused every
// change while busy, so "Полный доступ" could only be reached by stopping work.
it("while a tool waits for permission, choosing full access is sent once and the runtime's policy reply removes the card", async () => {
  fx.on("PATCH", "/sessions/:id", c => ({ ...session(c.params.id), ...(c.body as object) }));
  expect(store.accessChangeAllowed()).toBe(false); // busy and not parked: streaming keeps its access
  fx.emit({ type: "permission.asked", properties: { id: "per_1", sessionID: "ses_a", permission: "bash", patterns: ["npm test"] } } as never, "/test");
  expect(store.pendingInteraction("ses_a").permissions).toHaveLength(1);
  expect(store.accessChangeAllowed()).toBe(true);
  await store.setAccessMode("full");
  expect(fx.made("PATCH", "/sessions/:id")).toEqual([expect.objectContaining({ path: "/sessions/ses_a", body: { permission: accessRules("full") } })]);
  // No client reply is sent: the runtime settled the waiting call by policy.
  expect(fx.made("POST", "/permissions/:id/reply")).toEqual([]);
  fx.emit({ type: "permission.replied", properties: { sessionID: "ses_a", requestID: "per_1", reply: "once", by: "policy" } } as never, "/test");
  expect(store.pendingInteraction("ses_a").permissions).toEqual([]);
  expect(store.getAccessMode()).toBe("full");
  // A question (not a permission) does not unlock it: that turn is still in flight.
  fx.emit({ type: "question.asked", properties: { id: "que_1", sessionID: "ses_a", questions: [] } } as never, "/test");
  expect(store.accessChangeAllowed()).toBe(false);
});

it("access mapping is explicit and message IDs keep their width and ordering", async () => {
  expect(accessRules("full")[0]).toEqual({ permission: "*", pattern: "*", action: "allow" });
  expect(accessMode(accessRules("ask"))).toBe("ask");
  expect(accessMode([{ permission: "bash", pattern: "*", action: "deny" }])).toBe("custom");
  const a = newMessageId(), b = newMessageId();
  expect(a).toMatch(/^msg_[a-zA-Z0-9]{26}$/);
  expect(b > a).toBe(true);
  const { switchEndpointPrefs } = await import("../src/state/prefs");
  const sending = { id: "q", text: "task", directory: "/test", sessionID: "ses_a", model, state: "sending" as const };
  const original = { ...store.state.prefs, queues: { ses_a: [sending] } };
  const back = switchEndpointPrefs(switchEndpointPrefs(original, "http://127.0.0.1:4097"), original.endpoint, original.workspaceKey);
  expect(back.queues?.ses_a[0].state).toBe("uncertain");
});

it("a blocked Now operation explains itself and keeps the request", async () => {
  await store.enqueuePrompt("correction");
  fx.on("POST", "/sessions/:id/queue/:item/steer", () => { throw new Reply(409, { message: "В этом чате идёт другая операция. Запрос сохранён в очереди." }); });
  await store.steerQueued(store.getQueue()[0].id);
  expect(store.state.ui.sendError).toContain("Запрос сохранён в очереди");
  expect(store.getQueue()).toHaveLength(1);
  expect(store.getQueue()[0].state).toBe("ready");
});
