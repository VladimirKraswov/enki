// SDK session events/entries → Enki DTOs. Carries the independent invariants of
// the retired frontend Pi CLI translator suite (test/pi-translate.test.ts):
// durable ids, tool results completing their call, error/abort/retry status,
// reasoning, non-text tool output and unknown events. Written, NOT RUN.
import { describe, expect, it, vi } from "vitest";
import type { MessagePartDTO, ServerEventDTO } from "../src/protocol.ts";
import type { SdkEntry } from "../src/sdk/adapter.ts";
import { boundedDetails, entriesPage, entriesToMessages, pageMessages, toolOutputText } from "../src/sdk/history.ts";
import { LIVE_PARTIAL_CHARS, LIVE_PARTIAL_MARKER, livePartial, StreamTranslator } from "../src/sdk/translate.ts";

const SID = "chat-1";
const at = "2026-09-24T20:07:27.297Z";
const message = (id: string, body: unknown) => ({ type: "message", id, parentId: null, timestamp: at, message: body });
const history = (entries: unknown[]) => entriesToMessages(SID, entries as never);
const parts = (events: ServerEventDTO[]) =>
  events.filter(e => e.type === "message.part.updated").map(e => (e.properties as { part: MessagePartDTO }).part);

describe("durable history", () => {
  it("maps a transcript with entry ids as message ids and tool results completing their call", () => {
    const out = history([
      { type: "model_change", id: "m1", parentId: null, timestamp: at, provider: "deepseek", modelId: "x" },
      message("u1", { role: "user", content: [{ type: "text", text: "привет" }], timestamp: 1 }),
      message("a1", { role: "assistant", provider: "deepseek", model: "deepseek-v4-flash", stopReason: "toolUse",
        usage: { input: 10, output: 2, totalTokens: 12, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
        content: [{ type: "thinking", thinking: "подумаю" }, { type: "text", text: "ответ" }, { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } }] }),
      message("t1", { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "file body" }] }),
    ]);
    expect(out.map(m => [m.info.id, m.info.role])).toEqual([["u1", "user"], ["a1", "assistant"]]);
    expect(out[0].parts[0]).toMatchObject({ id: "u1#0", type: "text", text: "привет" });
    expect(out[1].info).toMatchObject({ providerID: "deepseek", modelID: "deepseek-v4-flash", finish: "tool-calls", cost: 0.5, timingSource: "entry" });
    expect(out[1].parts.map(p => [p.id, p.type])).toEqual([["a1#0", "reasoning"], ["a1#1", "text"], ["a1#2", "tool"]]);
    // Not a separate bubble: the result completes the call that made it.
    expect(out[1].parts[2]).toMatchObject({ callID: "call_1", state: { status: "completed", output: "file body", input: { path: "a.ts" } } });
  });

  it("marks a failed tool result as an error, a provider failure and an abort distinctly", () => {
    const out = history([
      message("a1", { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash" }], stopReason: "error", errorMessage: "401 bad key" }),
      message("t1", { role: "toolResult", toolCallId: "c", toolName: "bash", isError: true, content: [{ type: "text", text: "boom" }] }),
      message("a2", { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted" }),
    ]);
    expect(out[0].parts[0].state).toMatchObject({ status: "error", error: "boom" });
    expect(out[0].info.error).toEqual({ name: "ProviderError", message: "401 bad key" });
    expect(out[1].info.error).toMatchObject({ name: "MessageAbortedError" });
  });

  it("ignores entry kinds it does not model and hidden custom messages", () => {
    expect(history([
      { type: "thinking_level_change", id: "x", parentId: null, timestamp: at, thinkingLevel: "high" },
      message("c1", { role: "custom", customType: "probe", display: false, content: "internal" }),
    ])).toEqual([]);
  });

  it("summarizes non-text tool output and bounds large details", () => {
    expect(toolOutputText([{ type: "image" }])).toBe("[изображение]");
    expect(toolOutputText(undefined)).toBe("");
    expect(boundedDetails({ diff: "x".repeat(70_000) })).toEqual({ truncated: true, bytes: expect.any(Number) });
    expect(boundedDetails({ ok: 1 })).toEqual({ ok: 1 });
  });

  it("pages from the end with an opaque cursor that names a real message", () => {
    const all = history(Array.from({ length: 5 }, (_, i) => message(`u${i}`, { role: "user", content: `m${i}` })));
    const last = pageMessages(all, 2);
    expect(last.messages.map(m => m.info.id)).toEqual(["u3", "u4"]);
    expect(last.before).toBe("u3");
    expect(pageMessages(all, 2, last.before).messages.map(m => m.info.id)).toEqual(["u1", "u2"]);
    expect(pageMessages(all, 10, "u1")).toEqual({ messages: [all[0]], before: undefined });
    // An unknown cursor never restarts from the newest page (no duplicates).
    expect(pageMessages(all, 2, "gone").messages).toEqual([]);
  });

  it("entriesPage equals paging the full conversion, converting/copying only the page (+ late tool results)", () => {
    const entries = [
      message("u0", { role: "user", content: [{ type: "image", data: "A".repeat(1_000_000), mimeType: "image/png" }, { type: "text", text: "old" }] }),
      { type: "thinking_level_change", id: "x", parentId: null, timestamp: at, thinkingLevel: "high" },
      message("c0", { role: "custom", customType: "probe", display: false, content: "internal" }),
      message("a0", { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "a0" }] }),
      { type: "compaction", id: "k0", parentId: null, timestamp: at, summary: "s", tokensBefore: 10, firstKeptEntryId: "u1" },
      message("u1", { role: "user", content: "q1" }),
      message("a1", { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } }] }),
      message("u2", { role: "user", content: "steer" }),
      message("t1", { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "late" }] }),
      message("a2", { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }),
    ] as unknown as SdkEntry[];
    const all = entriesToMessages(SID, entries);
    const copied: string[][] = [];
    const copy = (slice: SdkEntry[]) => { copied.push(slice.map((e) => e.id)); return structuredClone(slice); };
    for (const [limit, before] of [[2, undefined], [3, "u2"], [1, "a1"], [10, undefined], [2, "gone"], [5, "u0"]] as const) {
      copied.length = 0;
      expect(entriesPage(SID, entries, limit, before, copy)).toEqual(pageMessages(all, limit, before));
      // The 1 MB image of u0 is only converted when u0 is on the page.
      if (!(before === undefined && limit >= 6)) expect(copied.flat()).not.toContain("u0");
    }
    // A tool result after the page boundary still completes its call.
    const page = entriesPage(SID, entries, 1, "u2");
    expect(page.messages[0].parts[0]).toMatchObject({ callID: "c1", state: { status: "completed", output: "late" } });
  });
});

describe("live stream", () => {
  it("timestamps real changed tool output, never a repeated heartbeat", () => {
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(1000);
      const t = new StreamTranslator(SID);
      t.translate({ type: "message_start", message: { role: "assistant", content: [] } } as never);
      t.translate({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: {} } as never);
      const update = () => parts(t.translate({ type: "tool_execution_update", toolCallId: "c", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "one line" }] } } as never))[0];
      clock.mockReturnValue(2000); expect(update().state?.time?.output).toBe(2000);
      clock.mockReturnValue(5000); expect(update().state?.time?.output).toBe(2000);
    } finally { clock.mockRestore(); }
  });
  it("streams reasoning, text and tools under a provisional id, then converges on the durable entry id", () => {
    const t = new StreamTranslator(SID);
    const events = [
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [], provider: "deepseek", model: "m" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "ду" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "маю" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "При" } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "c1", toolName: "read" } },
    ].flatMap(e => t.translate(e as never));
    expect(events[0]).toEqual({ type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
    const live = parts(events);
    // The first reasoning chunk creates the typed part; later chunks are linear
    // deltas (no O(n²) cumulative re-send) that rebuild exactly the same text.
    expect(live.filter(p => p.type === "reasoning").map(p => [p.id, p.text])).toEqual([[`${live[0].messageID}#0`, "ду"]]);
    const liveId = live[0].messageID;
    expect(liveId).toMatch(/^live-assistant-/);
    const deltas = events.filter(e => e.type === "message.part.delta").map(e => e.properties);
    expect(deltas).toEqual([
      { sessionID: SID, messageID: liveId, partID: `${liveId}#0`, field: "text", partType: "reasoning", delta: "маю" },
      { sessionID: SID, messageID: liveId, partID: `${liveId}#1`, field: "text", delta: "При" },
    ]);
    expect(live[0].text + deltas.filter(d => d.partID === `${liveId}#0`).map(d => d.delta).join("")).toBe("думаю");

    const assistant = { role: "assistant", provider: "deepseek", model: "m", stopReason: "toolUse",
      content: [{ type: "thinking", thinking: "думаю" }, { type: "text", text: "При" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }] };
    const appended = t.appended(message("a1", assistant) as never);
    expect(appended[0]).toEqual({ type: "message.removed", properties: { sessionID: SID, messageID: liveId } });
    expect(parts(appended).map(p => p.id)).toEqual(["a1#0", "a1#1", "a1#2"]);
    // Tool events after persistence address the durable message, never the removed live one.
    const end = parts(t.translate({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", isError: false,
      result: { content: [{ type: "text", text: "ok" }] } } as never));
    expect(end[0]).toMatchObject({ id: "a1#2", messageID: "a1", state: { status: "completed", output: "ok", input: { path: "a.ts" } } });
    const result = parts(t.appended(message("t1", { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "ok" }] }) as never));
    expect(result[0]).toMatchObject({ id: "a1#2", state: { status: "completed", output: "ok" } });
    // Replay converges: history names exactly the same ids.
    const replay = history([message("a1", assistant), message("t1", { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "ok" }] })]);
    expect(replay[0].parts.map(p => p.id)).toEqual(["a1#0", "a1#1", "a1#2"]);
  });

  it("a tool error keeps the failing output as the error text", () => {
    const t = new StreamTranslator(SID);
    t.translate({ type: "message_start", message: { role: "assistant", content: [] } } as never);
    t.translate({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: "x" } } as never);
    const [part] = parts(t.translate({ type: "tool_execution_end", toolCallId: "c", toolName: "bash", isError: true,
      result: { content: [{ type: "text", text: "exit 1" }] } } as never));
    expect(part.state).toMatchObject({ status: "error", error: "exit 1", output: "exit 1", input: { command: "x" } });
  });

  // Remainder review: live partial output is a bounded tail; the final result is complete.
  it("a running tool's cumulative partial output is sent as a bounded tail; the completed result is never shortened", () => {
    const t = new StreamTranslator(SID);
    t.translate({ type: "message_start", message: { role: "assistant", content: [] } } as never);
    t.translate({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: "long" } } as never);
    const small = parts(t.translate({ type: "tool_execution_update", toolCallId: "c", toolName: "bash", args: { command: "long" },
      partialResult: { content: [{ type: "text", text: "line 1" }] } } as never));
    expect(small[0].state).toMatchObject({ status: "running", output: "line 1" });
    const huge = "0123456789".repeat(20_000) + "TAIL";
    const [running] = parts(t.translate({ type: "tool_execution_update", toolCallId: "c", toolName: "bash", args: { command: "long" },
      partialResult: { content: [{ type: "text", text: huge }] } } as never));
    const output = running.state!.output!;
    expect(output.length).toBe(LIVE_PARTIAL_MARKER.length + LIVE_PARTIAL_CHARS);
    expect(output.startsWith(LIVE_PARTIAL_MARKER)).toBe(true);
    expect(output.endsWith("TAIL")).toBe(true);
    expect(livePartial("short")).toBe("short");
    const [done] = parts(t.translate({ type: "tool_execution_end", toolCallId: "c", toolName: "bash", isError: false,
      result: { content: [{ type: "text", text: huge }] } } as never));
    expect(done.state).toMatchObject({ status: "completed", output: huge });
  });

  it("reports retry as retrying, a final failure as an error and a provider error message once", () => {
    const errors: string[] = [];
    const t = new StreamTranslator(SID, { onError: m => errors.push(m) });
    expect(t.translate({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "529 overloaded" } as never)[0].properties)
      .toMatchObject({ status: { type: "retry", attempt: 1, message: "529 overloaded" } });
    expect(t.translate({ type: "auto_retry_end", success: true, attempt: 2 } as never)[0].properties).toMatchObject({ status: { type: "busy" } });
    expect(t.translate({ type: "auto_retry_end", success: false, attempt: 3, finalError: "overloaded" } as never)[0])
      .toEqual({ type: "session.error", properties: { sessionID: SID, error: { name: "ProviderError", message: "overloaded" } } });
    t.translate({ type: "message_start", message: { role: "assistant", content: [] } } as never);
    const [ended] = t.translate({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "quota" } } as never);
    expect((ended.properties as { info: { error: unknown } }).info.error).toEqual({ name: "ProviderError", message: "quota" });
    expect(errors).toEqual(["overloaded", "quota"]);
  });

  it("settles to idle, forgets provisional state and ignores unknown events and deltas", () => {
    let settled = 0;
    const t = new StreamTranslator(SID, { onSettled: () => { settled++; } });
    t.translate({ type: "message_start", message: { role: "assistant", content: [] } } as never);
    expect(t.translate({ type: "agent_settled" } as never)).toEqual([{ type: "session.idle", properties: { sessionID: SID } }]);
    expect(settled).toBe(1);
    // After settling a late delta has no live message to attach to.
    expect(t.translate({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "late" } } as never)).toEqual([]);
    expect(t.translate({ type: "future_event" } as never)).toEqual([]);
    t.translate({ type: "message_start", message: { role: "assistant", content: [] } } as never);
    expect(t.translate({ type: "message_update", assistantMessageEvent: { type: "future_delta", contentIndex: 0 } } as never)).toEqual([]);
  });
});
