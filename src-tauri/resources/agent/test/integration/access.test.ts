// Access modes on real SDK built-in tools and plugin tools:
//   full → runs without asking; ask → a permission request that the user
//   answers (reject blocks, once runs, always grants for the session);
//   read → mutations are refused without a dialog, reads still run.
import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "../../src/sdk/testing.ts";
import { extension, harness, newSession, promptCommand, stream, type Harness } from "../helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

const FULL = [{ permission: "*", pattern: "*", action: "allow" as const }];
const ASK = [{ permission: "*", pattern: "*", action: "ask" as const }, ...["read", "glob", "grep", "list"].map((permission) => ({ permission, pattern: "*", action: "allow" as const }))];
const READ = [{ permission: "*", pattern: "*", action: "deny" as const }, ...["read", "glob", "grep", "list"].map((permission) => ({ permission, pattern: "*", action: "allow" as const }))];

function writeTurn(h: Harness, file: string) {
  h.scripted.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: file, content: "hello" })], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
}

it("full access runs the built-in write tool without a permission request", async () => {
  h = await harness();
  const dir = h.project("full");
  const sid = await newSession(h, dir, { permission: FULL });
  writeTurn(h, "out.txt");
  await h.command(promptCommand(h, "full-1", sid, dir, "write"));
  await h.waitReceipt("full-1", ["completed"]);
  expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).toBe("hello");
  expect(h.runtime.interactions.pendingPermissions()).toEqual([]);
});

it("ask mode: reject blocks the tool, approve once runs it", async () => {
  h = await harness();
  const dir = h.project("ask");
  const sid = await newSession(h, dir, { permission: ASK });
  const client = stream(h, `directory=${encodeURIComponent(dir)}`);
  await client.hello;
  writeTurn(h, "blocked.txt");
  await h.command(promptCommand(h, "ask-1", sid, dir, "write"));
  const asked = await client.waitFor((e) => e.event.type === "permission.asked");
  expect(asked.event.properties).toMatchObject({ sessionID: sid, permission: "edit", patterns: [path.join(dir, "blocked.txt")] });
  expect((await h.request("POST", `/permissions/${String(asked.event.properties.id)}/reply`, { reply: "reject" })).status).toBe(204);
  await h.waitReceipt("ask-1", ["completed"]);
  expect(fs.existsSync(path.join(dir, "blocked.txt"))).toBe(false);

  writeTurn(h, "allowed.txt");
  await h.command(promptCommand(h, "ask-2", sid, dir, "write again"));
  const second = await client.waitFor((e) => e.event.type === "permission.asked" && e.event.properties.id !== asked.event.properties.id);
  await h.request("POST", `/permissions/${String(second.event.properties.id)}/reply`, { reply: "once" });
  await h.waitReceipt("ask-2", ["completed"]);
  expect(fs.readFileSync(path.join(dir, "allowed.txt"), "utf8")).toBe("hello");
  // A late duplicate answer is ignored, never re-applied.
  expect((await h.request("POST", `/permissions/${String(second.event.properties.id)}/reply`, { reply: "always" })).status).toBe(404);
  client.close();
});

it("read mode blocks mutations without a dialog and still allows reading", async () => {
  h = await harness();
  const dir = h.project("read");
  fs.writeFileSync(path.join(dir, "notes.txt"), "secret notes");
  const sid = await newSession(h, dir, { permission: READ });
  type ToolResult = { role: string; toolCallId?: string; toolName?: string; isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  let results: ToolResult[] = [];
  h.scripted.setResponses([
    fauxAssistantMessage([fauxToolCall("write", { path: "x.txt", content: "no" }, { id: "call-write" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" }, { id: "call-read" })], { stopReason: "toolUse" }),
    async (context) => {
      results = (context.messages as ToolResult[]).filter((m) => m.role === "toolResult");
      return fauxAssistantMessage("ok");
    },
  ]);
  await h.command(promptCommand(h, "read-1", sid, dir, "try"));
  await h.waitReceipt("read-1", ["completed"]);
  // No side effect and no approval dialog.
  expect(fs.existsSync(path.join(dir, "x.txt"))).toBe(false);
  expect(h.runtime.interactions.pendingPermissions()).toEqual([]);
  expect(h.scripted.pending()).toBe(0);
  // The mutation was answered with a denied error result (copy is a separate UI
  // requirement); the read of the own fixture still succeeded.
  const text = (result: ToolResult | undefined) => (result?.content ?? []).map((part) => part.text ?? "").join("");
  expect(results.map((r) => r.toolCallId)).toEqual(["call-write", "call-read"]);
  const denied = results.find((r) => r.toolCallId === "call-write"), read = results.find((r) => r.toolCallId === "call-read");
  expect(denied).toMatchObject({ toolName: "write", isError: true });
  expect(text(denied).trim()).not.toBe("");
  expect(text(denied)).not.toContain("secret notes");
  expect(read).toMatchObject({ toolName: "read", isError: false });
  expect(text(read)).toContain("secret notes");
});

it("plugin tools pass the same gate; Stop denies a pending request", async () => {
  let ran = 0;
  h = await harness({ extraExtensions: () => [extension("plugin", (pi) => pi.registerTool({
    name: "plugin_mutate", label: "Plugin", description: "Plugin side effect", parameters: Type.Object({}),
    execute: async () => { ran++; return { content: [{ type: "text", text: "ran" }], details: {} }; },
  }))] });
  const dir = h.project("plugin");
  const sid = await newSession(h, dir, { permission: ASK });
  h.scripted.setResponses([fauxAssistantMessage([fauxToolCall("plugin_mutate", {})], { stopReason: "toolUse" }), fauxAssistantMessage("stopped")]);
  await h.command(promptCommand(h, "plugin-1", sid, dir, "use plugin"));
  for (let i = 0; i < 200 && !h.runtime.interactions.pendingPermissions().length; i++) await new Promise((r) => setTimeout(r, 25));
  expect(h.runtime.interactions.pendingPermissions()[0]).toMatchObject({ permission: "plugin_mutate" });
  await h.request("POST", `/sessions/${sid}/stop`, {});
  await h.waitReceipt("plugin-1", ["cancelled", "completed", "failed"]);
  expect(ran).toBe(0);
  expect(h.runtime.interactions.pendingPermissions()).toEqual([]);
});
