// Final seam review: an explicitly expired or replaced Hub reservation stops
// EVERY inference that depends on it, not only a dispatched turn: the source
// model's summary before a switch to a smaller target, and a manual compaction.
// After the loss nothing continues into the target (no prepare, select or call),
// the receipt is a truthful cancellation, and only owned tickets are released
// (the ended ticket is never released again). Real Runtime + pinned SDK +
// scripted provider; the Hub is a fake broker. Written, NOT RUN.
import { afterEach, expect, it } from "vitest";
import type { Broker, BrokerMethod } from "../../src/control/broker.ts";
import { fauxAssistantMessage, type FauxResponseStep } from "../../src/sdk/testing.ts";
import { gate, harness, newSession, promptCommand, type Harness } from "../helpers.ts";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

const LARGE = "scripted-large";
const ROUTE = { service: "gpu", label: "GPU", providerID: "enki-scripted", modelID: LARGE, agent: "pi", target: LARGE };
const T1 = "12345678-1234-1234-1234-123456789012";
const T2 = "22345678-1234-1234-1234-123456789012";
type Loss = "ok" | "expired" | "replaced";
type Call = { path: string; body: Record<string, unknown> | null };

const status = (ticket: string) => ({ schema: 1, operation_id: ticket, phase: "ready", ready: true,
  active_model: LARGE, target_model: LARGE, elapsed_seconds: 1, active_requests: 0, error: null, loader: null });

/** Only the large (source) model is Hub-routed; the small target is direct. */
function hub(mode: () => Loss) {
  const calls: Call[] = [];
  const broker: Broker = {
    kind: "supervisor",
    available: () => true,
    async call<T>(method: BrokerMethod, params: Record<string, unknown>): Promise<T> {
      if (method === "hub.identity") return { scope: "hub-test" } as T;
      const path = String(params.path).replace("model-services/", "");
      const body = (params.body ?? null) as Record<string, unknown> | null;
      calls.push({ path, body });
      if (path === "catalog") return { schema: 1, routes: [ROUTE] } as T;
      if (path === "release") return {} as T;
      if (path === "status" && mode() === "expired") throw new Error(`ENKI_HUB_ERROR:${JSON.stringify({ code: "lease_expired", status: 409 })}`);
      // Another reservation now owns the GPU: our ticket is no longer the active one.
      if (path === "status" && mode() === "replaced") return status(T2) as T;
      return status(T1) as T;
    },
  };
  return { broker, calls, of: (path: string) => calls.filter((c) => c.path === path) };
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`not reached: ${label}`);
}

/** Two long Hub-routed turns on the large model (its lease stays held). */
async function longChat(h: Harness, dir: string, prefix: string): Promise<string> {
  h.runtime.saveSettings({ ...h.runtime.settings(), compaction: { enabled: true, keepRecentTokens: 64, reserveTokens: 64 } });
  const sid = await newSession(h, dir, { model: h.model("large") });
  h.scripted.setResponses([fauxAssistantMessage("noted ".repeat(800)), fauxAssistantMessage("noted again ".repeat(100))]);
  for (const [n, text] of [[1, "context ".repeat(4000)], [2, "more context ".repeat(2000)]] as const) {
    await h.command(promptCommand(h, `${prefix}-long-${n}`, sid, dir, text, h.model("large")));
    expect((await h.waitReceipt(`${prefix}-long-${n}`, ["completed", "failed", "rejected"])).state).toBe("completed");
  }
  return sid;
}

/** Every large-model call is a summary held until the test opens it or the SDK aborts it. */
function heldSummaries(h: Harness, log: string[], hold: { wait: Promise<void> }, entered: () => void): void {
  const step: FauxResponseStep = async (_context, options, _state, model) => {
    log.push(`call:${model.id}`);
    if (model.id === h.scripted.models.large) {
      entered();
      await Promise.race([hold.wait, new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      })]);
      if (options?.signal?.aborted) return fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "aborted" });
      return fauxAssistantMessage("Short summary of the task so far.");
    }
    return fauxAssistantMessage("small answer");
  };
  h.scripted.setResponses(Array.from({ length: 6 }, () => step));
}

function events(h: Harness, sid: string, after: number) {
  return (h.runtime.journal.replay({ all: true, sessionID: sid }, after) ?? []).map((e) => e.event);
}
const lostNotices = (h: Harness, sid: string, after: number) =>
  events(h, sid, after).filter((e) => e.type === "session.error" && (e.properties.error as { name?: string }).name === "HubLeaseLost");

for (const loss of ["expired", "replaced"] as const) {
  it(`a source summary whose Hub lease is ${loss} is stopped; the target is never prepared, selected or called`, async () => {
    let mode: Loss = "ok";
    const fake = hub(() => mode);
    h = await harness({ broker: fake.broker });
    const dir = h.project(`lease-summary-${loss}`);
    const sid = await longChat(h, dir, `summary-${loss}`);
    const log: string[] = [], hold = gate();
    let entered = false;
    heldSummaries(h, log, hold, () => { entered = true; });
    const prepares = fake.of("prepare").length;
    expect(prepares).toBe(1);
    const cursor = h.runtime.journal.head;
    const id = `to-small-${loss}`;
    await h.command(promptCommand(h, id, sid, dir, "continue here", h.model("small")));
    await until(() => entered, "source summary in progress");
    // The summary is real inference under the source lease; no turn exists yet.
    expect(h.runtime.registry.live(sid)?.turnRunning()).toBe(false);
    expect(h.runtime.ledger.get(id)?.state).toBe("accepted");
    mode = loss;
    await h.runtime.hub.renew();
    hold.open();
    const receipt = await h.waitReceipt(id, ["cancelled", "rejected", "failed", "completed"]);
    expect(receipt.state).toBe("cancelled");
    expect(receipt.error).toMatch(/Hub завершил заявку/);
    expect(receipt.error).toMatch(/запрос не отправлен/);
    // Nothing continued into the target after the loss.
    expect(log).not.toContain("call:scripted-small");
    expect(log.filter((entry) => entry === `call:${LARGE}`)).toHaveLength(1);
    expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(LARGE);
    const phases = events(h, sid, cursor).filter((e) => e.type === "session.context_transition" && e.properties.operation === id).map((e) => e.properties.phase);
    expect(phases).toContain("summarizing");
    expect(phases).not.toContain("target_model");
    expect(phases).not.toContain("ready");
    expect(phases.at(-1)).toBe("cancelled");
    // One truthful notice; no new reservation; the ended ticket is not released again.
    expect(lostNotices(h, sid, cursor)).toHaveLength(1);
    expect(fake.of("prepare")).toHaveLength(prepares);
    expect(fake.of("release")).toEqual([]);
    await until(() => !h!.runtime.dispatcher.inFlight(sid), "settled");
    await h.runtime.hub.renew();
    expect(fake.of("release")).toEqual([]);
    expect(fake.of("prepare")).toHaveLength(prepares);
    // The prompt was never sent: still exactly the two earlier user turns.
    const history = await h.request<{ messages: Array<{ info: { role: string } }> }>("GET", `/sessions/${sid}/messages`);
    expect(history.body.messages.filter((m) => m.info.role === "user")).toHaveLength(2);
  });
}

it("a manual compaction whose Hub lease expires is cancelled truthfully; nothing is compacted or re-prepared", async () => {
  let mode: Loss = "ok";
  const fake = hub(() => mode);
  h = await harness({ broker: fake.broker });
  const dir = h.project("lease-manual");
  const sid = await longChat(h, dir, "manual");
  const log: string[] = [], hold = gate();
  let entered = false;
  heldSummaries(h, log, hold, () => { entered = true; });
  const prepares = fake.of("prepare").length;
  const cursor = h.runtime.journal.head;
  await h.command({ id: "manual-lost", kind: "compact", sessionID: sid, directory: dir, payload: {} });
  await until(() => entered, "manual compaction in progress");
  expect(h.runtime.registry.live(sid)?.turnRunning()).toBe(false);
  expect(h.runtime.ledger.get("manual-lost")?.state).toBe("dispatching");
  mode = "expired";
  await h.runtime.hub.renew();
  hold.open();
  const receipt = await h.waitReceipt("manual-lost", ["cancelled", "failed", "completed", "rejected"]);
  expect(receipt.state).toBe("cancelled");
  expect(receipt.error).toMatch(/Hub завершил заявку/);
  expect(receipt.error).toMatch(/История не изменена/);
  expect(events(h, sid, cursor).filter((e) => e.type === "session.compacted")).toEqual([]);
  expect(lostNotices(h, sid, cursor)).toHaveLength(1);
  expect(log).toEqual([`call:${LARGE}`]);
  expect(fake.of("prepare")).toHaveLength(prepares);
  expect(fake.of("release")).toEqual([]);
  // Still usable afterwards: a later compaction prepares a NEW reservation once.
  mode = "ok";
  heldSummaries(h, log, { wait: Promise.resolve() }, () => undefined);
  await h.command({ id: "manual-after", kind: "compact", sessionID: sid, directory: dir, payload: {} });
  expect((await h.waitReceipt("manual-after", ["cancelled", "failed", "completed", "rejected"])).state).toBe("completed");
  expect(fake.of("prepare")).toHaveLength(prepares + 1);
});

it("a failure to record the lease-loss notice never suppresses the stop of a running turn", async () => {
  let mode: Loss = "ok";
  const fake = hub(() => mode);
  h = await harness({ broker: fake.broker });
  const dir = h.project("lease-notice-fails"), sid = await newSession(h, dir, { model: h.model("large") });
  h.scripted.setResponses([async (_c, options) => {
    await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve, { once: true }));
    return fauxAssistantMessage("late", { stopReason: "aborted" });
  }]);
  await h.command(promptCommand(h, "notice", sid, dir, "long gpu work", h.model("large")));
  await h.waitReceipt("notice", ["running"]);
  const journal = h.runtime.journal;
  const append = journal.append.bind(journal);
  journal.append = ((...args: Parameters<typeof journal.append>) => {
    if (args[2].type === "session.error") throw new Error("journal unavailable");
    return append(...args);
  }) as typeof journal.append;
  mode = "expired";
  await h.runtime.hub.renew();
  journal.append = append;
  const receipt = await h.waitReceipt("notice", ["cancelled", "failed", "completed"]);
  expect(receipt.state).toBe("cancelled");
  expect(receipt.error).toMatch(/Hub завершил заявку/);
  expect(h.scripted.calls()).toBe(1);
  expect(fake.of("prepare")).toHaveLength(1);
  expect(fake.of("release")).toEqual([]);
});
