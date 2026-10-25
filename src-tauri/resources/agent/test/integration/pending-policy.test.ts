// Retirement-gap port (old full-access-loop): a permission request is ALREADY
// pending when the user changes the chat's access. The server re-evaluates that
// exact call against the CURRENT policy and settles it exactly once (by
// "policy"): full access runs it without a second prompt, read-only refuses it,
// an unrelated change leaves it pending for the user. No persistent grant.
import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "../../src/sdk/testing.ts";
import { extension, gate, harness, newSession, promptCommand, stream, type Harness, type StreamClient } from "../helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

const FULL = [{ permission: "*", pattern: "*", action: "allow" as const }];
const ASK = [{ permission: "*", pattern: "*", action: "ask" as const }];
const READ = [{ permission: "*", pattern: "*", action: "deny" as const }, { permission: "read", pattern: "*", action: "allow" as const }];

async function pendingWrite(id: string, file: string): Promise<{ dir: string; sid: string; client: StreamClient; requestID: string }> {
  h = await harness();
  const dir = h.project(id), sid = await newSession(h, dir, { permission: ASK });
  const client = stream(h, `directory=${encodeURIComponent(dir)}`); await client.hello;
  h.scripted.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: file, content: "hello" })], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  await h.command(promptCommand(h, id, sid, dir, "write"));
  const asked = await client.waitFor((e) => e.event.type === "permission.asked");
  return { dir, sid, client, requestID: String(asked.event.properties.id) };
}
const replies = (client: StreamClient, requestID: string) => client.events.filter((e) => e.event.type === "permission.replied" && e.event.properties.requestID === requestID);
const grants = () => h.runtime.db.all("SELECT * FROM permission_grants");

it("switching to full access settles the waiting request once and the tool runs without re-asking", async () => {
  const f = await pendingWrite("pending-full", "out.txt");
  expect((await h.request("PATCH", `/sessions/${f.sid}`, { permission: FULL })).status).toBe(200);
  expect((await h.waitReceipt("pending-full", ["completed", "failed", "rejected"])).state).toBe("completed");
  expect(fs.readFileSync(path.join(f.dir, "out.txt"), "utf8")).toBe("hello");
  await f.client.waitFor((e) => e.event.type === "permission.replied" && e.event.properties.requestID === f.requestID);
  expect(replies(f.client, f.requestID).map((e) => e.event.properties)).toEqual([expect.objectContaining({ reply: "once", by: "policy" })]);
  expect(f.client.events.filter((e) => e.event.type === "permission.asked")).toHaveLength(1);
  expect(h.runtime.interactions.pendingPermissions()).toEqual([]);
  expect(grants()).toEqual([]);
  // A late user answer for the settled request is not applied again.
  expect((await h.request("POST", `/permissions/${f.requestID}/reply`, { reply: "always" })).status).toBe(404);
});

it("switching to read-only refuses the waiting mutation once; nothing is written", async () => {
  const f = await pendingWrite("pending-read", "blocked.txt");
  expect((await h.request("PATCH", `/sessions/${f.sid}`, { permission: READ })).status).toBe(200);
  expect((await h.waitReceipt("pending-read", ["completed", "failed", "rejected"])).state).toBe("completed");
  expect(fs.existsSync(path.join(f.dir, "blocked.txt"))).toBe(false);
  await f.client.waitFor((e) => e.event.type === "permission.replied" && e.event.properties.requestID === f.requestID);
  expect(replies(f.client, f.requestID).map((e) => e.event.properties)).toEqual([expect.objectContaining({ reply: "reject", by: "policy" })]);
  expect(grants()).toEqual([]);
});

it("a change that still requires asking leaves the request for the user", async () => {
  const f = await pendingWrite("pending-ask", "later.txt");
  expect((await h.request("PATCH", `/sessions/${f.sid}`, { title: "renamed" })).status).toBe(200);
  expect((await h.request("PATCH", `/sessions/${f.sid}`, { permission: [...ASK, { permission: "read", pattern: "*", action: "allow" as const }] })).status).toBe(200);
  expect(h.runtime.interactions.pendingPermissions().map((p) => p.id)).toEqual([f.requestID]);
  expect((await h.request("POST", `/permissions/${f.requestID}/reply`, { reply: "once" })).status).toBe(204);
  expect((await h.waitReceipt("pending-ask", ["completed", "failed", "rejected"])).state).toBe("completed");
  expect(fs.readFileSync(path.join(f.dir, "later.txt"), "utf8")).toBe("hello");
  await f.client.waitFor((e) => e.event.type === "permission.replied" && e.event.properties.requestID === f.requestID);
  expect(replies(f.client, f.requestID).map((e) => e.event.properties)).toEqual([expect.objectContaining({ reply: "once", by: "user" })]);
});

it("a running turn that is NOT waiting on a permission keeps its access mode (409) until it stops", async () => {
  const hold = gate();
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  h = await harness({
    extraExtensions: () => [extension("hold", (pi) => pi.registerTool({
      name: "hold", label: "Hold", description: "Waits for the test", parameters: Type.Object({}),
      execute: async () => { started(); await hold.wait; return { content: [{ type: "text", text: "held" }], details: {} }; },
    }))],
  });
  const dir = h.project("busy-policy"), sid = await newSession(h, dir, { permission: FULL });
  h.scripted.setResponses([fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  await h.command(promptCommand(h, "busy-policy", sid, dir, "hold"));
  await running;
  expect(h.runtime.interactions.pendingPermissions()).toEqual([]);
  const refused = await h.request("PATCH", `/sessions/${sid}`, { permission: READ });
  expect(refused.status).toBe(409);
  expect((await h.request<{ permission: unknown }>("GET", `/sessions/${sid}`)).body.permission).toEqual(FULL);
  hold.open();
  expect((await h.waitReceipt("busy-policy", ["completed", "failed", "rejected"])).state).toBe("completed");
  // Once idle, the same change is accepted.
  expect((await h.request("PATCH", `/sessions/${sid}`, { permission: READ })).status).toBe(200);
});
