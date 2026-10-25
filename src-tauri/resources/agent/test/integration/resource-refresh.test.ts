// Shared-registry/capability refresh (remaining-runtime-integrations item 3):
// after a confirmed commit an authenticated client asks THIS runtime to refresh.
// Idle workers reopen with the new resources on their next use; a running turn
// is never interrupted or replayed, its worker is recycled only once idle.
import { afterEach, expect, it } from "vitest";
import { fauxAssistantMessage } from "../../src/sdk/testing.ts";
import { extension, gate, harness, newSession, promptCommand, type Harness } from "../helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

it("idle workers reopen with fresh resources at next use; a busy worker finishes its turn and is recycled only when idle", async () => {
  const opened: string[] = [];
  h = await harness({ extraExtensions: ({ sessionID }) => { opened.push(sessionID); return [extension("resource-count", () => {})]; } });
  const dir = h.project("refresh"), other = h.project("refresh-other");
  const idle = await newSession(h, dir), busy = await newSession(h, dir), elsewhere = await newSession(h, other);
  h.scripted.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b"), fauxAssistantMessage("c")]);
  for (const [id, sid, directory] of [["r-1", idle, dir], ["r-2", busy, dir], ["r-3", elsewhere, other]] as const) {
    await h.command(promptCommand(h, id, sid, directory, id));
    expect((await h.waitReceipt(id, ["completed", "failed", "rejected"])).state).toBe("completed");
  }
  expect(opened.filter(id => id === idle)).toHaveLength(1);

  const hold = gate();
  h.scripted.setResponses([async () => { await hold.wait; return fauxAssistantMessage("long"); }]);
  await h.command(promptCommand(h, "busy-turn", busy, dir, "long"));
  await h.waitReceipt("busy-turn", ["running"]);

  const refreshed = await h.request<{ reopened: number; pending: number }>("POST", "/capabilities/refresh", { directory: dir });
  expect(refreshed.status).toBe(200);
  expect(refreshed.body).toEqual({ reopened: 1, pending: 1 });
  expect(h.runtime.registry.live(idle)).toBeUndefined();
  expect(h.runtime.registry.live(busy)).toBeDefined();
  expect(h.runtime.registry.live(elsewhere)).toBeDefined(); // other project untouched
  expect((await h.request("POST", "/capabilities/refresh", { directory: "relative" })).status).toBe(400);

  hold.open();
  expect((await h.waitReceipt("busy-turn", ["completed", "failed", "rejected"])).state).toBe("completed");
  const callsAfterBusy = h.scripted.calls();
  h.scripted.setResponses([fauxAssistantMessage("fresh idle"), fauxAssistantMessage("fresh busy")]);
  for (const [id, sid] of [["after-idle", idle], ["after-busy", busy]] as const) {
    await h.command(promptCommand(h, id, sid, dir, id));
    expect((await h.waitReceipt(id, ["completed", "failed", "rejected"])).state).toBe("completed");
  }
  // Exactly one provider call per prompt: nothing replayed by the recycle.
  expect(h.scripted.calls() - callsAfterBusy).toBe(2);
  expect(opened.filter(id => id === idle)).toHaveLength(2);
  expect(opened.filter(id => id === busy)).toHaveLength(2);
  expect(opened.filter(id => id === elsewhere)).toHaveLength(1);
  // The recycled chats keep their complete transcripts.
  const history = await h.request<{ messages: Array<{ info: { role: string } }> }>("GET", `/sessions/${busy}/messages`);
  expect(history.body.messages.filter(m => m.info.role === "user")).toHaveLength(3);
});

it("a resource-selecting settings change refreshes open chats; unrelated settings do not", async () => {
  const opened: string[] = [];
  h = await harness({ extraExtensions: ({ sessionID }) => { opened.push(sessionID); return []; } });
  const dir = h.project("settings-refresh"), sid = await newSession(h, dir);
  h.scripted.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
  const turn = async (id: string) => { await h.command(promptCommand(h, id, sid, dir, id)); expect((await h.waitReceipt(id, ["completed", "failed", "rejected"])).state).toBe("completed"); };
  await turn("s-1");
  expect((await h.request("PUT", "/settings", { defaultPolicy: "read" })).status).toBe(200);
  await turn("s-2");
  expect(opened).toHaveLength(1);
  expect((await h.request("PUT", "/settings", { lspEnabled: !h.runtime.settings().lspEnabled })).status).toBe(200);
  await expect.poll(() => h.runtime.registry.live(sid)).toBeUndefined();
  await turn("s-3");
  expect(opened).toHaveLength(2);
});
