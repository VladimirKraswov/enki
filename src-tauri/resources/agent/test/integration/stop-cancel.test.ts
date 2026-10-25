// Explicit Stop of the exact active run is recorded as "cancelled", even when
// the SDK closes the turn with stopReason "error" (Stop while a question
// waits). The marker never leaks: the next turn's genuine provider error is
// still "failed", and Stop after a run settled changes nothing.
import { afterEach, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "../../src/sdk/testing.ts";
import { harness, newSession, promptCommand, stream, type Harness } from "../helpers.ts";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

const QUESTION = [{ question: "Which region?", header: "Region", options: [{ label: "eu" }, { label: "us" }], custom: false }];

it("Stop during a pending question is cancelled, not failed; later genuine errors keep failing", async () => {
  h = await harness();
  const dir = h.project("stop-question");
  const sid = await newSession(h, dir);
  const client = stream(h, `directory=${encodeURIComponent(dir)}`);
  await client.hello;
  h.scripted.setResponses([
    fauxAssistantMessage([fauxToolCall("question", { questions: QUESTION })], { stopReason: "toolUse" }),
    fauxAssistantMessage("must never be requested"),
  ]);
  await h.command(promptCommand(h, "stop-1", sid, dir, "ask me"));
  const asked = await client.waitFor(e => e.event.type === "question.asked");
  const requestID = (asked.event.properties as { id?: unknown }).id;
  expect(typeof requestID).toBe("string");
  const callsBefore = h.scripted.calls();
  expect((await h.request("POST", `/sessions/${sid}/stop`, {})).status).toBe(200);
  const stopped = await h.waitReceipt("stop-1", ["cancelled", "failed", "completed"]);
  expect(stopped.state).toBe("cancelled");
  expect(h.scripted.calls()).toBe(callsBefore); // no next scripted provider step
  // The durable rejection is published before/after the receipt settles; await
  // that exact event instead of sampling the SSE buffer at receipt time.
  const rejected = await client.waitFor(e => e.event.type === "question.rejected" && (e.event.properties as { requestID?: unknown }).requestID === requestID);
  expect(rejected.event.properties).toMatchObject({ sessionID: sid, requestID, by: "cancelled" });
  expect((await h.request<{ idle: boolean }>("GET", "/runtime/idle")).body.idle).toBe(true);

  // Stop after settlement is a no-op for that receipt.
  await h.request("POST", `/sessions/${sid}/stop`, {});
  expect(h.runtime.ledger.get("stop-1")?.state).toBe("cancelled");

  // The next turn inherits no marker: a genuine provider error stays "failed".
  h.scripted.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "synthetic provider failure" })]);
  await h.command(promptCommand(h, "stop-2", sid, dir, "again"));
  const failed = await h.waitReceipt("stop-2", ["cancelled", "failed", "completed"]);
  expect(failed.state).toBe("failed");
  expect(failed.error).toMatch(/synthetic provider failure/);
  client.close();
});
