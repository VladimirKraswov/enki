// Window reload / reconnect: the run continues without any client; a client
// that comes back with its cursor receives exactly the durable events it
// missed (no gap, no duplicate); an expired cursor gets an explicit reset and
// reconciles from the snapshot.
import { afterEach, expect, it } from "vitest";
import { fauxAssistantMessage } from "../../src/sdk/testing.ts";
import { gate, harness, newSession, promptCommand, stream, tempDir, type Harness } from "../helpers.ts";
import { Database } from "../../src/store/db.ts";
import { EventJournal } from "../../src/store/events.ts";
import path from "node:path";

let h: Harness;
afterEach(async () => { await h?.stop(); });

it("work continues while no client is attached and replays from the cursor", async () => {
  h = await harness();
  const dir = h.project("reload");
  const sid = await newSession(h, dir);
  const hold = gate();
  h.scripted.setResponses([async () => { await hold.wait; return fauxAssistantMessage("finished while detached"); }]);
  const first = stream(h, `directory=${encodeURIComponent(dir)}`);
  await first.hello;
  await h.command(promptCommand(h, "cmd-reload", sid, dir, "long task"));
  await first.waitFor((e) => e.event.type === "session.status" && e.sessionID === sid);
  const cursor = first.last();
  first.close(); // the window reloads; the runtime keeps running
  hold.open();
  await h.waitReceipt("cmd-reload", ["completed"]);
  const status = await h.request<Record<string, unknown>>("GET", `/sessions/status?directory=${encodeURIComponent(dir)}`);
  expect(status.body[sid]).toBeUndefined(); // idle

  const second = stream(h, `directory=${encodeURIComponent(dir)}&after=${cursor}`);
  await second.waitFor((e) => e.event.type === "session.idle" && e.sessionID === sid);
  const seqs = second.events.map((e) => e.seq);
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(Math.min(...seqs)).toBeGreaterThan(cursor);
  expect(second.events.some((e) => e.event.type === "message.updated" && (e.event.properties.info as { role: string }).role === "assistant")).toBe(true);
  expect(second.events.some((e) => e.event.type === "command.updated")).toBe(true);
  second.close();
});

it("snapshot plus subscription has no gap between them", async () => {
  h = await harness();
  const dir = h.project("snap");
  const sid = await newSession(h, dir);
  const snapshot = await h.request<{ seq: number; instance: string }>("GET", `/snapshot?directory=${encodeURIComponent(dir)}`);
  h.scripted.setResponses([fauxAssistantMessage("after snapshot")]);
  await h.command(promptCommand(h, "cmd-snap", sid, dir, "go"));
  await h.waitReceipt("cmd-snap", ["completed"]);
  const client = stream(h, `directory=${encodeURIComponent(dir)}&after=${snapshot.body.seq}`);
  expect((await client.hello).instance).toBe(snapshot.body.instance);
  await client.waitFor((e) => e.event.type === "session.idle");
  expect(client.events.some((e) => e.event.type === "command.updated" && (e.event.properties.receipt as { id: string }).id === "cmd-snap")).toBe(true);
  client.close();
});

it("sequence numbers survive a restart and expired cursors reset", () => {
  const data = tempDir("journal");
  const db = new Database(path.join(data, "runtime.sqlite"));
  const journal = new EventJournal(db);
  const first = journal.append("/p", "s", { type: "session.status", properties: {} });
  journal.append("/p", "s", { type: "message.part.delta", properties: {} }, true);
  const restarted = new EventJournal(db);
  const next = restarted.append("/p", "s", { type: "session.idle", properties: {} });
  // A client holding any pre-restart cursor (durable or transient) cannot miss events.
  expect(next.seq).toBeGreaterThan(first.seq + 1);
  expect(restarted.replay({ directory: "/p" }, first.seq)?.map((e) => e.seq)).toEqual([next.seq]);
  db.run("INSERT INTO meta(key,value) VALUES('pruned_before',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(next.seq));
  expect(restarted.replay({ directory: "/p" }, first.seq - 1)).toBeNull();
  db.close();
});
