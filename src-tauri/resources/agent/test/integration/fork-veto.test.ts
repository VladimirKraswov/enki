// Retirement-gap port (old pi-backend): an actual SDK extension that cancels
// `session_before_fork` vetoes Enki's branch copy BEFORE anything exists — no
// catalog row, no new session file — and the source transcript, model and
// access stay byte/field identical. Without a veto the branch is created.
import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "../../src/sdk/testing.ts";
import { extension, harness, newSession, promptCommand, type Harness } from "../helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

it("an extension's session_before_fork veto creates nothing and leaves the source intact", async () => {
  let veto = true;
  const seen: Array<{ entryId: string; position: string }> = [];
  h = await harness({ extraExtensions: () => [extension("fork-guard", (pi) => {
    pi.on("session_before_fork", (event) => { seen.push({ entryId: event.entryId, position: event.position }); return veto ? { cancel: true } : undefined; });
  })] });
  const dir = h.project("fork-veto"), FULL = [{ permission: "*", pattern: "*", action: "allow" as const }];
  const sid = await newSession(h, dir, { permission: FULL, model: h.model("large") });
  h.scripted.setResponses([fauxAssistantMessage("answer")]);
  await h.command(promptCommand(h, "fork-src", sid, dir, "hello"));
  expect((await h.waitReceipt("fork-src", ["completed", "failed", "rejected"])).state).toBe("completed");
  const source = h.runtime.catalog.get(sid)!, file = source.sessionFile!, shard = path.dirname(file);
  const bytes = createHash("sha256").update(fs.readFileSync(file)).digest("hex"), files = fs.readdirSync(shard).sort(), sessions = h.runtime.catalog.all().length;
  const history = await h.request<{ messages: Array<{ info: { id: string; role: string } }> }>("GET", `/sessions/${sid}/messages`);
  const user = history.body.messages.find((m) => m.info.role === "user")!.info.id;

  for (const messageID of [null, user]) {
    const refused = await h.request<{ message?: string }>("POST", `/sessions/${sid}/fork`, { messageID });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/отменило/);
  }
  expect(seen.map((s) => s.position)).toEqual(["at", "before"]);
  expect(seen[1]!.entryId).toBe(user);
  expect(h.runtime.catalog.all()).toHaveLength(sessions);
  expect(fs.readdirSync(shard).sort()).toEqual(files);
  expect(createHash("sha256").update(fs.readFileSync(file)).digest("hex")).toBe(bytes);
  expect(h.runtime.catalog.get(sid)).toMatchObject({ model: source.model, permission: FULL, sessionFile: file });

  veto = false;
  const created = await h.request<{ id: string }>("POST", `/sessions/${sid}/fork`, { messageID: null });
  expect(created.status).toBe(200);
  expect(h.runtime.catalog.all()).toHaveLength(sessions + 1);
  expect(createHash("sha256").update(fs.readFileSync(file)).digest("hex")).toBe(bytes);
});
