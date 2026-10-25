// Remainder review: whole-turn Hub authority, re-homed from the retired UI
// coordinator (test/model-hub.test.ts cases 2, 4, 9, 10, 11 and the runtime
// "slow discovery" gap). Real Runtime + real SDK + scripted provider; the Hub
// is a fake broker that speaks the native envelope `ENKI_HUB_ERROR:{code,status}`
// (src-tauri/src/hub/errors.rs). Written, NOT RUN.
//   - renewal DURING a live tool call and a held stream; no release before the
//     turn settled; release only after it;
//   - an explicitly expired INACTIVE lease is replaced once (fresh key); an
//     expired lease of a RUNNING turn stops that turn, never re-prepares;
//   - generic 409 (status or prepare) never starts another reservation;
//   - only an explicitly expired requestKey is refreshed, once, with a new key;
//   - failed/error loader is terminal: no SDK call, no late "ready" overwrite;
//   - slow initial discovery holds the turn; a temporary catalog outage refuses
//     then recovers through the Hub; a Hub model check never prepares.
import { afterEach, expect, it } from "vitest";
import { Type } from "typebox";
import type { Broker, BrokerMethod } from "../../src/control/broker.ts";
import { fauxAssistantMessage, fauxToolCall } from "../../src/sdk/testing.ts";
import { extension, gate, harness, newSession, promptCommand, type Harness } from "../helpers.ts";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

const MODEL = { providerID: "enki-scripted", modelID: "scripted-large" };
const ROUTE = { service: "gpu", label: "GPU", ...MODEL, agent: "pi", target: MODEL.modelID };
const T1 = "12345678-1234-1234-1234-123456789012";
const T2 = "22345678-1234-1234-1234-123456789012";
type Call = { path: string; body: Record<string, unknown> | null };
type Handler = (path: string, body: Record<string, unknown> | null) => unknown;

const status = (ticket: string, extra: Record<string, unknown> = {}) => ({ schema: 1, operation_id: ticket, phase: "ready", ready: true,
  active_model: MODEL.modelID, target_model: MODEL.modelID, elapsed_seconds: 1, active_requests: 0, error: null, loader: null, ...extra });
const envelope = (code: string, statusCode: number | null) => new Error(`ENKI_HUB_ERROR:${JSON.stringify({ code, status: statusCode })}`);

function hub(handle: Handler, catalog: () => unknown | Promise<unknown> = () => ({ schema: 1, routes: [ROUTE] })) {
  const calls: Call[] = [];
  const broker: Broker = {
    kind: "supervisor",
    available: () => true,
    async call<T>(method: BrokerMethod, params: Record<string, unknown>): Promise<T> {
      if (method === "hub.identity") return { scope: "hub-test" } as T;
      const path = String(params.path).replace("model-services/", "");
      const body = (params.body ?? null) as Record<string, unknown> | null;
      calls.push({ path, body });
      if (path === "catalog") return await catalog() as T;
      return await handle(path, body) as T;
    },
  };
  const of = (path: string) => calls.filter((c) => c.path === path);
  return { broker, calls, of, keys: () => of("prepare").map((c) => String(c.body?.requestKey)) };
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`not reached: ${label}`);
}

it("renews DURING a live tool call and a held stream, and releases only after the turn settled", async () => {
  const tool = gate(), stream = gate();
  let toolStarted = false;
  const releases: Array<{ running: boolean | undefined; receipt: string | undefined }> = [];
  const fake = hub((path) => {
    if (path === "release") releases.push({ running: h?.runtime.registry.live(sid)?.turnRunning(), receipt: h?.runtime.ledger.get("whole")?.state });
    return status(T1);
  });
  let sid = "";
  h = await harness({ broker: fake.broker, extraExtensions: () => [extension("held", (pi) => pi.registerTool({
    name: "held_tool", label: "Held tool", description: "Waits for the test", parameters: Type.Object({}),
    execute: async () => { toolStarted = true; await tool.wait; return { content: [{ type: "text", text: "tool done" }], details: {} }; },
  }))] });
  const dir = h.project("hub-whole");
  sid = await newSession(h, dir, { permission: [{ permission: "*", pattern: "*", action: "allow" }] });
  h.scripted.setResponses([
    fauxAssistantMessage([fauxToolCall("held_tool", {})], { stopReason: "toolUse" }),
    async () => { await stream.wait; return fauxAssistantMessage("gpu answer"); },
  ]);
  await h.command(promptCommand(h, "whole", sid, dir, "go"));
  await h.waitReceipt("whole", ["running"]);
  // (1) The tool call is executing: renewal reads the ticket, never releases.
  await until(() => toolStarted, "tool started");
  const before = fake.of("status").length;
  await h.runtime.hub.renew();
  // (>= : the runtime's own 15 s heartbeat may also have renewed meanwhile)
  expect(fake.of("status").length).toBeGreaterThan(before);
  expect(fake.of("status").at(-1)?.body).toEqual({ ticket: T1 });
  expect(releases).toEqual([]);
  tool.open();
  // (2) The second provider call streams (held): still renewed, still held.
  await until(() => h!.scripted.calls() === 2, "second provider call");
  const during = fake.of("status").length;
  await h.runtime.hub.renew();
  expect(fake.of("status").length).toBeGreaterThan(during);
  expect(releases).toEqual([]);
  expect(h.runtime.registry.live(sid)?.turnRunning()).toBe(true);
  stream.open();
  expect((await h.waitReceipt("whole", ["completed", "failed", "rejected"])).state).toBe("completed");
  // (3) Settled: the next renewal releases exactly this ticket, once.
  await until(() => !h!.runtime.dispatcher.inFlight(sid), "settled");
  await h.runtime.hub.renew();
  expect(fake.of("release").map((c) => c.body)).toEqual([{ ticket: T1 }]);
  expect(releases).toEqual([{ running: false, receipt: "completed" }]);
  expect(fake.of("prepare")).toHaveLength(1);
  expect(fake.of("prepare")[0].body).toMatchObject({ mode: "run", ...MODEL });
  expect(h.scripted.calls()).toBe(2);
});

it("an explicitly expired INACTIVE lease is replaced once with a fresh key; the old ticket is not reused", async () => {
  let expired = false, issued = 0;
  const fake = hub((path, body) => {
    if (path === "prepare") return status(issued++ === 0 ? T1 : T2);
    if (path === "status" && expired && body?.ticket === T1) throw envelope("lease_expired", 409);
    return status(String(body?.ticket ?? T1));
  });
  h = await harness({ broker: fake.broker });
  const dir = h.project("hub-expired-idle"), sid = await newSession(h, dir);
  h.scripted.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
  await h.command(promptCommand(h, "idle-1", sid, dir, "first"));
  expect((await h.waitReceipt("idle-1", ["completed", "failed", "rejected"])).state).toBe("completed");
  // No renewal ran: the settled session still holds its (now expiring) lease.
  expired = true;
  await h.command(promptCommand(h, "idle-2", sid, dir, "second"));
  expect((await h.waitReceipt("idle-2", ["completed", "failed", "rejected"])).state).toBe("completed");
  const keys = fake.keys();
  expect(keys).toHaveLength(2);
  expect(keys[1]).not.toBe(keys[0]);
  expect(fake.of("release").map((c) => c.body)).not.toContainEqual({ ticket: T2 });
  expect(h.scripted.calls()).toBe(2);
  // The replacement is the held lease now.
  await h.runtime.hub.renew();
  expect(fake.of("release").map((c) => c.body)).toContainEqual({ ticket: T2 });
});

it("an expired lease of a RUNNING turn stops that turn truthfully and is never re-prepared mid-turn", async () => {
  let expired = false;
  const fake = hub((path) => {
    if (path === "status" && expired) throw envelope("lease_expired", 409);
    return status(T1);
  });
  h = await harness({ broker: fake.broker });
  const dir = h.project("hub-expired-active"), sid = await newSession(h, dir);
  h.scripted.setResponses([async (_c, options) => {
    await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve, { once: true }));
    return fauxAssistantMessage("late", { stopReason: "aborted" });
  }]);
  const cursor = h.runtime.journal.head;
  await h.command(promptCommand(h, "active", sid, dir, "long gpu work"));
  await h.waitReceipt("active", ["running"]);
  expired = true;
  await h.runtime.hub.renew();
  const receipt = await h.waitReceipt("active", ["cancelled", "failed", "completed"]);
  expect(receipt.state).not.toBe("completed");
  const lost = (h.runtime.journal.replay({ all: true, sessionID: sid }, cursor) ?? [])
    .filter((e) => e.event.type === "session.error" && (e.event.properties.error as { name?: string }).name === "HubLeaseLost");
  expect(lost).toHaveLength(1);
  expect(String((lost[0].event.properties.error as { message: string }).message)).toMatch(/Hub завершил заявку/);
  expect(fake.of("prepare")).toHaveLength(1);
  expect(fake.of("release")).toEqual([]);
  expect(h.scripted.calls()).toBe(1);
});

it("a generic 409 on an existing lease's status keeps the lease and refuses; no second reservation", async () => {
  let conflict = false;
  const fake = hub((path) => {
    if (path === "status" && conflict) throw envelope("http", 409);
    return status(T1);
  });
  h = await harness({ broker: fake.broker });
  const dir = h.project("hub-409-status"), sid = await newSession(h, dir);
  h.scripted.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("must not run")]);
  await h.command(promptCommand(h, "s409-1", sid, dir, "first"));
  expect((await h.waitReceipt("s409-1", ["completed", "failed", "rejected"])).state).toBe("completed");
  conflict = true;
  await h.command(promptCommand(h, "s409-2", sid, dir, "second"));
  const refused = await h.waitReceipt("s409-2", ["completed", "failed", "rejected"]);
  expect(refused.state).toBe("rejected");
  expect(refused.error).toMatch(/конфликтует/);
  expect(refused.error).not.toMatch(/ENKI_HUB_ERROR/);
  expect(fake.of("prepare")).toHaveLength(1);
  expect(fake.of("release")).toEqual([]);
  expect(h.scripted.calls()).toBe(1);
});

it("a generic 409 on prepare is answered once and refused; it never starts another operation", async () => {
  const fake = hub((path) => { if (path === "prepare") throw envelope("http", 409); return status(T1); });
  h = await harness({ broker: fake.broker });
  const dir = h.project("hub-409-prepare"), sid = await newSession(h, dir);
  h.scripted.setResponses([fauxAssistantMessage("must not run")]);
  await h.command(promptCommand(h, "p409", sid, dir, "go"));
  const refused = await h.waitReceipt("p409", ["completed", "failed", "rejected"]);
  expect(refused.state).toBe("rejected");
  expect(refused.error).toMatch(/конфликтует/);
  expect(refused.error).not.toMatch(/ENKI_HUB_ERROR/);
  expect(fake.of("prepare")).toHaveLength(1);
  expect(h.scripted.calls()).toBe(0);
});

it("only an explicitly expired requestKey is refreshed, once, under a NEW key", async () => {
  let prepares = 0;
  const fake = hub((path) => {
    if (path === "prepare" && prepares++ === 0) throw envelope("lease_expired", 409);
    return status(T1);
  });
  h = await harness({ broker: fake.broker });
  const dir = h.project("hub-expired-key"), sid = await newSession(h, dir);
  h.scripted.setResponses([fauxAssistantMessage("answer")]);
  await h.command(promptCommand(h, "key", sid, dir, "go"));
  expect((await h.waitReceipt("key", ["completed", "failed", "rejected"])).state).toBe("completed");
  const keys = fake.keys();
  expect(keys).toHaveLength(2);
  expect(keys[1]).not.toBe(keys[0]);
  expect(h.scripted.calls()).toBe(1);
});

for (const [label, prepared, polled] of [
  ["a failed loader phase", status(T1, { phase: "failed", ready: false, active_model: null, error: "Загрузка не удалась" }), null],
  ["a loader error while loading", status(T1, { phase: "loading", ready: false, active_model: null, loader: { phase: "weights", unit: "bytes", current: 10, total: 100 } }),
    status(T1, { phase: "loading", ready: false, active_model: null, error: "CUDA: недостаточно памяти" })],
] as const) {
  it(`${label} is terminal: refused, ticket released, no SDK call and no late "ready" overwrite`, async () => {
    let lateReady = false;
    const fake = hub((path) => {
      if (path === "prepare") return prepared;
      if (path === "status") return lateReady ? status(T1) : polled;
      return { released: true };
    });
    h = await harness({ broker: fake.broker });
    const dir = h.project("hub-loader"), sid = await newSession(h, dir);
    h.scripted.setResponses([fauxAssistantMessage("must not run")]);
    await h.command(promptCommand(h, "loader", sid, dir, "go"));
    const refused = await h.waitReceipt("loader", ["completed", "failed", "rejected"]);
    expect(refused.state).toBe("rejected");
    expect(refused.error).toMatch(polled ? /CUDA/ : /Загрузка не удалась/);
    expect(fake.of("release").map((c) => c.body)).toEqual([{ ticket: T1 }]);
    expect(fake.of("prepare")).toHaveLength(1);
    expect(fake.of("prepare").every((c) => c.body?.mode === "run")).toBe(true);
    expect(h.scripted.calls()).toBe(0);
    // The Hub later reports the old ticket ready: nothing polls or adopts it.
    lateReady = true;
    const statusCalls = fake.of("status").length;
    await h.runtime.hub.renew();
    await new Promise((r) => setTimeout(r, 1_000));
    expect(fake.of("status").length).toBe(statusCalls);
    expect(h.runtime.hub.status(sid)?.ready).toBe(false);
    expect(h.runtime.ledger.get("loader")?.state).toBe("rejected");
    expect(h.scripted.calls()).toBe(0);
  });
}

it("slow initial catalog discovery holds the turn; nothing is sent directly before the Hub decides", async () => {
  const catalog = gate();
  let catalogReads = 0;
  const fake = hub(() => status(T1), async () => { catalogReads++; await catalog.wait; return { schema: 1, routes: [ROUTE] }; });
  h = await harness({ broker: fake.broker });
  const dir = h.project("hub-slow"), sid = await newSession(h, dir);
  h.scripted.setResponses([fauxAssistantMessage("gpu answer")]);
  await h.command(promptCommand(h, "slow", sid, dir, "go"));
  await until(() => catalogReads > 0, "catalog requested");
  await new Promise((r) => setTimeout(r, 500));
  expect(h.runtime.ledger.get("slow")?.state).toBe("accepted");
  expect(h.scripted.calls()).toBe(0);
  expect(fake.of("prepare")).toHaveLength(0);
  catalog.open();
  expect((await h.waitReceipt("slow", ["completed", "failed", "rejected"])).state).toBe("completed");
  expect(fake.of("prepare")).toHaveLength(1);
  expect(h.scripted.calls()).toBe(1);
});

it("a temporary catalog outage refuses without a direct send, then recovers through the Hub", async () => {
  let outage = true;
  const fake = hub(() => status(T1), () => { if (outage) throw envelope("http", 503); return { schema: 1, routes: [ROUTE] }; });
  h = await harness({ broker: fake.broker });
  const dir = h.project("hub-outage"), sid = await newSession(h, dir);
  h.scripted.setResponses([fauxAssistantMessage("gpu answer")]);
  await h.command(promptCommand(h, "outage-1", sid, dir, "go"));
  const refused = await h.waitReceipt("outage-1", ["completed", "failed", "rejected"]);
  expect(refused.state).not.toBe("completed");
  expect(refused.error).toMatch(/каталог моделей Hub/);
  expect(refused.error).not.toMatch(/ENKI_HUB_ERROR/);
  expect(h.scripted.calls()).toBe(0);
  outage = false;
  await h.command(promptCommand(h, "outage-2", sid, dir, "again"));
  expect((await h.waitReceipt("outage-2", ["completed", "failed", "rejected"])).state).toBe("completed");
  expect(h.runtime.hub.route(MODEL.providerID, MODEL.modelID)).toBeDefined();
  expect(fake.of("prepare")).toHaveLength(1);
  expect(h.scripted.calls()).toBe(1);
});

it("a lost ACK in the native envelope is retried once with the SAME key; a second loss refuses (bounded)", async () => {
  let losses = 0, allowed = 1;
  const fake = hub((path) => {
    if (path === "prepare" && losses < allowed) { losses++; throw envelope("interrupted", null); }
    return status(T1);
  });
  h = await harness({ broker: fake.broker });
  const dir = h.project("hub-ack-envelope"), sid = await newSession(h, dir);
  h.scripted.setResponses([fauxAssistantMessage("gpu answer"), fauxAssistantMessage("must not run")]);
  await h.command(promptCommand(h, "ack-1", sid, dir, "go"));
  expect((await h.waitReceipt("ack-1", ["completed", "failed", "rejected"])).state).toBe("completed");
  expect(fake.keys()).toHaveLength(2);
  expect(fake.keys()[1]).toBe(fake.keys()[0]);
  // Drop the held lease so the next turn must prepare again.
  await h.runtime.hub.release(sid);
  losses = 0; allowed = 2;
  await h.command(promptCommand(h, "ack-2", sid, dir, "again"));
  const refused = await h.waitReceipt("ack-2", ["completed", "failed", "rejected"]);
  expect(refused.state).toBe("rejected");
  expect(refused.error).toMatch(/оборвалось/);
  const keys = fake.keys().slice(2);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect(h.scripted.calls()).toBe(1);
});

it("a readiness check of a Hub-owned model never prepares, selects or calls the model", async () => {
  const fake = hub(() => { throw new Error("a check must not reach prepare/status"); });
  h = await harness({ broker: fake.broker });
  const result = await h.request<{ message?: string }>("POST", "/models/check", MODEL);
  expect(result.status).toBe(409);
  expect(fake.calls.map((c) => c.path).every((p) => p === "catalog")).toBe(true);
  expect(h.scripted.calls()).toBe(0);
});

it("an expired key twice in a row is not refreshed again (bounded) and nothing is sent", async () => {
  const fake = hub((path) => { if (path === "prepare") throw envelope("lease_expired", 409); return status(T1); });
  h = await harness({ broker: fake.broker });
  const dir = h.project("hub-expired-twice"), sid = await newSession(h, dir);
  h.scripted.setResponses([fauxAssistantMessage("must not run")]);
  await h.command(promptCommand(h, "twice", sid, dir, "go"));
  const refused = await h.waitReceipt("twice", ["completed", "failed", "rejected"]);
  expect(refused.state).toBe("rejected");
  expect(refused.error).toMatch(/Срок заявки/);
  expect(fake.keys()).toHaveLength(2);
  expect(h.scripted.calls()).toBe(0);
});
