// Final turn-outcome audit: a command's outcome is what THIS invocation
// produced under the real pinned SDK loop (its own bounded retry/compaction).
// No Enki retry loop, no synthetic "continue" prompt. Written, NOT RUN.
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "../../src/sdk/testing.ts";
import { OUTPUT_LIMIT_TEXT, observeRun, runOutcome, type RunFacts } from "../../src/sessions/worker.ts";
import { extension, harness, newSession, promptCommand, stream, type Harness } from "../helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });
const users = async (sid: string) => (await h.request<{ messages: Array<{ info: { role: string; finish?: string } ; parts: Array<{ text?: string }> }> }>("GET", `/sessions/${sid}/messages`)).body.messages;

describe("runOutcome (pure)", () => {
  const facts = (...events: unknown[]): RunFacts => { const f: RunFacts = { produced: false, compaction: null, retryError: null }; for (const e of events) observeRun(f, e as never); return f; };
  const end = (stopReason: string, content: unknown[] = [{ type: "text", text: "ok" }]) => ({ type: "message_end", message: { role: "assistant", stopReason, content } });
  it("the LAST assistant of this run decides; an SDK-recovered length is a success", () => {
    expect(runOutcome("c", facts(end("length"), { type: "compaction_end", result: {}, aborted: false }, end("stop")), true)).toMatchObject({ state: "completed", reason: "answered" });
    expect(runOutcome("c", facts(end("length")), true)).toMatchObject({ state: "failed", reason: "length", error: expect.stringContaining(OUTPUT_LIMIT_TEXT) });
    expect(runOutcome("c", facts(end("length"), { type: "compaction_end", aborted: false, errorMessage: "Nothing to compact" }), true).error).toContain("Nothing to compact");
  });
  it("no current answer, an empty stop and a tool-terminated turn are not successes; handled input is", () => {
    expect(runOutcome("c", facts({ type: "compaction_end", aborted: false, errorMessage: "summary failed" }), true)).toMatchObject({ state: "failed", reason: "no_answer", error: expect.stringContaining("summary failed") });
    expect(runOutcome("c", facts(end("stop", [])), true)).toMatchObject({ state: "failed", reason: "no_answer" });
    expect(runOutcome("c", facts(end("toolUse", [{ type: "toolCall", id: "t", name: "x", arguments: {} }])), true)).toMatchObject({ state: "failed", reason: "terminated" });
    expect(runOutcome("c", facts(), false)).toEqual({ commandId: "c", state: "completed", error: null, reason: "handled" });
    expect(runOutcome("c", facts(end("aborted")), true)).toMatchObject({ state: "cancelled" });
  });
});

it("a terminal output-limit stop is failed with its reason, partial text kept, exactly one provider call", async () => {
  h = await harness();
  h.runtime.saveSettings({ ...h.runtime.settings(), compaction: { enabled: false } });
  const dir = h.project("length"), sid = await newSession(h, dir);
  const client = stream(h, `directory=${encodeURIComponent(dir)}`); await client.hello;
  h.scripted.setResponses([fauxAssistantMessage("частичный ответ", { stopReason: "length" }), fauxAssistantMessage("must not be used")]);
  await h.command(promptCommand(h, "len-1", sid, dir, "long task"));
  const receipt = await h.waitReceipt("len-1", ["completed", "failed", "rejected", "cancelled"]);
  expect(receipt.state).toBe("failed");
  expect(receipt.error).toContain(OUTPUT_LIMIT_TEXT);
  expect(h.scripted.calls()).toBe(1);
  const history = await users(sid);
  expect(history.map((m) => m.info.role)).toEqual(["user", "assistant"]);
  expect(history[1].info.finish).toBe("length");
  expect(history[1].parts.map((p) => p.text).join("")).toContain("частичный ответ");
  const outcome = await client.waitFor((e) => e.event.type === "session.outcome");
  expect(outcome.event.properties).toMatchObject({ sessionID: sid, commandID: "len-1", state: "failed", reason: "length", finish: "length" });
  // The next request runs normally: no pause, no replay of the truncated one.
  await h.command(promptCommand(h, "len-2", sid, dir, "next"));
  expect((await h.waitReceipt("len-2", ["completed", "failed", "rejected", "cancelled"])).state).toBe("completed");
  expect(h.scripted.calls()).toBe(2);
  expect((await users(sid)).filter((m) => m.info.role === "user")).toHaveLength(2);
});

it("a vetoed compaction recovery leaves the length command failed, with no extra prompt or user message", async () => {
  h = await harness({ extraExtensions: () => [extension("veto", (pi) => { pi.on("session_before_compact", () => ({ cancel: true })); })] });
  h.runtime.saveSettings({ ...h.runtime.settings(), compaction: { enabled: true, keepRecentTokens: 64, reserveTokens: 64 } });
  const dir = h.project("veto"), sid = await newSession(h, dir);
  h.scripted.setResponses([fauxAssistantMessage("cut", { stopReason: "length" }), fauxAssistantMessage("must not be used")]);
  await h.command(promptCommand(h, "veto-1", sid, dir, "work"));
  const receipt = await h.waitReceipt("veto-1", ["completed", "failed", "rejected", "cancelled"]);
  expect(receipt.state).toBe("failed");
  expect(receipt.error).toContain(OUTPUT_LIMIT_TEXT);
  expect(h.scripted.calls()).toBe(1);
  expect((await users(sid)).filter((m) => m.info.role === "user")).toHaveLength(1);
});

it("handled input and a registered slash command never inherit an older command's failure, and call no model", async () => {
  let ran = 0;
  h = await harness({ extraExtensions: () => [extension("handled", (pi) => {
    pi.on("input", (event) => event.text === "handled please" ? { action: "handled" as const } : { action: "continue" as const });
    pi.registerCommand("noop", { description: "fixture", handler: async () => { ran++; } });
  })] });
  const dir = h.project("handled"), sid = await newSession(h, dir);
  h.scripted.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 invalid api key" })));
  await h.command(promptCommand(h, "old-fail", sid, dir, "first"));
  expect((await h.waitReceipt("old-fail", ["completed", "failed", "rejected", "cancelled"])).state).toBe("failed");
  const calls = h.scripted.calls(), before = (await users(sid)).length;
  for (const [id, text] of [["handled-1", "handled please"], ["slash-1", "/noop"]] as const) {
    await h.command(promptCommand(h, id, sid, dir, text));
    const receipt = await h.waitReceipt(id, ["completed", "failed", "rejected", "cancelled"]);
    expect(receipt).toMatchObject({ state: "completed", error: null });
  }
  expect(ran).toBe(1);
  expect(h.scripted.calls()).toBe(calls);
  expect((await users(sid)).length).toBe(before);
});

it("an empty provider stop is reported as no answer, not success", async () => {
  h = await harness();
  const dir = h.project("empty"), sid = await newSession(h, dir);
  h.scripted.setResponses([fauxAssistantMessage([], { stopReason: "stop" })]);
  await h.command(promptCommand(h, "empty-1", sid, dir, "hello"));
  const receipt = await h.waitReceipt("empty-1", ["completed", "failed", "rejected", "cancelled"]);
  expect(receipt.state).toBe("failed");
  expect(receipt.error).toMatch(/не дала ответа/);
  expect(h.scripted.calls()).toBe(1);
});

it("an individual recovered tool error is not a task failure", async () => {
  h = await harness();
  const dir = h.project("tool-error"), sid = await newSession(h, dir, { permission: [{ permission: "*", pattern: "*", action: "allow" }] });
  h.scripted.setResponses([fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })], { stopReason: "toolUse" }), fauxAssistantMessage("файла нет, вот вывод")]);
  await h.command(promptCommand(h, "tool-1", sid, dir, "read it"));
  expect((await h.waitReceipt("tool-1", ["completed", "failed", "rejected", "cancelled"])).state).toBe("completed");
});
