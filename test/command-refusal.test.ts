// @vitest-environment jsdom
// A prompt the runtime durably accepted and then refused BEFORE dispatch (Hub
// failure during model preparation) must not vanish: the ledger's answer
// settles the operation journal record, the original chat shows the exact
// input with its reason, and the state survives navigation/restart because it
// is derived from the durable journal, not from the ephemeral event.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDialogs, routeRuntimeEvent, type RuntimeSyncHost } from "../src/state/runtimeSync";

vi.hoisted(() => { Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }); });

const journalMock = vi.hoisted(() => ({
  records: [] as unknown[],
  writes: [] as unknown[][],
  async list(_workspace: string) { return structuredClone(this.records) as never; },
  async settlePreDispatch(record: { id: string }, state: string) {
    this.writes.push([record.id, state]);
    const stored = this.records.find((r) => (r as { id: string }).id === record.id) as { state: string } | undefined;
    if (!stored || stored.state !== "accepted") return false;
    stored.state = state;
    return true;
  },
  async cancelPrepared() {},
  async settle() { return false; },
  async confirm() { return false; },
  async dispatch() {},
  subscribe() { return () => {}; },
  drain: async () => {},
}));
vi.mock("../src/operations/journal", async (importActual) => ({
  ...(await importActual<typeof import("../src/operations/journal")>()),
  operationJournal: journalMock,
}));

import { store } from "../src/state/store";

const HOST_ID = "0f9f2f6f-33c3-4d3a-9d2c-4a1e0a9d1e11";
const WORKSPACE = "http://127.0.0.1:1/test";

function acceptedRecord(id: string, sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    id, workspace: WORKSPACE, engine: "runtime", sessionId, directory: "/p",
    source: "manual", sourceId: null, text: "Исходный запрос", model: "local-qwen/m",
    state: "accepted", updatedAt: Date.now(), authority: `runtime:${HOST_ID}`, ...overrides,
  };
}

function setup(records: unknown[]) {
  journalMock.records = records.map(r => ({ ...r }));
  journalMock.writes = [];
  localStorage.clear();
  store.state = {
    ...store.state,
    activeSessionId: null,
    runtime: { ...(store.state.runtime ?? {}), hostId: HOST_ID } as never,
    prefs: { ...store.state.prefs, endpoint: WORKSPACE, workspaceKey: null, recoveredOperations: [], dismissedOperations: [] },
    chat: { ...store.state.chat, sessions: {} },
  };
  store.notSent.clear();
}
const settle = () => new Promise((r) => setTimeout(r, 0));

const refusal = (id: string, sessionID: string, state: string, error?: string) => ({
  type: "command.updated",
  properties: { receipt: { id, kind: "prompt", sessionID, state, entryId: null, error, createdAt: 1, updatedAt: 2 } },
});

describe("command.updated routing", () => {
  it("forwards pre-dispatch refusals and cancellations to the delivery surfaces, not other states", () => {
    const refused = vi.fn();
    const host = { queue: vi.fn(), replaceQueues: vi.fn(), dialog: vi.fn(), schedule: vi.fn(), notice: vi.fn(), broker: vi.fn(), commandRefused: refused } as unknown as RuntimeSyncHost;
    expect(routeRuntimeEvent(refusal("m1", "s1", "rejected", "нет связи с Hub") as never, host, new AgentDialogs())).toBe(true);
    expect(refused).toHaveBeenCalledWith({ id: "m1", sessionID: "s1", state: "rejected", error: "нет связи с Hub" });
    routeRuntimeEvent(refusal("m2", "s1", "cancelled") as never, host, new AgentDialogs());
    expect(refused).toHaveBeenLastCalledWith({ id: "m2", sessionID: "s1", state: "cancelled", error: undefined });
    routeRuntimeEvent(refusal("m3", "s1", "completed") as never, host, new AgentDialogs());
    routeRuntimeEvent({ type: "command.updated", properties: {} } as never, host, new AgentDialogs());
    const delivered = refusal("m4", "s1", "cancelled");
    delivered.properties.receipt.entryId = "sdk-user-entry" as never;
    routeRuntimeEvent(delivered as never, host, new AgentDialogs());
    expect(refused).toHaveBeenCalledTimes(2);
  });
});

describe("pre-dispatch refusal in the delivery surfaces", () => {
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });

  it("settles the accepted record once and shows the exact input with its reason in the original chat", async () => {
    setup([acceptedRecord("msg_1", "s1")]);
    (store as unknown as { handleEvent(event: unknown): void }).handleEvent(refusal("msg_1", "s1", "rejected", "Credential store read failed for local-qwen"));
    await settle(); await settle();
    expect(journalMock.writes).toEqual([["msg_1", "refused"]]);
    const notices = store.notSent.get("s1");
    expect(notices).toHaveLength(1);
    expect(notices![0]).toMatchObject({ id: "msg_1", text: "Исходный запрос", state: "refused", reason: "Credential store read failed for local-qwen" });
    // A duplicate or late event cannot settle a second time.
    (store as unknown as { handleEvent(event: unknown): void }).handleEvent(refusal("msg_1", "s1", "rejected", "x"));
    await settle();
    expect(journalMock.writes).toHaveLength(1);
  });

  it("survives a restart: the notice is rebuilt from the durable journal with the ledger reason", async () => {
    setup([acceptedRecord("msg_2", "s1", { state: "refused", updatedAt: Date.now() - 60_000 })]);
    Object.defineProperty(store, "backend", { configurable: true, get: () => ({ client: { receipt: vi.fn(async () => ({ id: "msg_2", state: "rejected", error: "Hub недоступен" })) } }) });
    await store.refreshNotSent("s1");
    expect(store.notSent.get("s1")).toMatchObject([{ id: "msg_2", reason: "Hub недоступен" }]);
    // Positive proof in the transcript outranks the record: the message arrived after all.
    store.state = { ...store.state, chat: { ...store.state.chat, sessions: { s1: { ...store.state.chat.sessions.s1, messageOrder: ["msg_2"], messages: { msg_2: {} } } as never } } };
    await store.refreshNotSent("s1");
    expect(store.notSent.get("s1")).toBeUndefined();
  });

  it("dismissal is persisted and returning to the draft lands the exact text in the original chat", async () => {
    setup([acceptedRecord("msg_3", "s1")]);
    Object.defineProperty(store, "backend", { configurable: true, get: () => ({ client: { receipt: vi.fn(async () => ({ id: "msg_3", state: "rejected", error: "нет связи с Hub" })) } }) });
    await store.refreshNotSent("s1");
    store.dismissNotSent("s1", "msg_3");
    expect(store.notSent.get("s1")).toBeUndefined();
    expect(store.state.prefs.dismissedOperations).toContain("msg_3");

    // Dismissal persists across refreshes (it survives navigation/restart via prefs).
    await store.refreshNotSent("s1");
    expect(store.notSent.get("s1")).toBeUndefined();
    expect(store.state.prefs.dismissedOperations?.filter(x => x === "msg_3")).toHaveLength(1);
  });

  it("returnNotSent restores the exact text into the draft of the original chat and records recovery", async () => {
    setup([acceptedRecord("msg_4", "s1", { state: "refused", updatedAt: Date.now() })]);
    Object.defineProperty(store, "backend", { configurable: true, get: () => ({ client: { receipt: vi.fn(async () => ({ id: "msg_4", state: "rejected", error: "нет связи с Hub" })) } }) });
    await store.refreshNotSent("s1");
    const notice = store.notSent.get("s1")![0]!;
    await store.returnNotSent("s1", notice.record);
    expect(store.state.prefs.recoveredOperations).toContain("msg_4");
    expect(store.state.prefs.drafts[draftKeyFor("s1", "/p")]).toContain("Исходный запрос");
    expect(store.notSent.get("s1")).toBeUndefined();
  });

  it("a record of another ledger authority is never settled by this runtime's events", async () => {
    setup([acceptedRecord("msg_5", "s1", { authority: "runtime:11111111-2222-4333-8444-555555555555", state: "refused", updatedAt: Date.now() })]);
    (store as unknown as { handleEvent(event: unknown): void }).handleEvent(refusal("msg_5", "s1", "rejected", "x"));
    await settle(); await settle();
    expect(journalMock.writes).toEqual([]);
  });
});

function draftKeyFor(sessionId: string, _directory: string): string {
  return sessionId;
}
