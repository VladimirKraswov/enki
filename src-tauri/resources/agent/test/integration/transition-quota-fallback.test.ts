// The owner's blocked scenario: a 1M-context paid model runs out of quota and
// the chat must move to a small local model. The source model cannot summarize
// (429), so the runtime probes it, offers the nearest OTHER provider's model
// that can hold the whole context, and — only with the user's explicit answer —
// compacts through it and finishes the transition. Full history stays intact;
// a declined offer leaves the original model selected.
import { afterEach, expect, it } from "vitest";
import { fauxAssistantMessage, type FauxResponseStep } from "../../src/sdk/testing.ts";
import { harness, newSession, promptCommand, type Harness } from "../helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

async function longChat(h: Harness, dir: string): Promise<string> {
  // SDK-internal transient-error retries are the SDK's own contract; this test
  // pins the fallback-model flow, so the quota verdict arrives without backoff.
  h.runtime.saveSettings({ ...h.runtime.settings(), retry: { enabled: false }, compaction: { enabled: true, keepRecentTokens: 64, reserveTokens: 64 } });
  const sid = await newSession(h, dir, { model: h.model("large") });
  h.scripted.setResponses([fauxAssistantMessage("noted ".repeat(800)), fauxAssistantMessage("noted again ".repeat(100))]);
  await h.command(promptCommand(h, "long-1", sid, dir, "context ".repeat(4000)));
  await h.waitReceipt("long-1", ["completed"]);
  await h.command(promptCommand(h, "long-2", sid, dir, "more context ".repeat(2000)));
  await h.waitReceipt("long-2", ["completed"]);
  return sid;
}

const QUOTA_429 = '429 {"error":{"type":"exceeded_current_quota_error","message":"You\'ve reached your 5-hour usage limit."},"type":"error"}';

/** Every source-model summarization call answers with the provider's quota
 *  error; the model id of each served call is recorded. */
function quotaExhausted(calls: string[]): FauxResponseStep {
  return async (_context, _options, _state, model) => {
    calls.push(model.id);
    return fauxAssistantMessage("", { stopReason: "error", errorMessage: QUOTA_429 });
  };
}

async function pendingQuestion(h: Harness, dir: string, receiptId = "move"): Promise<{ id: string; question: string }> {
  const until = Date.now() + 25_000;
  for (;;) {
    const list = await h.request<Array<{ id: string; questions: Array<{ question: string }> }>>("GET", `/questions?directory=${encodeURIComponent(dir)}`);
    const first = list.body[0];
    if (first) return { id: first.id, question: first.questions[0]!.question };
    const receipt = h.runtime.ledger.get(receiptId);
    if (receipt && ["failed", "rejected", "cancelled"].includes(receipt.state)) throw new Error(`transition ${receipt.state}: ${receipt.error}`);
    if (Date.now() > until) throw new Error("no pending question");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

it("after 429 on the source model, compacts with the offered provider's model and completes the switch", async () => {
  h = await harness({ altModel: true });
  const dir = h.project("quota-fallback");
  const sid = await longChat(h, dir);
  const served: string[] = [];
  h.scripted.setResponses(Array.from({ length: 6 }, () => quotaExhausted(served)));
  const altServed: string[] = [];
  const altSummary: FauxResponseStep = async (_context, _options, _state, model) => {
    altServed.push(model.id);
    return fauxAssistantMessage("Short summary of the task so far.");
  };
  h.scripted.setAltResponses(Array.from({ length: 6 }, () => altSummary));
  const command = { id: "move", kind: "model.transition" as const, sessionID: sid, directory: dir, payload: { model: h.model("small") } };
  expect((await h.command(command)).status).toBe(202);

  const asked = await pendingQuestion(h, dir);
  expect(asked.question).toContain(h.scripted.provider);
  expect(asked.question).toContain("Scripted alt huge");
  expect(asked.question).toMatch(/лимит/);
  expect((await h.request("POST", `/questions/${asked.id}/reply?directory=${encodeURIComponent(dir)}`, { answers: [["Сжать и продолжить"]] })).status).toBe(204);

  const receipt = await h.waitReceipt("move", ["completed", "failed"], 30_000);
  expect(receipt.error ?? null).toBeNull();
  expect(receipt.state).toBe("completed");
  expect(served.length).toBeGreaterThan(0);
  expect(served.every((id) => id === h.scripted.models.large)).toBe(true);
  expect(altServed.length).toBeGreaterThan(0);
  expect(altServed.every((id) => id === h.scripted.models.huge)).toBe(true);
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.small);
  const history = await h.request<{ messages: Array<{ info: { role: string; summary?: boolean }; parts: Array<{ text?: string }> }> }>("GET", `/sessions/${sid}/messages`);
  expect(history.body.messages.some((m) => m.info.summary && m.parts.some((p) => p.text?.includes("Short summary")))).toBe(true);
  expect(history.body.messages.filter((m) => m.info.role === "user")).toHaveLength(2);
});

it("a declined offer refuses the transition and keeps the original model selected", async () => {
  h = await harness({ altModel: true });
  const dir = h.project("quota-decline");
  const sid = await longChat(h, dir);
  h.scripted.setResponses(Array.from({ length: 6 }, () => quotaExhausted([])));
  const command = { id: "move", kind: "model.transition" as const, sessionID: sid, directory: dir, payload: { model: h.model("small") } };
  expect((await h.command(command)).status).toBe(202);
  const asked = await pendingQuestion(h, dir);
  expect((await h.request("POST", `/questions/${asked.id}/reply?directory=${encodeURIComponent(dir)}`, { answers: [["Отменить переход"]] })).status).toBe(204);
  const receipt = await h.waitReceipt("move", ["completed", "failed"], 30_000);
  expect(receipt.state).toBe("failed");
  expect(receipt.error).toMatch(/отклонено/);
  expect(h.scripted.altCalls()).toBe(0);
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.large);
});
