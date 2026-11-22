// Explicit context reset as a model-transition escape hatch: when the history
// does not fit the smaller target and the user accepts losing it (the source
// model may be dead or unable to summarize at all), the runtime must switch
// WITHOUT any summarization inference. The transcript stays in the chat file
// and on screen; only the model context is dropped via a real compaction entry.
import { afterEach, expect, it } from "vitest";
import { fauxAssistantMessage } from "../../src/sdk/testing.ts";
import { harness, newSession, promptCommand, type Harness } from "../helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

async function longChat(h: Harness, dir: string): Promise<string> {
  h.runtime.saveSettings({ ...h.runtime.settings(), compaction: { enabled: true, keepRecentTokens: 64, reserveTokens: 64 } });
  const sid = await newSession(h, dir, { model: h.model("large") });
  h.scripted.setResponses([fauxAssistantMessage("noted ".repeat(800)), fauxAssistantMessage("noted again ".repeat(100))]);
  await h.command(promptCommand(h, "long-1", sid, dir, "context ".repeat(4000)));
  await h.waitReceipt("long-1", ["completed"]);
  await h.command(promptCommand(h, "long-2", sid, dir, "more context ".repeat(2000)));
  await h.waitReceipt("long-2", ["completed"]);
  return sid;
}

it("resets the context without any model inference and switches to the smaller target", async () => {
  h = await harness();
  const dir = h.project("reset-transition");
  const sid = await longChat(h, dir);
  h.scripted.setResponses([]); // ANY summarization call would now fail the turn
  await h.command({ id: "reset-move", kind: "model.transition", sessionID: sid, directory: dir, payload: { model: h.model("small"), reset_context: true } });
  const receipt = await h.waitReceipt("reset-move", ["completed", "failed"]);
  expect(receipt.error ?? null).toBeNull();
  expect(receipt.state).toBe("completed");
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.small);
  // The visible transcript is intact and carries an explicit reset notice.
  const history = await h.request<{ messages: Array<{ info: { role: string; summary?: boolean }; parts: Array<{ text?: string }> }> }>("GET", `/sessions/${sid}/messages`);
  expect(history.body.messages.filter((m) => m.info.role === "user")).toHaveLength(2);
  expect(history.body.messages.some((m) => m.info.summary && m.parts.some((p) => p.text?.includes("Контекст сброшен")))).toBe(true);
  // The next prompt runs on the small target from the fresh (reset) context.
  h.scripted.setResponses([fauxAssistantMessage("ok after reset")]);
  await h.command(promptCommand(h, "after-reset", sid, dir, "still there?"));
  expect((await h.waitReceipt("after-reset", ["completed", "failed"])).state).toBe("completed");
});

it("an ordinary failure to fit offers reset_context as a recovery", async () => {
  h = await harness();
  const dir = h.project("reset-recovery");
  const sid = await longChat(h, dir);
  // A verbose summary cannot fit the small target: the transition fails and
  // must name the reset escape hatch in its typed recovery.
  h.scripted.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("verbose ".repeat(5000))));
  await h.command({ id: "move-fail", kind: "model.transition", sessionID: sid, directory: dir, payload: { model: h.model("small") } });
  const receipt = await h.waitReceipt("move-fail", ["completed", "failed"]);
  expect(receipt.state).toBe("failed");
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.large);
  const failed = (h.runtime.journal.replay({ all: true, sessionID: sid }, 0) ?? [])
    .map((e) => e.event)
    .filter((e) => e.type === "session.context_transition" && (e.properties as { operation?: string }).operation === "move-fail")
    .map((e) => e.properties as { phase: string; recovery?: string[] });
  const last = failed.at(-1);
  expect(last?.phase).toBe("failed");
  expect(last?.recovery).toContain("reset_context");
});
