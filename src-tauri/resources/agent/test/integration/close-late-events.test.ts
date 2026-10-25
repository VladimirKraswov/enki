// Retirement-gap port (old pi-backend "intentional close, then late events"):
// closing a worker on purpose while its tool is still running must not surface
// a failure notice, a late transcript write or a status flip for that chat, and
// another chat's run is unaffected. Real pinned SDK + scripted provider.
// Written, NOT RUN.
import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "../../src/sdk/testing.ts";
import { extension, gate, harness, newSession, promptCommand, stream, type Harness } from "../helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

it("an intentionally closed worker emits nothing late; the other chat completes normally", async () => {
  const hold = gate();
  let entered!: () => void;
  const running = new Promise<void>((resolve) => { entered = resolve; });
  let late = 0;
  h = await harness({ extraExtensions: ({ sessionID }) => [extension("late", (pi) => pi.registerTool({
    name: "slow", label: "Slow", description: "Waits for the test", parameters: Type.Object({}),
    execute: async () => { entered(); await hold.wait; late++; return { content: [{ type: "text", text: `late from ${sessionID}` }], details: {} }; },
  }))] });
  const full = [{ permission: "*", pattern: "*", action: "allow" as const }];
  const dirA = h.project("close-a"), a = await newSession(h, dirA, { permission: full });
  const dirB = h.project("close-b"), b = await newSession(h, dirB, { permission: full });
  const watchA = stream(h, `directory=${encodeURIComponent(dirA)}`); await watchA.hello;
  h.scripted.setResponses([fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }), fauxAssistantMessage("never for A")]);
  await h.command(promptCommand(h, "close-a1", a, dirA, "slow work"));
  await running;
  const worker = h.runtime.registry.live(a)!;
  const file = worker.sessionFile();
  // close() detaches the event subscription synchronously, then settles the
  // SDK (which waits for the still-running tool).
  const closing = worker.close("quit");
  const closedAt = h.runtime.journal.head;
  // The tool finishes AFTER the intentional close began.
  hold.open();
  await closing;
  for (let i = 0; i < 40 && late === 0; i++) await new Promise((r) => setTimeout(r, 25));
  expect(late).toBe(1);
  const bytes = file && fs.existsSync(file) ? fs.readFileSync(file) : null;
  // Another chat keeps working on the same runtime.
  h.scripted.setResponses([fauxAssistantMessage("B answered")]);
  await h.command(promptCommand(h, "close-b1", b, dirB, "hello"));
  expect((await h.waitReceipt("close-b1", ["completed", "failed", "rejected", "cancelled"])).state).toBe("completed");
  await new Promise((r) => setTimeout(r, 100));
  const lateA = h.runtime.journal.replay({ sessionID: a, all: true }, closedAt) ?? [];
  expect(lateA.filter((e) => e.event.type === "session.error")).toEqual([]);
  expect(lateA.filter((e) => e.event.type.startsWith("message."))).toEqual([]);
  expect(lateA.filter((e) => e.event.type === "session.status" && (e.event.properties.status as { type?: string })?.type === "busy")).toEqual([]);
  expect(watchA.events.filter((e) => e.seq > closedAt && e.sessionID === a && e.event.type === "session.error")).toEqual([]);
  // No late transcript write for A.
  if (bytes) expect(fs.readFileSync(file!).equals(bytes)).toBe(true);
  // The closed command is not reported as a failure of the model or a success.
  expect(["cancelled", "uncertain"]).toContain(h.runtime.ledger.get("close-a1")?.state);
});
