// Runtime-owned durable queue: items survive restart, drain in the user's
// order after each settled turn, can be reordered, steered into the running
// turn, stopped and resumed; fatal errors pause, recoverable ones continue.
import { afterEach, expect, it } from "vitest";
import { fauxAssistantMessage } from "../../src/sdk/testing.ts";
import { gate, harness, newSession, promptCommand, type Harness } from "../helpers.ts";
import { scriptedRuntime } from "../../src/sdk/testing.ts";
import path from "node:path";

let h: Harness;
afterEach(async () => { await h?.stop(); });

const userTexts = async (h: Harness, sid: string) => {
  const history = await h.request<{ messages: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }> }>("GET", `/sessions/${sid}/messages`);
  return history.body.messages.filter((m) => m.info.role === "user").map((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text).join(""));
};

it("drains in reordered order after the running turn settles", async () => {
  h = await harness();
  const dir = h.project("order");
  const sid = await newSession(h, dir);
  const hold = gate();
  h.scripted.setResponses([async () => { await hold.wait; return fauxAssistantMessage("first done"); }, fauxAssistantMessage("b done"), fauxAssistantMessage("a done")]);
  await h.command(promptCommand(h, "cmd-first", sid, dir, "first"));
  await h.waitReceipt("cmd-first", ["running"]);
  for (const id of ["item-a", "item-b"]) {
    const queued = await h.request<{ items: unknown[] }>("POST", `/sessions/${sid}/queue`, { id, text: id === "item-a" ? "A" : "B", model: h.model() });
    expect(queued.status).toBe(200);
  }
  // Re-enqueue with the same id after a lost response: still two items.
  expect((await h.request<{ items: unknown[] }>("POST", `/sessions/${sid}/queue`, { id: "item-a", text: "A", model: h.model() })).body.items).toHaveLength(2);
  const reordered = await h.request<{ items: Array<{ id: string }> }>("POST", `/sessions/${sid}/queue/reorder`, { id: "item-b", before: "item-a" });
  expect(reordered.body.items.map((i) => i.id)).toEqual(["item-b", "item-a"]);
  hold.open();
  for (let i = 0; i < 200 && (await h.request<{ items: unknown[] }>("GET", `/sessions/${sid}/queue`)).body.items.length; i++) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 300));
  expect(await userTexts(h, sid)).toEqual(["first", "B", "A"]);
});

// Remainder review: queue item ids are global; item routes must stay inside the scoped chat.
it("a queue item can be edited, removed, steered or acknowledged only through its own chat", async () => {
  h = await harness();
  const dir = h.project("queue-scope");
  const owner = await newSession(h, dir), other = await newSession(h, dir);
  const hold = gate();
  h.scripted.setResponses([async () => { await hold.wait; return fauxAssistantMessage("busy"); }, fauxAssistantMessage("later")]);
  await h.command(promptCommand(h, "scope-busy", owner, dir, "busy"));
  await h.waitReceipt("scope-busy", ["running"]);
  expect((await h.request("POST", `/sessions/${owner}/queue`, { id: "scoped-item", text: "mine", model: h.model() })).status).toBe(200);
  expect((await h.request("PATCH", `/sessions/${other}/queue/scoped-item`, { text: "hijacked" })).status).toBe(409);
  expect((await h.request("DELETE", `/sessions/${other}/queue/scoped-item`)).status).toBe(409);
  expect((await h.request("POST", `/sessions/${other}/queue/scoped-item/steer`, {})).status).toBe(409);
  expect((await h.request("POST", `/sessions/${other}/queue/scoped-item/acknowledge`, { action: "drop" })).status).toBe(409);
  const kept = await h.request<{ items: Array<{ id: string; text: string }> }>("GET", `/sessions/${owner}/queue`);
  expect(kept.body.items).toEqual([expect.objectContaining({ id: "scoped-item", text: "mine" })]);
  // The owning chat still manages it normally.
  expect((await h.request("PATCH", `/sessions/${owner}/queue/scoped-item`, { text: "edited" })).status).toBe(200);
  expect((await h.request("DELETE", `/sessions/${owner}/queue/scoped-item`)).status).toBe(200);
  expect(h.runtime.queue.hasWork(owner)).toBe(false);
  hold.open();
  await h.waitReceipt("scope-busy", ["completed", "failed"]);
});

it("Stop disarms and keeps queued items; resume continues; steering targets the running turn", async () => {
  h = await harness();
  const dir = h.project("stop");
  const sid = await newSession(h, dir);
  const hold = gate();
  h.scripted.setResponses([async () => { await hold.wait; return fauxAssistantMessage("interrupted"); }]);
  await h.command(promptCommand(h, "cmd-run", sid, dir, "work"));
  await h.waitReceipt("cmd-run", ["running"]);
  await h.request("POST", `/sessions/${sid}/queue`, { id: "later", text: "later", model: h.model() });
  // abort() waits for the turn to become idle; the scripted provider releases
  // its response only after the gate opens, as a slow model would.
  const stopping = h.request("POST", `/sessions/${sid}/stop`, {});
  await new Promise((r) => setTimeout(r, 50));
  hold.open();
  expect((await stopping).status).toBe(200);
  await h.waitReceipt("cmd-run", ["cancelled", "completed", "failed"]);
  const state = await h.request<{ armed: boolean; items: Array<{ id: string; state: string }> }>("GET", `/sessions/${sid}/queue`);
  expect(state.body.armed).toBe(false);
  expect(state.body.items.map((i) => i.id)).toEqual(["later"]);
  h.scripted.setResponses([fauxAssistantMessage("later done")]);
  await h.request("POST", `/sessions/${sid}/queue/resume`, {});
  for (let i = 0; i < 200 && (await h.request<{ items: unknown[] }>("GET", `/sessions/${sid}/queue`)).body.items.length; i++) await new Promise((r) => setTimeout(r, 25));
  expect((await userTexts(h, sid)).at(-1)).toBe("later");
});

it("a queued correction is steered into the running turn and marked as steering", async () => {
  h = await harness();
  const dir = h.project("steer");
  const sid = await newSession(h, dir);
  const hold = gate();
  h.scripted.setResponses([async () => { await hold.wait; return fauxAssistantMessage("working"); }, fauxAssistantMessage("corrected")]);
  await h.command(promptCommand(h, "cmd-steer-base", sid, dir, "task"));
  await h.waitReceipt("cmd-steer-base", ["running"]);
  await h.request("POST", `/sessions/${sid}/queue`, { id: "fix", text: "use tabs", model: h.model() });
  const steered = await h.request<{ id: string; kind: string }>("POST", `/sessions/${sid}/queue/fix/steer`, {});
  expect(steered.status).toBe(202);
  expect(steered.body.kind).toBe("steer");
  hold.open();
  await h.waitReceipt("cmd-steer-base", ["completed"]);
  await h.waitReceipt(steered.body.id, ["running", "completed"]);
  const history = await h.request<{ messages: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string; metadata?: Record<string, unknown> }> }> }>("GET", `/sessions/${sid}/messages`);
  const correction = history.body.messages.filter((m) => m.info.role === "user").at(-1)!;
  expect(correction.parts[0].text).toBe("use tabs");
  expect(correction.parts[0].metadata).toEqual({ arvelaSteering: 1 });
  expect((await h.request<{ items: unknown[] }>("GET", `/sessions/${sid}/queue`)).body.items).toHaveLength(0);
});

it("a fatal provider error pauses the queue; a recoverable one does not", async () => {
  h = await harness();
  const dir = h.project("errors");
  const sid = await newSession(h, dir);
  h.scripted.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Model returned malformed tool arguments" }), fauxAssistantMessage("next ok"),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "Insufficient balance" })]);
  for (const id of ["e1", "e2", "e3", "e4"]) await h.request("POST", `/sessions/${sid}/queue`, { id, text: id, model: h.model() });
  for (let i = 0; i < 300; i++) {
    const state = await h.request<{ armed: boolean; items: unknown[] }>("GET", `/sessions/${sid}/queue`);
    if (!state.body.armed) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const state = await h.request<{ armed: boolean; pausedReason: string | null; items: Array<{ id: string }> }>("GET", `/sessions/${sid}/queue`);
  expect(state.body.armed).toBe(false);
  expect(state.body.pausedReason).toMatch(/Insufficient balance/);
  expect(state.body.items.map((i) => i.id)).toEqual(["e4"]);
});

it("queued items and their prepared attachments survive a runtime restart", async () => {
  const data = (await import("../helpers.ts")).tempDir("queue-restart");
  const scripted = await scriptedRuntime(path.join(data, "scripted-agent"));
  h = await harness({ data, scripted });
  const dir = h.project("restart");
  const sid = await newSession(h, dir);
  await h.request("POST", `/sessions/${sid}/queue/pause`, {});
  await h.request("POST", `/sessions/${sid}/queue`, { id: "persisted", text: "see image", model: h.model("vision"),
    parts: [{ type: "file", mime: "image/png", filename: "pixel.png", url: "data:image/png;base64,iVBORw0KGgo=" }] });
  await h.request("POST", `/sessions/${sid}/queue/pause`, {});
  await h.stop();
  h = await harness({ data, scripted });
  const state = await h.request<{ items: Array<{ id: string; attachments?: Array<{ name: string; mime: string }> }> }>("GET", `/sessions/${sid}/queue`);
  expect(state.body.items).toEqual([expect.objectContaining({ id: "persisted", attachments: [expect.objectContaining({ name: "pixel.png", mime: "image/png" })] })]);
  let sawImage = false;
  h.scripted.setResponses([async (context) => {
    sawImage = JSON.stringify(context.messages).includes("iVBORw0KGgo=");
    return fauxAssistantMessage("seen");
  }]);
  await h.request("POST", `/sessions/${sid}/queue/resume`, {});
  for (let i = 0; i < 200 && (await h.request<{ items: unknown[] }>("GET", `/sessions/${sid}/queue`)).body.items.length; i++) await new Promise((r) => setTimeout(r, 25));
  expect(sawImage).toBe(true);
});
