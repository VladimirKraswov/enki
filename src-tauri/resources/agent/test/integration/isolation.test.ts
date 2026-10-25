// Two chats in two project directories, two attached clients: every event is
// delivered only to the client scoped to its directory, and each session's
// transcript contains only its own turns. The global activity client sees
// status of both (sidebar markers) without message content leaking into the
// wrong chat view.
import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "../../src/sdk/testing.ts";
import { harness, newSession, promptCommand, stream, type Harness } from "../helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

it("isolates events and transcripts by directory and session across two clients", async () => {
  h = await harness();
  const a = h.project("a"), b = h.project("b");
  const sa = await newSession(h, a), sb = await newSession(h, b);
  const clientA = stream(h, `directory=${encodeURIComponent(a)}`);
  const clientB = stream(h, `directory=${encodeURIComponent(b)}`);
  const global = stream(h, "all=1");
  await Promise.all([clientA.hello, clientB.hello, global.hello]);

  h.scripted.setResponses([fauxAssistantMessage("answer for A"), fauxAssistantMessage("answer for B")]);
  expect((await h.command(promptCommand(h, "cmd-a", sa, a, "question A"))).status).toBe(202);
  await h.waitReceipt("cmd-a", ["completed"]);
  expect((await h.command(promptCommand(h, "cmd-b", sb, b, "question B"))).status).toBe(202);
  await h.waitReceipt("cmd-b", ["completed"]);

  await clientA.waitFor((e) => e.event.type === "session.idle" && e.sessionID === sa);
  await clientB.waitFor((e) => e.event.type === "session.idle" && e.sessionID === sb);
  for (const e of clientA.events) expect([sa, null]).toContain(e.sessionID);
  for (const e of clientB.events) expect([sb, null]).toContain(e.sessionID);
  expect(clientA.events.some((e) => e.directory === b)).toBe(false);
  expect(clientB.events.some((e) => e.directory === a)).toBe(false);
  expect(global.events.some((e) => e.sessionID === sa)).toBe(true);
  expect(global.events.some((e) => e.sessionID === sb)).toBe(true);

  const historyA = await h.request<{ messages: Array<{ info: { sessionID: string; role: string }; parts: Array<{ text?: string }> }> }>("GET", `/sessions/${sa}/messages?directory=${encodeURIComponent(a)}`);
  const historyB = await h.request<{ messages: Array<{ info: { sessionID: string }; parts: Array<{ text?: string }> }> }>("GET", `/sessions/${sb}/messages?directory=${encodeURIComponent(b)}`);
  const text = (m: { parts: Array<{ text?: string }> }[]) => m.flatMap((x) => x.parts.map((p) => p.text ?? "")).join(" ");
  expect(text(historyA.body.messages)).toContain("answer for A");
  expect(text(historyA.body.messages)).not.toContain("answer for B");
  expect(text(historyB.body.messages)).toContain("answer for B");
  expect(historyA.body.messages.every((m) => m.info.sessionID === sa)).toBe(true);

  // A session is directory-scoped: asking through the other project is refused.
  expect((await h.request("GET", `/sessions/${sa}/messages?directory=${encodeURIComponent(b)}`)).status).toBe(409);
  expect((await h.command(promptCommand(h, "cmd-cross", sa, b, "wrong scope"))).status).toBe(202);
  expect((await h.waitReceipt("cmd-cross", ["rejected"])).error).toContain("другой папке");
  clientA.close(); clientB.close(); global.close();
});

// Re-homed session-context invariants of the retired OpenCode access plugin
// (test/access-directory-alias.test.ts): no implicit trust in a symlink alias,
// a matching suffix or a file posing as a directory, and one session's access
// rules never flow into another. Written, NOT RUN.
it("a session's context is its exact directory: aliases, suffixes and file links are not trusted; rules stay per session", async () => {
  h = await harness();
  const real = h.project("alias-real"), base = path.dirname(real);
  const alias = path.join(base, `${path.basename(real)}-alias`);
  fs.symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
  try {
    const full = [{ permission: "*", pattern: "*", action: "allow" as const }];
    const owner = await newSession(h, real, { permission: full });
    // Same real directory through an alias, or a look-alike suffix: refused, nothing changed.
    expect((await h.request("GET", `/sessions/${owner}/messages?directory=${encodeURIComponent(alias)}`)).status).toBe(409);
    expect((await h.request("PATCH", `/sessions/${owner}?directory=${encodeURIComponent(`${real}-other`)}`, { permission: [] })).status).toBe(409);
    expect(h.runtime.catalog.get(owner)?.permission).toEqual(full);
    // A symlink to a FILE is not a directory context.
    if (process.platform !== "win32") {
      const file = path.join(base, `${path.basename(real)}-file`); fs.writeFileSync(file, "x");
      const link = `${file}-link`; fs.symlinkSync(file, link);
      try { expect((await h.request("POST", "/sessions", { directory: link })).status).toBe(404); }
      finally { fs.rmSync(link, { force: true }); fs.rmSync(file, { force: true }); }
    }
    // Another chat in the same folder does not inherit the first chat's full access.
    const other = await newSession(h, real);
    expect(h.runtime.catalog.get(other)?.permission ?? null).toBeNull();
  } finally { fs.rmSync(alias, { force: true, recursive: false }); }
});

it("history uses durable entry ids: live provisional ids are replaced in the stream", async () => {
  h = await harness();
  const dir = h.project("ids");
  const sid = await newSession(h, dir);
  const client = stream(h, `directory=${encodeURIComponent(dir)}`);
  await client.hello;
  h.scripted.setResponses([fauxAssistantMessage("durable")]);
  await h.command(promptCommand(h, "cmd-ids", sid, dir, "hi"));
  const receipt = await h.waitReceipt("cmd-ids", ["completed"]);
  const history = await h.request<{ messages: Array<{ info: { id: string; role: string } }> }>("GET", `/sessions/${sid}/messages`);
  const ids = history.body.messages.map((m) => m.info.id);
  expect(ids.every((id) => !id.startsWith("live-"))).toBe(true);
  // The receipt names the durable user entry created by this command.
  expect(ids).toContain(receipt.entryId);
  const removed = client.events.filter((e) => e.event.type === "message.removed").map((e) => String(e.event.properties.messageID));
  expect(removed.every((id) => id.startsWith("live-"))).toBe(true);
  const updated = client.events.filter((e) => e.event.type === "message.updated").map((e) => String((e.event.properties.info as { id: string }).id));
  for (const id of ids) expect(updated).toContain(id);
  client.close();
});
