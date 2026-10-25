// Runtime PromptQueue against an owned host. Carries the dispatch invariants
// of the retired window-owned queue (test/queue-access.test.ts,
// test/queue-attachments.test.ts): exactly-once delivery on idle with the
// captured model, refusal vs uncertain outcomes, Stop, fatal vs recoverable
// errors, steering, reorder/edit fences and prepared attachments. Written, NOT RUN.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandReceipt, PromptPart } from "../src/protocol.ts";
import { PromptQueue, QUEUE_LIMIT, type QueueHost } from "../src/queue/queue.ts";
import { AttachmentStore } from "../src/store/attachments.ts";
import { Database } from "../src/store/db.ts";
import { EventJournal } from "../src/store/events.ts";
import { tempDir } from "./helpers.ts";

const model = { providerID: "p", modelID: "m", variant: "medium" };
const PIXEL = "data:image/png;base64,iVBORw0KGgo=";
let db: Database, queue: PromptQueue, attachments: AttachmentStore;
let ready: boolean, streaming: boolean, submitted: Array<{ kind: string; commandId: string; itemId: string; parts: PromptPart[]; model: unknown }>;
const receipt = (id: string, state: CommandReceipt["state"], error?: string): CommandReceipt => ({ id, kind: "prompt", sessionID: "s1", state, createdAt: 1, updatedAt: 1, ...(error ? { error } : {}) });
const host: QueueHost = {
  ready: () => ready,
  streaming: () => streaming,
  submit: (kind, item) => { submitted.push({ kind, ...item }); return receipt(item.commandId, "accepted"); },
};
const add = (id: string, text = id, parts: PromptPart[] = []) => queue.enqueue("s1", "/p", { id, text, parts, model });
const items = () => queue.state("s1").items.map(i => [i.id, i.state]);

beforeEach(() => {
  const root = tempDir("queue-unit");
  db = new Database(path.join(root, "runtime.db"));
  attachments = new AttachmentStore(db, root);
  queue = new PromptQueue(db, new EventJournal(db), attachments);
  queue.bind(host);
  ready = false; streaming = false; submitted = [];
});
afterEach(() => db.close());

describe("delivery", () => {
  it("queues while busy, sends exactly once when the session settles idle, with the captured model", () => {
    add("q1", "first");
    expect(submitted).toEqual([]);
    expect(queue.state("s1")).toMatchObject({ armed: true, pausedReason: null });
    ready = true;
    queue.onSettled("s1", null);
    queue.onSettled("s1", null);
    expect(submitted).toEqual([expect.objectContaining({ kind: "prompt", commandId: "queue-q1-1", itemId: "q1", model, parts: [{ type: "text", text: "first" }] })]);
    expect(items()).toEqual([["q1", "sending"]]);
    queue.onReceipt(receipt("queue-q1-1", "running"));
    expect(items()).toEqual([]);
    queue.onSettled("s1", null);
    expect(submitted).toHaveLength(1);
  });

  it("enqueue is idempotent by item id, never shared across chats, and bounded", () => {
    add("q1"); add("q1");
    expect(items()).toEqual([["q1", "ready"]]);
    expect(() => queue.enqueue("s2", "/p", { id: "q1", text: "x", parts: [], model })).toThrow("уже занят");
    for (let i = 2; i <= QUEUE_LIMIT; i++) add(`q${i}`);
    expect(() => add("over")).toThrow(String(QUEUE_LIMIT));
  });

  it("drains in the user's order, one item per settled turn", () => {
    add("a"); add("b"); add("c");
    queue.reorder("s1", "c", "a");
    ready = true;
    queue.drain("s1");
    queue.onReceipt(receipt("queue-c-1", "running"));
    queue.onSettled("s1", null);
    queue.onReceipt(receipt("queue-a-1", "completed"));
    queue.onSettled("s1", null);
    expect(submitted.map(s => s.itemId)).toEqual(["c", "a", "b"]);
  });
});

describe("refusal, uncertainty and Stop", () => {
  it("a definite refusal returns the item to ready and pauses with the reason; resume retries under a new attempt id", () => {
    add("q1"); ready = true; queue.drain("s1");
    queue.onReceipt(receipt("queue-q1-1", "rejected", "Модель недоступна"));
    expect(queue.state("s1")).toMatchObject({ armed: false, pausedReason: "Модель недоступна", items: [expect.objectContaining({ id: "q1", state: "ready", error: "Модель недоступна" })] });
    queue.onSettled("s1", null);
    expect(submitted).toHaveLength(1);
    queue.resume("s1");
    expect(submitted.map(s => s.commandId)).toEqual(["queue-q1-1", "queue-q1-2"]);
  });

  it("an uncertain outcome is kept for review, blocks the queue and is never replayed until the user decides", () => {
    add("q1"); add("q2"); ready = true; queue.drain("s1");
    queue.onReceipt(receipt("queue-q1-1", "uncertain", "Среда выполнения остановилась"));
    expect(items()).toEqual([["q1", "uncertain"], ["q2", "ready"]]);
    queue.resume("s1"); queue.onSettled("s1", null);
    expect(submitted).toHaveLength(1);
    expect(() => queue.steer("q1")).toThrow("уже отправляется");
    expect(() => queue.reorder("s1", "q2", "q1")).toThrow();
    queue.acknowledge("q1", "drop");
    expect(items()).toEqual([["q2", "ready"]]);
    queue.resume("s1");
    expect(submitted.map(s => s.itemId)).toEqual(["q1", "q2"]);
  });

  it("Stop disarms; a withdrawn gated item returns to ready without an error and is not resent by itself", () => {
    add("q1"); ready = true; queue.drain("s1");
    queue.stop("s1");
    queue.onReceipt(receipt("queue-q1-1", "cancelled"));
    expect(queue.state("s1")).toMatchObject({ armed: false, pausedReason: null, items: [expect.objectContaining({ id: "q1", state: "ready" })] });
    expect(queue.state("s1").items[0].error).toBeUndefined();
    queue.onSettled("s1", null);
    expect(submitted).toHaveLength(1);
  });

  it("fatal provider errors and explicit stops pause; recoverable errors keep draining", () => {
    add("a"); add("b"); add("c"); ready = true;
    queue.drain("s1"); queue.onReceipt(receipt("queue-a-1", "running"));
    queue.onSettled("s1", "context length exceeded");
    expect(submitted.map(s => s.itemId)).toEqual(["a", "b"]);
    queue.onReceipt(receipt("queue-b-1", "running"));
    queue.onSettled("s1", "Insufficient balance");
    expect(queue.state("s1")).toMatchObject({ armed: false, pausedReason: "Insufficient balance" });
    expect(submitted).toHaveLength(2);
  });

  it("after a restart a sending item without a durable receipt is ready again; one with a receipt is delivered", () => {
    add("lost"); add("kept"); ready = true; queue.drain("s1");
    // No ledger entry: the SDK never received it, so it may run again.
    queue.recover(() => null);
    expect(items()).toEqual([["lost", "ready"], ["kept", "ready"]]);
    queue.drain("s1");
    queue.recover(id => (id === "queue-lost-2" ? receipt(id, "running") : null));
    expect(items()).toEqual([["kept", "ready"]]);
  });
});

describe("steering, editing and attachments", () => {
  it("steers a running turn without aborting it, starts an idle chat, refuses a busy non-streaming one and a second click", () => {
    add("fix", "use tabs");
    streaming = true;
    queue.steer("fix");
    expect(submitted).toEqual([expect.objectContaining({ kind: "steer", itemId: "fix" })]);
    expect(() => queue.steer("fix")).toThrow("уже отправляется");
    add("next"); streaming = false; ready = false;
    expect(() => queue.steer("next")).toThrow("другая операция");
    ready = true;
    queue.steer("next");
    expect(submitted.map(s => s.kind)).toEqual(["steer", "prompt"]);
  });

  it("editing keeps the position and captured model unless replaced, and is refused once sending", () => {
    add("a", "old text"); add("b");
    queue.edit("a", { text: "  new text  " });
    expect(queue.state("s1").items.map(i => [i.id, i.text, i.model])).toEqual([["a", "new text", model], ["b", "b", model]]);
    queue.edit("b", { model: { providerID: "p", modelID: "other" } });
    expect(queue.state("s1").items[1].model).toEqual({ providerID: "p", modelID: "other" });
    ready = true; queue.drain("s1");
    expect(() => queue.edit("a", { text: "late" })).toThrow("уже отправляется");
    expect(() => queue.remove("a")).toThrow("уже отправляется");
    expect(queue.remove("b")).toMatchObject({ items: [expect.objectContaining({ id: "a" })] });
  });

  it("stores prepared files with the item, sends them once, and removes only the chosen file", () => {
    add("files", "смотри", [{ type: "file", mime: "image/png", filename: "a.png", url: PIXEL }, { type: "file", mime: "image/png", filename: "b.png", url: PIXEL }]);
    const refs = queue.state("s1").items[0].attachments!;
    expect(refs.map(r => r.name)).toEqual(["a.png", "b.png"]);
    queue.edit("files", { removeAttachments: [refs[0].id] });
    expect(queue.state("s1").items[0].attachments!.map(r => r.name)).toEqual(["b.png"]);
    ready = true; queue.drain("s1");
    expect(submitted[0].parts).toEqual([{ type: "text", text: "смотри" }, { type: "file", mime: "image/png", filename: "b.png", url: PIXEL }]);
  });

  it("a file-only entry gets a neutral instruction and a missing stored file pauses before anything is sent", () => {
    add("only", "   ", [{ type: "file", mime: "image/png", filename: "a.png", url: PIXEL }]);
    expect(queue.state("s1").items[0].text).toBe("Проанализируй приложенные файлы.");
    attachments.release("queue:only");
    ready = true;
    expect(() => queue.drain("s1")).toThrow("не найдено");
    expect(submitted).toEqual([]);
    expect(queue.state("s1")).toMatchObject({ armed: false, items: [expect.objectContaining({ id: "only", state: "ready", error: expect.stringContaining("не найдено") })] });
  });
});
