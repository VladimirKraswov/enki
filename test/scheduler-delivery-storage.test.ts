// The window no longer stores schedules or acknowledgements. "Never re-deliver
// an accepted wake-up when recording its acknowledgement fails" is a runtime
// invariant: src-tauri/resources/agent/test/scheduler-unit.test.ts. What remains
// here is the one-time move of old browser-stored records through the runtime's
// durable cutover journal (TaskScheduler.migrateLegacy(storage, backend, scope),
// POST /migrations/cutover): a storage fault must never lose the raw backup or
// create duplicates in the runtime, and one refused chat never aborts the others.
import { afterEach, expect, it, vi } from "vitest";
import type { CutoverBatch, CutoverReceiptDTO } from "../src/agent/runtime/client";
import { TaskScheduler } from "../src/schedules/tasks";
import { runtimeFixture } from "./helpers/runtime-fixture";

const KEY = "ocdesktop.scheduled-prompts.v1";
const scope = { installation: "inst-0001", workspace: "enki-runtime:local", servers: ["local"] };
const record = { id: "old-1", server: "local", directory: "/project", sessionID: "s", engine: "opencode", title: "CI", prompt: "check", minutes: 15,
  model: { providerID: "p", modelID: "m" }, enabled: true, nextAt: 1, state: "ready" };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Runtime cutover journal: idempotent by (installation, workspace, source, kind, legacyId). */
async function connected(refuse: (legacyId: string, sessionID: string) => boolean = () => false) {
  const fx = runtimeFixture();
  const journal = new Map<string, CutoverReceiptDTO>();
  fx.on("POST", "/migrations/cutover", c => {
    const batch = c.body as CutoverBatch;
    return { receipts: batch.items.map(item => {
      const key = JSON.stringify([batch.installation, batch.workspace, batch.source, item.kind, item.legacyId]);
      const known = journal.get(key);
      if (known) return known;
      const refused = refuse(item.legacyId, item.session.id);
      const receipt: CutoverReceiptDTO = { id: `cut-${journal.size + 1}`, legacyId: item.legacyId, kind: item.kind, workspace: batch.workspace,
        state: refused ? "quarantined" : "accepted", sessionID: refused ? null : "rt-chat", itemID: refused ? null : `rt-${item.legacyId}`,
        code: refused ? "source_read_only" : null, reason: refused ? "Чат архивирован." : null, retryable: !refused, updatedAt: 1 };
      journal.set(key, receipt);
      return receipt;
    }) };
  });
  const scheduler = new TaskScheduler();
  scheduler.attach(null, "local");
  scheduler.attach(fx.backend, "local");
  await vi.waitFor(() => expect(scheduler.status().storage).toBe("ok"));
  return { fx, scheduler, journal };
}
const batches = (fx: ReturnType<typeof runtimeFixture>) => fx.made("POST", "/migrations/cutover").map(c => c.body as CutoverBatch);

it("a failed backup write keeps the raw backup and a retry creates no duplicate runtime timer", async () => {
  const { fx, scheduler, journal } = await connected();
  const raw = JSON.stringify([record]);
  const values = new Map([[KEY, raw]]);
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: () => { throw new Error("quota exceeded"); } };
  expect(await scheduler.migrateLegacy(storage, fx.backend, scope)).toMatchObject({ accepted: 1, backupRetained: true });
  expect(await scheduler.migrateLegacy(storage, fx.backend, scope)).toMatchObject({ accepted: 1, backupRetained: true });
  expect(batches(fx).map(b => b.items.map(i => i.legacyId))).toEqual([["old-1"], ["old-1"]]);
  expect(batches(fx).every(b => b.installation === "inst-0001" && b.workspace === "enki-runtime:local" && b.source === "ui-timers")).toBe(true);
  expect(journal.size).toBe(1);
  expect(values.get(KEY)).toBe(raw);
  expect(fx.made("POST", "/schedules")).toHaveLength(0);
  expect(fx.made("POST", "/commands")).toHaveLength(0);
});

it("preserves corrupt raw schedules and imports nothing from them", async () => {
  const { fx, scheduler } = await connected();
  const raw = "{bad schedule";
  const values = new Map([[KEY, raw]]);
  const writes: string[] = [];
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string) => { writes.push(k); } };
  expect(await scheduler.migrateLegacy(storage, fx.backend, scope)).toMatchObject({ accepted: 0, invalid: 1 });
  expect(values.get(KEY)).toBe(raw);
  expect(writes).toEqual([]);
  expect(batches(fx)).toHaveLength(0);
});

it("a chat the runtime refuses keeps its old record for the user instead of aborting the others", async () => {
  const { fx, scheduler } = await connected((_id, sessionID) => sessionID === "archived");
  const values = new Map([[KEY, JSON.stringify([{ ...record, id: "a", sessionID: "archived" }, { ...record, id: "b" }])]]);
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
  const result = await scheduler.migrateLegacy(storage, fx.backend, scope);
  expect(result).toMatchObject({ accepted: 1, quarantined: [expect.objectContaining({ legacyId: "a", state: "quarantined" })] });
  expect(batches(fx)[0].items.map(i => i.session.id)).toEqual(["archived", "s"]);
  const kept = JSON.parse(values.get(KEY)!) as Array<{ id: string }>;
  expect(kept.map(t => t.id)).toEqual(["a"]);
  expect(fx.made("POST", "/commands")).toHaveLength(0);
});
