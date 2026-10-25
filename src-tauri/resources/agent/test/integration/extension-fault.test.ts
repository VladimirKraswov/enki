// Retirement-gap port (old pi-translate): a REAL extension hook failure during a
// turn is a scoped `extension.error` notice for that session. It never becomes
// an invented user/assistant message or transcript content, the turn's own
// result is unaffected, and a reconnecting client replays the notice once.
import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import { fauxAssistantMessage } from "../../src/sdk/testing.ts";
import { extension, harness, newSession, promptCommand, stream, type Harness } from "../helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

const FAULT = "synthetic extension fault 7f3a";

it("an extension hook error is a scoped notice, not history, and replays exactly once", async () => {
  h = await harness({ extraExtensions: () => [extension("faulty-hook", (pi) => {
    pi.on("turn_start", () => { throw new Error(FAULT); });
  })] });
  const dir = h.project("ext-fault"), other = h.project("ext-fault-other");
  const sid = await newSession(h, dir), quiet = await newSession(h, other);
  const live = stream(h, `directory=${encodeURIComponent(dir)}`); await live.hello;
  h.scripted.setResponses([fauxAssistantMessage("real answer")]);
  await h.command(promptCommand(h, "fault-turn", sid, dir, "hello"));
  expect((await h.waitReceipt("fault-turn", ["completed", "failed", "rejected"])).state).toBe("completed");

  const notice = await live.waitFor((e) => e.event.type === "extension.error" && e.event.properties.sessionID === sid);
  expect(notice.event.properties).toMatchObject({ sessionID: sid, event: "turn_start" });
  expect(String(notice.event.properties.error)).toContain(FAULT);

  type History = { messages: Array<{ info: { role: string }; parts: unknown[] }> };
  const history = (await h.request<History>("GET", `/sessions/${sid}/messages`)).body.messages;
  expect(history.map((m) => m.info.role)).toEqual(["user", "assistant"]);
  expect(JSON.stringify(history)).not.toContain(FAULT);
  expect(fs.readFileSync(h.runtime.catalog.get(sid)!.sessionFile!, "utf8")).not.toContain(FAULT);
  expect((await h.request<History>("GET", `/sessions/${quiet}/messages`)).body.messages).toEqual([]);

  // A reconnecting client replays the durable notice from its cursor once.
  const replay = stream(h, `directory=${encodeURIComponent(dir)}&after=0`); await replay.hello;
  await replay.waitFor((e) => e.event.type === "extension.error" && e.event.properties.sessionID === sid);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const faults = (events: typeof replay.events) => events.filter((e) => e.event.type === "extension.error" && e.event.properties.sessionID === sid);
  expect(faults(replay.events)).toHaveLength(faults(live.events).length);
  expect(new Set(faults(replay.events).map((e) => e.seq)).size).toBe(faults(replay.events).length);
});
