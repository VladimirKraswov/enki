// Pre-2.0 UI queue/timer/workspace/lost-ACK preservation through the runtime
// cutover journal. Written, NOT RUN. Each case is one of the actual RED
// invariants: no plain-text conversion, attachments kept, no global marker,
// per-workspace isolation, paused intent, snapshot rename, ledger authority.
import { describe, expect, it, vi } from "vitest";
import type { CutoverBatch, CutoverReceiptDTO } from "../src/agent/runtime/client";
import type { RuntimeBackend } from "../src/agent/runtime/backend";
import { ConnectionError } from "../src/api/http";
import { ledgerAuthority } from "../src/operations/journal";
import { TaskScheduler } from "../src/schedules/tasks";
import { acknowledged, installationId, legacyEngineOf, pruneQueues, queueCutoverItems, timerCutoverItems, unaddressableQueueItems } from "../src/state/cutover";
import { adoptSnapshot, DEFAULT_PREFS, legacyLocalSnapshotKey, type Prefs } from "../src/state/prefs";
import type { QueuedPrompt } from "../src/state/queue";

const item = (id: string, patch: Partial<QueuedPrompt> = {}): QueuedPrompt => ({
  id, text: `text ${id}`, directory: "/work/p", sessionID: "ses_old", model: { providerID: "local", modelID: "qwen", variant: "medium" },
  agent: "build", state: "ready", queuedAt: 10, ...patch,
});
const receipt = (legacyId: string, state: CutoverReceiptDTO["state"], kind: "queue" | "timer" = "queue"): CutoverReceiptDTO =>
  ({ id: `cut-${legacyId}`, legacyId, kind, workspace: "ws", state, sessionID: null, itemID: null, code: state === "quarantined" ? "source_not_imported" : null, reason: null, retryable: true, updatedAt: 1 });

describe("queue cutover items", () => {
  it("keeps text, attachments, model/variant, agent, order and uncertain state; never shortens", async () => {
    const legacy = { ses_old: [item("a"), item("b", { state: "sending", attachments: { scope: "s", files: [{ id: "f1", name: "x.png", mime: "image/png", size: 3 }] } })] };
    const read = vi.fn(async () => ({ parts: [{ type: "file" as const, mime: "image/png", filename: "x.png", url: "data:image/png;base64,AAAA" }], missing: 0 }));
    const items = await queueCutoverItems(legacy, read);
    expect(items.map(i => i.legacyId)).toEqual(["a", "b"]);
    expect(items[0]).toMatchObject({ kind: "queue", session: { engine: "opencode", id: "ses_old", directory: "/work/p" },
      queue: { text: "text a", parts: [], model: { providerID: "local", modelID: "qwen", variant: "medium" }, agent: "build", state: "ready", queuedAt: 10 } });
    expect(items[1].queue).toMatchObject({ state: "uncertain", parts: [{ filename: "x.png" }] });
    expect(items[1].queue?.missingAttachments).toBeUndefined();
  });

  it("an unreadable attachment is counted (runtime quarantines with the payload), never dropped silently", async () => {
    const legacy = { s: [item("c", { sessionID: "chat-1", attachments: { scope: "s", files: [{ id: "f1", name: "a.pdf", mime: "application/pdf", size: 3 }, { id: "f2", name: "b.pdf", mime: "application/pdf", size: 3 }] } })] };
    const [first] = await queueCutoverItems(legacy, async () => { throw new Error("IndexedDB unavailable"); });
    expect(first.queue).toMatchObject({ text: "text c", missingAttachments: 2 });
    expect(first.session.engine).toBe("pi-cli");
  });

  it("only accepted/resolved receipts release backup items; others stay verbatim", () => {
    const legacy = { s1: [item("a"), item("b")], s2: [item("c")] };
    const done = acknowledged([receipt("a", "accepted"), receipt("b", "quarantined"), receipt("c", "resolved")]);
    expect(pruneQueues(legacy, done)).toEqual({ s1: [item("b")] });
    expect(unaddressableQueueItems({ s: [item("x", { directory: "relative" })] })).toBe(1);
  });

  it("uses one stable installation id and derives the legacy engine from the source id", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    const id = installationId(storage);
    expect(installationId(storage)).toBe(id);
    expect(legacyEngineOf("ses_abc")).toBe("opencode");
    expect(legacyEngineOf("chat-abc")).toBe("pi-cli");
  });
});

function memoryStorage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: vi.fn((k: string) => values.get(k) ?? null), setItem: vi.fn((k: string, v: string) => { values.set(k, v); }) };
}
const timer = (id: string, server: string, patch: Record<string, unknown> = {}) => ({ id, server, directory: "/work/p", sessionID: "ses_old", engine: "opencode",
  title: `t ${id}`, prompt: "check", minutes: 30, mode: "repeat", model: { providerID: "local", modelID: "qwen" }, enabled: true, nextAt: 5, state: "ready", ...patch });

describe("timer cutover (TaskScheduler.migrateLegacy)", () => {
  const scope = { installation: "inst-0001", workspace: "enki-runtime:local", servers: ["http://127.0.0.1:4096"] };
  function backend(answer: (batch: CutoverBatch) => Promise<{ receipts: CutoverReceiptDTO[] }>) {
    const cutover = vi.fn(answer);
    return { cutover, backend: { client: { cutover }, schedules: vi.fn(async () => ({ tasks: [] })) } as unknown as RuntimeBackend };
  }

  it("a transient transport failure marks nothing and keeps every old record", async () => {
    const raw = JSON.stringify([timer("t1", "http://127.0.0.1:4096")]);
    const storage = memoryStorage({ "ocdesktop.scheduled-prompts.v1": raw });
    const { backend: b } = backend(async () => { throw new ConnectionError(); });
    await expect(new TaskScheduler().migrateLegacy(storage, b, scope)).rejects.toThrow();
    expect(storage.values.get("ocdesktop.scheduled-prompts.v1")).toBe(raw);
    expect(storage.setItem).not.toHaveBeenCalled(); // no global ".migrated" marker
  });

  it("other workspaces' timers are untouched; only accepted items leave storage", async () => {
    const list = [timer("t1", "http://127.0.0.1:4096"), timer("t2", "http://127.0.0.1:4096", { enabled: false }), timer("r1", "ssh:host:22")];
    const storage = memoryStorage({ "ocdesktop.scheduled-prompts.v1": JSON.stringify(list) });
    const { backend: b, cutover } = backend(async () => ({ receipts: [receipt("t1", "accepted", "timer"), receipt("t2", "quarantined", "timer")] }));
    const result = await new TaskScheduler().migrateLegacy(storage, b, scope);
    const batch = cutover.mock.calls[0][0];
    expect(batch).toMatchObject({ installation: "inst-0001", workspace: "enki-runtime:local", source: "ui-timers" });
    expect(batch.items.map(i => i.legacyId)).toEqual(["t1", "t2"]); // never the remote workspace's timer
    expect(batch.items[1].timer?.enabled).toBe(false); // paused intent travels to the atomic runtime publication
    expect(result).toMatchObject({ accepted: 1, quarantined: [expect.objectContaining({ legacyId: "t2" })] });
    expect(JSON.parse(storage.values.get("ocdesktop.scheduled-prompts.v1")!).map((t: { id: string }) => t.id)).toEqual(["t2", "r1"]);
  });

  it("a malformed record cannot reject the batch; it stays in storage", () => {
    const { items, invalid } = timerCutoverItems([timer("ok", "a"), { id: "bad", server: "a" }, timer("empty", "a", { prompt: "  " })], ["a"]);
    expect(items.map(i => i.legacyId)).toEqual(["ok"]);
    expect(invalid).toBe(2);
  });
});

describe("workspace snapshots and lost-ACK authority", () => {
  it("remote→local finds the old local snapshot by its stable identity, never a remote one", () => {
    const prefs: Prefs = { ...DEFAULT_PREFS, workspaceKey: "ssh:host:22", localWorkspace: "http://127.0.0.1:4096",
      endpointState: { "http://127.0.0.1:4096": { drafts: { s: "мой черновик" } }, "ssh:other:22": { drafts: { r: "remote" } } } };
    expect(legacyLocalSnapshotKey(prefs, "enki-runtime:local")).toBe("http://127.0.0.1:4096");
    const adopted = adoptSnapshot(prefs, "http://127.0.0.1:4096", "enki-runtime:local");
    expect(adopted.endpointState?.["enki-runtime:local"]?.drafts).toEqual({ s: "мой черновик" });
    expect(adopted.endpointState?.["http://127.0.0.1:4096"]).toBeDefined(); // backup kept
    expect(legacyLocalSnapshotKey({ ...prefs, localWorkspace: "ssh:other:22", localEndpoint: undefined }, "enki-runtime:local")).toBeNull();
    expect(legacyLocalSnapshotKey(prefs, "ssh:host:22")).toBeNull();
  });

  it("only a record bound to a runtime ledger has an authority that can disprove delivery", () => {
    expect(ledgerAuthority({ authority: "runtime:00000000-0000-4000-8000-000000000000" })).toBe("runtime:00000000-0000-4000-8000-000000000000");
    expect(ledgerAuthority({})).toBeNull(); // pre-2.0 OpenCode/Pi CLI record: a 2.0 404 is "unknown"
    expect(ledgerAuthority({ authority: "opencode" })).toBeNull();
  });
});
