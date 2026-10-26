import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PromptQueue } from "../src/queue/queue.ts";
import { AttachmentStore } from "../src/store/attachments.ts";
import { CommandLedger } from "../src/store/commands.ts";
import { Database } from "../src/store/db.ts";
import { EventJournal } from "../src/store/events.ts";
import { tempDir } from "./helpers.ts";

let db: Database, queue: PromptQueue, ledger: CommandLedger, journal: EventJournal;
beforeEach(() => {
  const root = tempDir("correction-delivery"); db = new Database(path.join(root, "runtime.db"));
  journal = new EventJournal(db); ledger = new CommandLedger(db, journal);
  queue = new PromptQueue(db, journal, new AttachmentStore(db, root));
});
afterEach(() => { queue.close(); db.close(); });
const begin = (id = "fix", sessionID = "s1", directory = "/p") => ledger.begin({ id, kind: "steer", sessionID, directory,
  payload: { parts: [{ type: "text", text: "Только бэкап системы" }, { type: "text", text: "private marker", synthetic: true },
    { type: "file", filename: "source.png", mime: "image/png", url: "data:image/png;base64,private" }],
  model: { providerID: "p", modelID: "m" }, source: "queue", sourceId: "old-removed-queue-row" } });

it("keeps an accepted correction visible from its durable ledger after its queue row disappeared", () => {
  begin(); ledger.update("fix", "running");
  expect(queue.state("s1")).toMatchObject({ items: [], corrections: [{ id: "fix", text: "Только бэкап системы", state: "running", attachments: [{ name: "source.png" }] }] });
  expect(JSON.stringify(queue.state("s1"))).not.toContain("private");
  expect(queue.sessions("/p").map(s => s.sessionID)).toEqual(["s1"]);
  expect(queue.sessions("/other")).toEqual([]);
  expect(queue.hasWork("s1")).toBe(false); // a receipt must never become a second queued prompt
});

it("publishes delivery only when the SDK user entry is durably recorded", async () => {
  begin(); ledger.update("fix", "running");
  const changes: unknown[] = [];
  const unsubscribe = journal.subscribe({ all: true }, e => { if (e.event.type === "queue.updated") changes.push(e.event.properties?.queue); });
  ledger.recordEntry("fix", "sdk-entry");
  await Promise.resolve();
  expect(queue.state("s1").corrections).toEqual([]);
  expect(changes).toContainEqual(expect.objectContaining({ sessionID: "s1", corrections: [] }));
  unsubscribe();
});

it("keeps SSE sequence order monotonic while projecting receipt updates", async () => {
  const sequence: number[] = [];
  const unsubscribe = journal.subscribe({ all: true }, e => sequence.push(e.seq));
  begin(); ledger.update("fix", "running"); await Promise.resolve();
  expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
  expect(new Set(sequence).size).toBe(sequence.length);
  unsubscribe();
});

it("reconstructs uncertainty after restart without replaying or inventing delivery", () => {
  begin(); ledger.update("fix", "running"); ledger.recoverAfterRestart();
  queue.close(); queue = new PromptQueue(db, journal, new AttachmentStore(db, tempDir("correction-reload")));
  expect(queue.sessions("/p")[0].corrections).toEqual([expect.objectContaining({ id: "fix", state: "uncertain", text: "Только бэкап системы" })]);
  expect(queue.state("s1").items).toEqual([]);
  expect(queue.state("other").corrections).toEqual([]);
});

it("withdrawn corrections are not shown as waiting and a stopped correction is restored without internal policy text", async () => {
  const { steeringText } = await import("../src/policy/prompt.ts");
  begin(); ledger.update("fix", "cancelled");
  expect(queue.state("s1").corrections).toEqual([]);
  queue.restoreUndelivered("s1", "/p", [steeringText("s1", "Только бэкап системы")], { providerID: "p", modelID: "m" });
  expect(queue.state("s1").items[0].text).toBe("Только бэкап системы");
});
