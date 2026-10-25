// Moving a long chat to a model with a smaller context: the runtime compacts
// with the CURRENT (larger) model first, verifies the bounded summary fits the
// target, and only then commits the switch. Full history stays visible; a
// summary that does not fit leaves the original model selected.
import { afterEach, expect, it } from "vitest";
import { fauxAssistantMessage, type FauxResponseStep } from "../../src/sdk/testing.ts";
import { harness, newSession, promptCommand, type Harness } from "../helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

async function longChat(h: Harness, dir: string): Promise<string> {
  h.runtime.saveSettings({ ...h.runtime.settings(), compaction: { enabled: true, keepRecentTokens: 64, reserveTokens: 64 } });
  const sid = await newSession(h, dir, { model: h.model("large") });
  // The final answer is the kept tail after compaction. The fit check now also
  // counts the system prompt and tool schemas, so the tail stays well inside
  // the small target (assertions below are unchanged).
  h.scripted.setResponses([fauxAssistantMessage("noted ".repeat(800)), fauxAssistantMessage("noted again ".repeat(100))]);
  await h.command(promptCommand(h, "long-1", sid, dir, "context ".repeat(4000)));
  await h.waitReceipt("long-1", ["completed"]);
  await h.command(promptCommand(h, "long-2", sid, dir, "more context ".repeat(2000)));
  await h.waitReceipt("long-2", ["completed"]);
  return sid;
}

/** The public SDK may make several source summary calls (main history and the
 *  split turn prefix). Provision enough identical deterministic responses and
 *  record which model served every call. */
const SUMMARY_STEPS = 6;
function sourceSummaries(h: Harness, text: string): string[] {
  const calls: string[] = [];
  const step: FauxResponseStep = async (_context, _options, _state, model) => {
    calls.push(model.id);
    return fauxAssistantMessage(text);
  };
  h.scripted.setResponses(Array.from({ length: SUMMARY_STEPS }, () => step));
  return calls;
}

it("compacts with the larger source model, then switches to the smaller target", async () => {
  h = await harness();
  const dir = h.project("transition");
  const sid = await longChat(h, dir);
  const calls = sourceSummaries(h, "Short summary of the task so far.");
  const command = { id: "move-small", kind: "model.transition" as const, sessionID: sid, directory: dir, payload: { model: h.model("small") } };
  expect((await h.command(command)).status).toBe(202);
  const receipt = await h.waitReceipt("move-small", ["completed", "failed"]);
  expect(receipt.error ?? null).toBeNull();
  expect(receipt.state).toBe("completed");
  // Only the source summarized; model.transition never runs a target turn.
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.length).toBeLessThan(SUMMARY_STEPS);
  expect(calls.every((id) => id === h.scripted.models.large)).toBe(true);
  expect(h.scripted.pending()).toBe(SUMMARY_STEPS - calls.length);
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.small);
  const history = await h.request<{ messages: Array<{ info: { role: string; summary?: boolean }; parts: Array<{ text?: string }> }> }>("GET", `/sessions/${sid}/messages`);
  expect(history.body.messages.some((m) => m.info.summary && m.parts.some((p) => p.text?.includes("Short summary")))).toBe(true);
  // Nothing was truncated from the visible history.
  expect(history.body.messages.filter((m) => m.info.role === "user")).toHaveLength(2);
});

it("does not commit the target when the summary does not fit", async () => {
  h = await harness();
  const dir = h.project("transition-fail");
  const sid = await longChat(h, dir);
  const calls = sourceSummaries(h, "verbose ".repeat(5000));
  await h.command({ id: "move-fail", kind: "model.transition", sessionID: sid, directory: dir, payload: { model: h.model("small") } });
  const receipt = await h.waitReceipt("move-fail", ["completed", "failed"]);
  expect(receipt.state).toBe("failed");
  expect(receipt.error).toMatch(/не помещается|переключение не выполнено/);
  // The intended fit rejection was reached, not an exhausted fixture queue.
  expect(receipt.error).not.toMatch(/faux responses/i);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.length).toBeLessThan(SUMMARY_STEPS);
  expect(calls.every((id) => id === h.scripted.models.large)).toBe(true);
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.large);
  const history = await h.request<{ messages: Array<{ info: { role: string } }> }>("GET", `/sessions/${sid}/messages`);
  expect(history.body.messages.filter((m) => m.info.role === "user")).toHaveLength(2);
});
