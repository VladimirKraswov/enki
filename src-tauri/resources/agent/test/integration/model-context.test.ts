// Every path that changes the SDK model (ordinary prompt, durable queue, timer
// wake, model.set) goes through the worker's ONE transition: when the context
// does not fit the smaller target, the CURRENT (larger) model summarizes first,
// the bounded result is verified against the target's own metadata, and only
// then the target becomes resident and may answer. History is never dropped.
import { afterEach, expect, it } from "vitest";
import { wakeText } from "../../src/policy/prompt.ts";
import { fauxAssistantMessage, type FauxResponseStep } from "../../src/sdk/testing.ts";
import { ContextTransitionError, promptTokens, targetBudget } from "../../src/sessions/worker.ts";
import { gate, harness, newSession, promptCommand, type Harness } from "../helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

/** Two long turns on the large model; the short final answer is the kept tail.
 *  Command IDs are globally idempotent, so each chat gets its own. */
async function longChat(h: Harness, dir: string, tail = "noted again ".repeat(100)): Promise<string> {
  h.runtime.saveSettings({ ...h.runtime.settings(), compaction: { enabled: true, keepRecentTokens: 64, reserveTokens: 64 } });
  const sid = await newSession(h, dir, { model: h.model("large") });
  h.scripted.setResponses([fauxAssistantMessage("noted ".repeat(800)), fauxAssistantMessage(tail)]);
  for (const [n, text] of [[1, "context ".repeat(4000)], [2, "more context ".repeat(2000)]] as const) {
    const id = `long-${n}-${sid}`;
    const accepted = await h.command(promptCommand(h, id, sid, dir, text, h.model("large")));
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({ id, sessionID: sid });
    expect(accepted.body.duplicate).not.toBe(true);
    expect(await h.waitReceipt(id, ["completed", "failed", "rejected"])).toMatchObject({ id, sessionID: sid, state: "completed" });
  }
  const history = await h.request<{ messages: Array<{ info: { role: string } }> }>("GET", `/sessions/${sid}/messages`);
  expect(history.body.messages.map((m) => m.info.role)).toEqual(["user", "assistant", "user", "assistant"]);
  return sid;
}

/** Records which scripted model served each provider call, in order, and
 *  whether the call was an SDK summarization request (its fixed system prompt)
 *  rather than a conversational turn. */
type Calls = string[] & { summaries: boolean[] };
function recorder(h: Harness, summary = "Short summary of the task so far.", before: FauxResponseStep[] = []): Calls {
  // Non-enumerable: existing `toEqual([...model ids])` assertions stay exact.
  const calls = Object.defineProperty([] as string[], "summaries", { value: [] as boolean[], enumerable: false }) as Calls;
  const step: FauxResponseStep = async (context, _options, _state, model) => {
    const summarizing = /context summarization assistant/i.test(context.systemPrompt ?? "");
    calls.push(model.id); calls.summaries.push(summarizing);
    return fauxAssistantMessage(model.id === h.scripted.models.small && !summarizing ? "small answer" : summary);
  };
  h.scripted.setResponses([...before, ...Array.from({ length: 6 }, () => step)]);
  return calls;
}

/** Source summarizes first; then EXACTLY one target turn answers. Only the SDK's
 *  own post-answer summaries of the new (small-window) context may follow it —
 *  never a second turn, a replayed prompt or another model. */
function sourceThenTarget(h: Harness, calls: Calls, target = h.scripted.models.small): void {
  const small = calls.indexOf(target);
  expect(small).toBeGreaterThan(0);
  expect(calls.slice(0, small).every((id) => id === h.scripted.models.large)).toBe(true);
  expect(calls.summaries[small]).toBe(false);
  const after = calls.slice(small + 1);
  expect(after.every((id, index) => id === target && calls.summaries[small + 1 + index])).toBe(true);
}

type Transition = { phase: string; operation?: string | null; tokens?: number; incoming?: number; limit?: number; window?: number;
  system?: number; tools?: number; tokensAfter?: number | null; compacted?: boolean; code?: string };
/** The worker's own projected transition phases for one operation (durable journal). */
function transitions(h: Harness, sid: string, after: number, operation: string): Transition[] {
  return (h.runtime.journal.replay({ all: true, sessionID: sid }, after) ?? [])
    .filter((e) => e.event.type === "session.context_transition" && e.event.properties.operation === operation)
    .map((e) => e.event.properties as Transition);
}

/** The complete shipped system/tools fit comfortably, but the actual history
 *  does NOT: successful source-first compaction must still be necessary. */
function verifiedSmallSummaryFit(h: Harness, sid: string, after: number, operation: string, incoming: number): void {
  const phases = transitions(h, sid, after, operation);
  const planning = phases.find((phase) => phase.phase === "planning");
  const ready = phases.find((phase) => phase.phase === "ready");
  expect(planning).toBeDefined();
  expect(ready).toBeDefined();
  const target = targetBudget({ contextWindow: 8_000, maxTokens: 512 });
  expect(target.limit).toBe(7_488);
  expect(target.limit).toBeLessThan(targetBudget({ contextWindow: 200_000, maxTokens: 8_000 }).limit);
  expect(planning).toMatchObject({ window: 8_000, limit: target.limit, incoming });
  expect(planning!.system!).toBeGreaterThan(0);
  expect(planning!.tools!).toBeGreaterThan(0);
  expect(planning!.system! + planning!.tools! + incoming).toBeLessThan(target.limit - 2_000);
  expect(planning!.tokens! + incoming).toBeGreaterThan(target.limit);
  expect(phases.some((phase) => phase.phase === "summarizing")).toBe(true);
  expect(ready!.compacted).toBe(true);
  expect(ready!.tokensAfter! + incoming).toBeLessThanOrEqual(target.limit);
}

/** One once-timer occurrence to `model`, ticked and waited for; returns its operation id. */
async function wake(h: Harness, sid: string, prompt: string, model: ReturnType<Harness["model"]>): Promise<{ id: string; operation: string }> {
  const created = await h.request<{ id: string; nextAt: number }>("POST", "/schedules", { directory: h.runtime.catalog.get(sid)!.directory, sessionID: sid, title: "wake", prompt, minutes: 5, mode: "once", runAt: Date.now() + 10, model });
  expect(created.status).toBe(200);
  await new Promise((r) => setTimeout(r, 30));
  h.runtime.scheduler.tick();
  return { id: created.body.id, operation: `schedule-${created.body.id}-${created.body.nextAt}` };
}

async function users(h: Harness, sid: string): Promise<{ users: number; summary: boolean }> {
  const history = await h.request<{ messages: Array<{ info: { role: string; summary?: boolean } }> }>("GET", `/sessions/${sid}/messages`);
  return { users: history.body.messages.filter((m) => m.info.role === "user").length, summary: history.body.messages.some((m) => m.info.summary === true) };
}

it("an ordinary prompt to a smaller model summarizes with the source model before the target answers", async () => {
  h = await harness();
  const dir = h.project("ctx-prompt");
  const sid = await longChat(h, dir);
  const calls = recorder(h);
  const cursor = h.runtime.journal.head;
  await h.command(promptCommand(h, "to-small", sid, dir, "continue here", h.model("small")));
  expect((await h.waitReceipt("to-small", ["completed", "failed", "rejected"])).state).toBe("completed");
  sourceThenTarget(h, calls);
  verifiedSmallSummaryFit(h, sid, cursor, "to-small", promptTokens({ text: "continue here", images: [] }));
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.small);
  expect(await users(h, sid)).toEqual({ users: 3, summary: true });
});

it("a queued prompt and a timer wake use the same source-first transition", async () => {
  h = await harness();
  const dir = h.project("ctx-queue");
  const sid = await longChat(h, dir);
  const hold = gate();
  const calls = recorder(h, undefined, [async () => { await hold.wait; return fauxAssistantMessage("held"); }]);
  await h.command(promptCommand(h, "held", sid, dir, "hold", h.model("large")));
  await h.waitReceipt("held", ["running"]);
  const queueCursor = h.runtime.journal.head;
  expect((await h.request("POST", `/sessions/${sid}/queue`, { id: "q-small", text: "queued small", model: h.model("small") })).status).toBe(200);
  hold.open();
  for (let i = 0; i < 400 && !calls.includes(h.scripted.models.small); i++) await new Promise((r) => setTimeout(r, 25));
  sourceThenTarget(h, calls);
  verifiedSmallSummaryFit(h, sid, queueCursor, "queue-q-small-1", promptTokens({ text: "queued small", images: [] }));
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.small);

  // Timer stage. The wake marker adds to the pending prompt. Keep this success
  // fixture on the 16k target, still smaller than the source and forced to
  // summarize first, with measured headroom for the complete shipped system,
  // tools, summary, kept tail and wake. The small target is now 8k so the full
  // tool set fits; the independent effective-4k floor refusal remains below.
  const sid2 = await longChat(h, h.project("ctx-timer"));
  const timerCalls = recorder(h);
  const cursor = h.runtime.journal.head;
  const prompt = "wake medium";
  const { id: taskId, operation } = await wake(h, sid2, prompt, h.model("medium"));
  expect((await h.waitReceipt(operation, ["completed", "failed", "rejected"])).state).toBe("completed");
  sourceThenTarget(h, timerCalls, h.scripted.models.medium);
  expect(h.runtime.catalog.get(sid2)?.model?.modelID).toBe(h.scripted.models.medium);
  const phases = transitions(h, sid2, cursor, operation);
  const planning = phases.find((p) => p.phase === "planning")!, ready = phases.find((p) => p.phase === "ready")!;
  expect(phases.map((p) => p.phase)).toEqual(["planning", "summary_model", "summarizing", "verifying", "target_model", "ready"]);
  const target = targetBudget({ contextWindow: 16_000, maxTokens: 512 });
  expect(target.limit).toBeLessThan(targetBudget({ contextWindow: 200_000, maxTokens: 8_000 }).limit);
  // The fitted prompt is the exact pending wake (user text + hidden marker).
  const incoming = promptTokens({ text: wakeText(sid2, taskId, prompt), images: [] });
  expect(incoming).toBeGreaterThan(promptTokens({ text: prompt, images: [] }) + 50);
  expect(planning).toMatchObject({ incoming, limit: target.limit, window: 16_000 });
  // Large → smaller is genuinely forced: the history does not fit as is.
  expect(planning.tokens! + incoming).toBeGreaterThan(target.limit);
  // System + tools + wake cannot shrink; they leave room for a summary.
  expect(planning.system!).toBeGreaterThan(0);
  expect(planning.tools!).toBeGreaterThan(0);
  expect(planning.system! + planning.tools! + incoming).toBeLessThan(target.limit);
  // Verified after the summary: max(usage, estimate) of the next request
  // (system + tools + summary + kept tail) plus the wake, with real headroom.
  expect(ready.compacted).toBe(true);
  expect(ready.tokensAfter!).toBeGreaterThan(planning.system! + planning.tools!);
  expect(ready.tokensAfter! + incoming).toBeLessThanOrEqual(target.limit - 4_000);
  expect(await users(h, sid2)).toEqual({ users: 3, summary: true });
});

// The separate fail-closed side of the timer path: a summarized context that
// still does not fit the 8k target is refused before ANY target call, the
// target is not selected and the original transcript stays; nothing is
// dispatched to the small model and the occurrence is not reported as sent.
it("a timer wake whose summarized context cannot fit the target is refused without a target call", async () => {
  h = await harness();
  const sid = await longChat(h, h.project("ctx-timer-nofit"));
  const calls = recorder(h, "verbose ".repeat(5000));
  const cursor = h.runtime.journal.head;
  const { operation } = await wake(h, sid, "wake small", h.model("small"));
  const receipt = await h.waitReceipt(operation, ["completed", "failed", "rejected"]);
  expect(receipt.state).toBe("rejected");
  expect(receipt.error).toMatch(/не помещается/);
  expect(calls).not.toContain(h.scripted.models.small);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((id) => id === h.scripted.models.large)).toBe(true);
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.large);
  const phases = transitions(h, sid, cursor, operation);
  const failed = phases.find((p) => p.phase === "failed")!;
  expect(failed).toMatchObject({ code: "does_not_fit", compacted: true });
  expect(phases.some((p) => p.phase === "target_model" || p.phase === "ready")).toBe(false);
  expect((await users(h, sid)).users).toBe(2);
  const task = h.runtime.scheduler.list({ sessionID: sid }).tasks[0];
  expect(task.state).not.toBe("sent");
  expect(task.lastAt).toBeUndefined();
});

// Retirement-gap port (old engine-routing b): a history that already fits the
// smaller target is NOT summarized — the target answers directly, once — and a
// model change requested while a turn runs is refused instead of starting one.
it("a fitting history switches without any summary; a busy chat refuses the transition", async () => {
  h = await harness();
  // SDK post-answer auto-compaction is a separate trigger; Enki's transition
  // fit check is what must not summarize here.
  h.runtime.saveSettings({ ...h.runtime.settings(), compaction: { enabled: false } });
  const dir = h.project("ctx-fits");
  const sid = await newSession(h, dir, { model: h.model("large") });
  h.scripted.setResponses([fauxAssistantMessage("short answer")]);
  await h.command(promptCommand(h, "fits-1", sid, dir, "short question", h.model("large")));
  expect((await h.waitReceipt("fits-1", ["completed", "failed", "rejected"])).state).toBe("completed");
  // The target is genuinely smaller than the source AND the real next request
  // (system prompt + tools + history, max(SDK usage, estimate)) is inside its
  // budget. The medium target intentionally gives this no-summary fixture
  // headroom independent of the small target's compaction-focused calibration.
  const target = targetBudget({ contextWindow: 16_000, maxTokens: 512 });
  expect(target.limit).toBe(15_488);
  expect(target.limit).toBeLessThan(targetBudget({ contextWindow: 200_000, maxTokens: 8_000 }).limit);
  const live = h.runtime.registry.live(sid)?.usage();
  if (live && typeof live.tokens === "number") expect(live.tokens + promptTokens({ text: "short follow-up", images: [] })).toBeLessThan(target.limit);
  const calls = recorder(h);
  await h.command(promptCommand(h, "fits-medium", sid, dir, "short follow-up", h.model("medium")));
  expect((await h.waitReceipt("fits-medium", ["completed", "failed", "rejected"])).state).toBe("completed");
  expect(calls).toEqual([h.scripted.models.medium]);
  expect(calls.summaries).toEqual([false]);
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.medium);
  expect(await users(h, sid)).toEqual({ users: 2, summary: false });

  const hold = gate();
  h.scripted.setResponses([async () => { await hold.wait; return fauxAssistantMessage("long"); }]);
  await h.command(promptCommand(h, "fits-busy", sid, dir, "long work", h.model("medium")));
  await h.waitReceipt("fits-busy", ["running"]);
  const before = h.scripted.calls();
  await h.command({ id: "set-while-busy", kind: "model.set", sessionID: sid, directory: dir, payload: { model: h.model("large") } });
  expect((await h.waitReceipt("set-while-busy", ["completed", "failed", "rejected"])).state).not.toBe("completed");
  expect(h.scripted.calls()).toBe(before);
  hold.open();
  expect((await h.waitReceipt("fits-busy", ["completed", "failed", "rejected"])).state).toBe("completed");
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.medium);
  expect((await users(h, sid)).summary).toBe(false);
});

it("model.set to a smaller model compacts with the source and switches without a turn", async () => {
  h = await harness();
  const dir = h.project("ctx-set");
  const sid = await longChat(h, dir);
  const calls = recorder(h);
  const cursor = h.runtime.journal.head;
  await h.command({ id: "set-small", kind: "model.set", sessionID: sid, directory: dir, payload: { model: h.model("small") } });
  expect((await h.waitReceipt("set-small", ["completed", "failed", "rejected"])).state).toBe("completed");
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((id) => id === h.scripted.models.large)).toBe(true);
  verifiedSmallSummaryFit(h, sid, cursor, "set-small", 0);
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.small);
  expect(await users(h, sid)).toEqual({ users: 2, summary: true });
});

it("a summary that cannot fit refuses before any target call and retains the original transcript", async () => {
  h = await harness();
  const dir = h.project("ctx-nofit");
  const sid = await longChat(h, dir);
  const calls = recorder(h, "verbose ".repeat(5000));
  await h.command(promptCommand(h, "nofit", sid, dir, "continue", h.model("small")));
  const receipt = await h.waitReceipt("nofit", ["completed", "failed", "rejected"]);
  expect(receipt.state).toBe("rejected");
  expect(receipt.error).toMatch(/не помещается/);
  expect(calls).not.toContain(h.scripted.models.small);
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.large);
  expect((await users(h, sid)).users).toBe(2);
});

it("a failed source summary keeps the model and history; the retry runs once without replay", async () => {
  h = await harness();
  const dir = h.project("ctx-retry");
  const sid = await longChat(h, dir);
  h.scripted.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary provider down" })));
  await h.command(promptCommand(h, "try-1", sid, dir, "continue", h.model("small")));
  const failed = await h.waitReceipt("try-1", ["completed", "failed", "rejected"]);
  expect(failed.state).toBe("rejected");
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.large);
  const calls = recorder(h);
  const cursor = h.runtime.journal.head;
  await h.command(promptCommand(h, "try-2", sid, dir, "continue", h.model("small")));
  expect((await h.waitReceipt("try-2", ["completed", "failed", "rejected"])).state).toBe("completed");
  sourceThenTarget(h, calls);
  verifiedSmallSummaryFit(h, sid, cursor, "try-2", promptTokens({ text: "continue", images: [] }));
  expect((await users(h, sid)).users).toBe(3);
});

it("unknown usage right after compaction is estimated, never treated as fitting", async () => {
  h = await harness();
  const dir = h.project("ctx-unknown");
  const sid = await longChat(h, dir, "noted again ".repeat(1500));
  recorder(h);
  await h.command({ id: "manual", kind: "compact", sessionID: sid, directory: dir, payload: {} });
  expect((await h.waitReceipt("manual", ["completed", "failed", "rejected"])).state).toBe("completed");
  // SDK usage is now null; the kept large tail alone exceeds the small target.
  await h.command({ id: "set-after", kind: "model.set", sessionID: sid, directory: dir, payload: { model: h.model("small") } });
  const receipt = await h.waitReceipt("set-after", ["completed", "failed", "rejected"]);
  expect(receipt.state).not.toBe("completed");
  expect(receipt.error).toMatch(/не помещается|не смогла сжать/);
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.large);
});

it("a small caller budget refuses the irreducible shipped system and tools before any model call", async () => {
  h = await harness();
  const dir = h.project("ctx-irreducible-small-budget");
  const sid = await longChat(h, dir);
  const historyBefore = (await h.request<unknown>("GET", `/sessions/${sid}/messages`)).body;
  const calls = recorder(h);
  const providerCalls = h.scripted.calls();
  const pendingResponses = h.scripted.pending();
  const cursor = h.runtime.journal.head;
  // A caller may lower the model's input limit. Keep this far below the shipped
  // prefix, whose exact size includes platform-dependent absolute SDK paths.
  const budget = 512;
  await h.command({ id: "fixed-prefix-small-budget", kind: "model.transition", sessionID: sid, directory: dir,
    payload: { model: h.model("small"), budget } });
  const receipt = await h.waitReceipt("fixed-prefix-small-budget", ["completed", "failed", "rejected"]);
  expect(receipt.state).toBe("failed");
  expect(receipt.error).toMatch(/системными инструкциями и инструментами/);
  expect(receipt.error).toMatch(/512/);
  expect(calls).toEqual([]);
  expect(calls.summaries).toEqual([]);
  expect(h.scripted.calls()).toBe(providerCalls);
  expect(h.scripted.pending()).toBe(pendingResponses);
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.large);
  expect((await h.request<unknown>("GET", `/sessions/${sid}/messages`)).body).toEqual(historyBefore);
  expect(await users(h, sid)).toEqual({ users: 2, summary: false });
  const phases = transitions(h, sid, cursor, "fixed-prefix-small-budget");
  const planning = phases.find((phase) => phase.phase === "planning")!;
  expect(planning).toMatchObject({ window: 8_000, limit: budget, incoming: 0 });
  expect(planning.system!).toBeGreaterThan(0);
  expect(planning.tools!).toBeGreaterThan(0);
  expect(planning.system! + planning.tools!).toBeGreaterThan(planning.limit!);
  expect(phases.map((phase) => phase.phase)).toEqual(["planning", "failed"]);
  expect(phases.find((phase) => phase.phase === "failed")).toMatchObject({ code: "prompt_too_large", compacted: false });
});

// Regression (actual worker, was RED: the model was called oversized): the
// pending prompt is fitted on EVERY prompt, also on an unchanged model with SDK
// auto-compaction disabled. A prompt that alone exceeds the target cannot be
// fixed by compacting old history, so it is refused before ANY inference.
it("a same-model prompt larger than the small model is refused before any provider call", async () => {
  h = await harness();
  h.runtime.saveSettings({ ...h.runtime.settings(), compaction: { enabled: false, keepRecentTokens: 64, reserveTokens: 64 } });
  const dir = h.project("ctx-same-oversized");
  const sid = await newSession(h, dir, { model: h.model("small") });
  const calls = recorder(h);
  const text = "context ".repeat(10_245);
  expect(promptTokens({ text, images: [] })).toBe(20_506);
  await h.command(promptCommand(h, "same-big", sid, dir, text, h.model("small")));
  const receipt = await h.waitReceipt("same-big", ["completed", "failed", "rejected"]);
  expect(receipt.state).toBe("rejected");
  expect(receipt.error).toMatch(/сократите запрос/);
  expect(calls).toEqual([]);
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.small);
  expect((await users(h, sid)).users).toBe(0);
  // A prompt that fits on the same model still runs normally afterwards.
  await h.command(promptCommand(h, "same-ok", sid, dir, "short follow-up", h.model("small")));
  expect((await h.waitReceipt("same-ok", ["completed", "failed", "rejected"])).state).toBe("completed");
  expect(calls).toEqual([h.scripted.models.small]);
});

it("budgets are clamped to actual model metadata and invalid values are refused", () => {
  const small = { contextWindow: 4_000, maxTokens: 512 };
  expect(targetBudget(small)).toEqual({ window: 4_000, outputReserve: 512, limit: 3_488 });
  expect(targetBudget(small, Number.MAX_SAFE_INTEGER).limit).toBe(3_488);
  expect(targetBudget(small, 1_000).limit).toBe(1_000);
  expect(targetBudget({ contextWindow: 4_000, maxTokens: 4_000 }).outputReserve).toBe(2_000);
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    expect(() => targetBudget(small, bad)).toThrow(ContextTransitionError);
    try { targetBudget(small, bad); } catch (error) { expect((error as ContextTransitionError).code).toBe("invalid_budget"); }
  }
  expect(() => targetBudget({ contextWindow: Number.NaN, maxTokens: 1 })).toThrow(ContextTransitionError);
  expect(promptTokens({ text: "x".repeat(400), images: [{ type: "image", data: "", mimeType: "image/png" }] })).toBeGreaterThan(1_600 + 100);
});
