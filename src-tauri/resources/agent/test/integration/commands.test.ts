// Idempotent commands: a retried POST after a lost acknowledgement returns the
// original receipt and never executes the turn (or its tools) a second time.
import { afterEach, expect, it } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "../../src/sdk/testing.ts";
import { extension, harness, newSession, ownedText, promptCommand, type Harness } from "../helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

it("duplicate command ids return the same receipt and run exactly once", async () => {
  h = await harness();
  const dir = h.project("dup");
  const sid = await newSession(h, dir);
  h.scripted.setResponses([fauxAssistantMessage("once")]);
  const command = promptCommand(h, "cmd-dup", sid, dir, "run once");
  const first = await h.command(command);
  expect(first.status).toBe(202);
  const again = await h.command(command);
  expect(again.status).toBe(200);
  expect(again.body.id).toBe("cmd-dup");
  expect(again.body.duplicate).toBe(true);
  await h.waitReceipt("cmd-dup", ["completed"]);
  const third = await h.command(command);
  expect(third.body.state).toBe("completed");
  expect(h.scripted.calls()).toBe(1);
  // Same id with different content is a conflict, not a second turn.
  if (command.kind !== "prompt" && command.kind !== "steer") throw new Error("Expected prompt fixture");
  const conflict = await h.command({ ...command, payload: { ...command.payload, parts: [{ type: "text", text: "different" }] } });
  expect(conflict.status).toBe(409);
  expect(h.scripted.calls()).toBe(1);
});

it("a lost ACK during a tool turn cannot repeat the tool's side effect", async () => {
  let executions = 0;
  h = await harness({
    extraExtensions: () => [extension("counter", (pi) => pi.registerTool({
      name: "side_effect", label: "Side effect", description: "Counts executions", parameters: Type.Object({}),
      execute: async () => { executions++; return { content: [{ type: "text", text: `executed ${executions}` }], details: {} }; },
    }))],
  });
  const dir = h.project("ack");
  const sid = await newSession(h, dir, { permission: [{ permission: "*", pattern: "*", action: "allow" }] });
  h.scripted.setResponses([fauxAssistantMessage([fauxToolCall("side_effect", {})], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  const command = promptCommand(h, "cmd-ack", sid, dir, "do it");
  // Simulate a client whose acknowledgement was lost: it never reads the first
  // response and retries the identical request while the turn runs.
  const lost = ownedText(`${h.base}/commands`, { method: "POST", headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" }, body: JSON.stringify(command) }, h);
  const retry = await h.command(command);
  await lost;
  expect([200, 202]).toContain(retry.status);
  await h.waitReceipt("cmd-ack", ["completed"]);
  await h.command(command);
  expect(executions).toBe(1);
  expect(h.runtime.ledger.get("cmd-ack")?.entryId).toBeTruthy();
});

it("validates commands strictly and never guesses", async () => {
  h = await harness();
  const dir = h.project("validate");
  const sid = await newSession(h, dir);
  for (const bad of [{}, { id: "x", kind: "prompt" }, { id: "ok-1", kind: "prompt", sessionID: sid, directory: dir, payload: { parts: [], model: h.model() } },
    { id: "ok-2", kind: "launch-missiles", sessionID: sid, directory: dir, payload: {} },
    { id: "../etc", kind: "abort", sessionID: sid, directory: dir, payload: {} }]) {
    const response = await h.request("POST", "/commands", bad);
    expect(response.status).toBe(400);
  }
  expect(h.scripted.calls()).toBe(0);
});
