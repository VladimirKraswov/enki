// Final integration (UI performance audit P1): bounded transient retention and
// wire-bounded events with forward progress. Written, NOT RUN.
import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/store/db.ts";
import { EventJournal, transientKey } from "../src/store/events.ts";
import { EVENT_FRAME_CHARACTERS, EVENT_WIRE_LIMIT_BYTES, type EventEnvelope } from "../src/protocol.ts";
import { wireEnvelope } from "../src/server/wire.ts";
import { harness, newSession, stream, type Harness } from "./helpers.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function journal(): EventJournal {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enki-event-wire-"));
  const db = new Database(path.join(root, "runtime.sqlite"));
  cleanups.push(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return new EventJournal(db);
}
const reasoning = (sessionID: string, partID: string, text: string) =>
  ({ type: "message.part.updated", properties: { part: { id: partID, sessionID, messageID: "m", type: "reasoning", text } } });

it("cumulative transient snapshots of one part are coalesced; durable events and deltas are all kept in order", () => {
  const j = journal(), start = j.head;
  let text = "";
  for (let n = 0; n < 2_000; n++) {
    text += `chunk ${n} `.repeat(4);
    j.append("/w", "s1", reasoning("s1", "m#0", text), true);
    if (n % 500 === 0) j.append("/w", "s1", { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } });
    if (n % 400 === 0) j.append("/w", "s1", { type: "message.part.delta", properties: { sessionID: "s1", messageID: "m", partID: "m#1", field: "text", delta: `d${n}` } }, true);
  }
  // Without coalescing ~n²/2 prefix characters (≈ 0.1 GB) would be retained.
  const stats = j.transientStats();
  expect(stats.events).toBe(1 + 5);
  expect(stats.bytes).toBeLessThan(text.length * 2 + 4_096);
  const replay = j.replay({ directory: "/w" }, start)!;
  expect(replay.map((e) => e.seq)).toEqual([...replay.map((e) => e.seq)].sort((a, b) => a - b));
  expect(replay.filter((e) => e.event.type === "session.status")).toHaveLength(4);
  expect(replay.filter((e) => e.event.type === "message.part.delta").map((e) => e.event.properties.delta)).toEqual(["d0", "d400", "d800", "d1200", "d1600"]);
  const snapshots = replay.filter((e) => e.event.type === "message.part.updated");
  expect(snapshots).toHaveLength(1);
  expect((snapshots[0].event.properties.part as { text: string }).text).toBe(text);
  // Different parts/sessions are distinct keys; deltas are never replaceable.
  expect(transientKey("s1", reasoning("s1", "a", ""))).not.toBe(transientKey("s2", reasoning("s2", "a", "")));
  expect(transientKey("s1", { type: "message.part.delta", properties: {} })).toBeNull();
});

it("a budget-evicted transient event makes an older cursor an explicit reset, never a silent gap", () => {
  const j = journal(), start = j.head;
  const big = "y".repeat(1024 * 1024);
  for (let n = 0; n < 12; n++) j.append("/w", "s1", { type: "message.part.delta", properties: { sessionID: "s1", messageID: "m", partID: "m#0", field: "text", delta: big } }, true);
  expect(j.transientStats().bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(j.replay({ directory: "/w" }, start)).toBeNull();
  // Another project's cursor is unaffected; a cursor after the eviction replays.
  expect(j.replay({ directory: "/other" }, start)).toEqual([]);
  const recent = j.replay({ directory: "/w" }, j.head - 2)!;
  expect(recent.map((e) => e.seq)).toEqual([j.head - 1, j.head]);
});

it("journal.head is the highest emitted seq, never the transient ring's eviction index (remainder P1)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enki-event-head-"));
  const file = path.join(root, "runtime.sqlite");
  let db = new Database(file);
  cleanups.push(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const j = new EventJournal(db);
  // An own instance field named `head` would shadow the prototype getter.
  expect(Object.prototype.hasOwnProperty.call(j, "head")).toBe(false);
  expect(typeof Object.getOwnPropertyDescriptor(EventJournal.prototype, "head")?.get).toBe("function");
  const start = j.head;
  expect(Number.isSafeInteger(start)).toBe(true);
  let last = j.append("/w", "s1", { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } });
  expect(j.head).toBe(last.seq);
  // Force many evictions (byte budget) and at least one ring compaction
  // (ring index > 4096): the public head must track seq throughout.
  const chunk = "z".repeat(4 * 1024);
  for (let n = 0; n < 10_000; n++) {
    last = j.append("/w", "s1", { type: "message.part.delta", properties: { sessionID: "s1", messageID: "m", partID: "m#0", field: "text", delta: chunk } }, true);
    if (n % 1_000 === 0) expect(j.head).toBe(last.seq);
  }
  expect(j.head).toBe(last.seq);
  expect(j.head).toBe(start + 10_001);
  expect(j.transientStats().bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  // Cursor invariants on top of the corrected head: an evicted gap resets,
  // the cursor at head replays nothing, and head-1 replays exactly the last.
  expect(j.replay({ directory: "/w" }, start)).toBeNull();
  expect(j.replay({ directory: "/w" }, j.head)).toEqual([]);
  expect(j.replay({ directory: "/w" }, j.head - 1)!.map((e) => e.seq)).toEqual([j.head]);
  // A durable event after the transient storm is replayable from the old head.
  const before = j.head;
  const durable = j.append("/w", "s1", { type: "session.idle", properties: { sessionID: "s1" } });
  expect(j.head).toBe(durable.seq);
  expect(j.replay({ directory: "/w" }, before)!.map((e) => e.seq)).toEqual([durable.seq]);
  // Restart: a reopened journal never reports a head below what clients hold.
  db.close();
  db = new Database(file);
  const reopened = new EventJournal(db);
  expect(reopened.head).toBeGreaterThanOrEqual(durable.seq);
  const next = reopened.append("/w", "s1", { type: "session.idle", properties: { sessionID: "s1" } });
  expect(next.seq).toBeGreaterThan(durable.seq);
  expect(reopened.head).toBe(next.seq);
});

it("an event above the wire bound travels as a same-seq oversized stub that fits the client decoder", () => {
  expect(EVENT_FRAME_CHARACTERS).toBeGreaterThan(EVENT_WIRE_LIMIT_BYTES);
  const small: EventEnvelope = { seq: 7, time: 1, directory: "/w", sessionID: "s1", event: { id: "e7", type: "session.idle", properties: { sessionID: "s1" } } };
  expect(wireEnvelope(small)).toBe(JSON.stringify(small));
  const huge: EventEnvelope = { seq: 8, time: 2, directory: "/w", sessionID: "s1",
    event: { id: "e8", type: "message.part.updated", properties: { part: { id: "m#2", sessionID: "s1", messageID: "m", type: "file", url: `data:image/png;base64,${"A".repeat(5 * 1024 * 1024)}` } } } };
  const wire = wireEnvelope(huge);
  expect(Buffer.byteLength(wire)).toBeLessThan(EVENT_WIRE_LIMIT_BYTES);
  expect(JSON.parse(wire)).toEqual({ seq: 8, time: 2, directory: "/w", sessionID: "s1", event: { id: "e8", type: "event.oversized",
    properties: { type: "message.part.updated", bytes: Buffer.byteLength(JSON.stringify(huge)), sessionID: "s1", messageID: "m", partID: "m#2" } } });
});

let h: Harness;
it("a legal >4M durable event does not stall the stream: stub, then later events, and reconnect after it re-sends nothing", async () => {
  h = await harness(); cleanups.push(() => h.stop());
  const dir = h.project("oversized"), sid = await newSession(h, dir);
  const first = stream(h, `directory=${encodeURIComponent(dir)}`); const { head } = await first.hello; first.close(); await first.closed;
  const url = `data:image/png;base64,${"B".repeat(6 * 1024 * 1024)}`;
  const big = h.runtime.journal.append(dir, sid, { type: "message.part.updated", properties: { part: { id: "m#0", sessionID: sid, messageID: "m", type: "file", url } } });
  const after = h.runtime.journal.append(dir, sid, { type: "session.idle", properties: { sessionID: sid } });
  const resumed = stream(h, `directory=${encodeURIComponent(dir)}&after=${head}`);
  await resumed.waitFor((e) => e.seq === after.seq);
  const stub = resumed.events.find((e) => e.seq === big.seq)!;
  expect(stub.event.type).toBe("event.oversized");
  expect(stub.event.properties).toMatchObject({ type: "message.part.updated", sessionID: sid, messageID: "m", partID: "m#0" });
  expect(resumed.resets).toBe(0);
  resumed.close(); await resumed.closed;
  // Reconnecting after the stub replays only what followed it: no endless loop.
  const again = stream(h, `directory=${encodeURIComponent(dir)}&after=${big.seq}`);
  await again.waitFor((e) => e.seq === after.seq);
  expect(again.events.map((e) => e.seq)).toEqual([after.seq]);
  // The durable event itself is intact for the authoritative paths.
  expect(JSON.stringify(h.runtime.journal.replay({ directory: dir }, head, 1)![0].event)).toContain(url.slice(0, 64));
});
