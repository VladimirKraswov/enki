// Cancellation and Hub leases:
//   - Stop while a Hub-managed model is still loading withdraws the command
//     before the SDK ever sees it (cancelled, not executed), and releases the
//     Hub ticket.
//   - A ready lease is held for the whole turn and released after it settles.
//   - A known Hub route never falls back to direct inference when the Hub is
//     unreachable.
//   - Stop during streaming aborts the run and reports it as cancelled.
import { afterEach, expect, it } from "vitest";
import type { Broker, BrokerMethod } from "../../src/control/broker.ts";
import { fauxAssistantMessage } from "../../src/sdk/testing.ts";
import { gate, harness, newSession, promptCommand, type Harness } from "../helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

function fakeHub(model: { providerID: string; modelID: string }, ready: () => boolean, available = () => true) {
  const calls: string[] = [];
  const broker: Broker = {
    kind: "supervisor",
    available,
    async call<T>(method: BrokerMethod, params: Record<string, unknown>): Promise<T> {
      if (!available()) throw new Error("offline");
      if (method === "hub.identity") return { scope: "hub-test" } as T;
      const path = String(params.path).replace("model-services/", "");
      calls.push(path);
      if (path === "catalog") return { schema: 1, routes: [{ service: "gpu", label: "GPU", providerID: model.providerID, modelID: model.modelID, agent: "pi", target: model.modelID }] } as T;
      const isReady = ready();
      return { schema: 1, operation_id: "12345678-1234-1234-1234-123456789012", phase: isReady ? "ready" : "loading", ready: isReady,
        active_model: isReady ? model.modelID : null, target_model: model.modelID, elapsed_seconds: 1, active_requests: 0, error: null, loader: null } as T;
    },
  };
  return { broker, calls };
}

it("Stop during Hub loading withdraws the turn before the SDK and releases the ticket", async () => {
  let fake!: ReturnType<typeof fakeHub>;
  const holder = { model: { providerID: "enki-scripted", modelID: "scripted-large" } };
  fake = fakeHub(holder.model, () => false);
  h = await harness({ broker: fake.broker });
  const dir = h.project("hub-stop");
  const sid = await newSession(h, dir);
  await h.command(promptCommand(h, "hub-1", sid, dir, "needs gpu"));
  for (let i = 0; i < 200 && !fake.calls.includes("prepare"); i++) await new Promise((r) => setTimeout(r, 25));
  expect(h.runtime.ledger.get("hub-1")?.state).toBe("accepted");
  await h.request("POST", `/sessions/${sid}/stop`, {});
  const receipt = await h.waitReceipt("hub-1", ["cancelled"]);
  expect(receipt.error).toMatch(/отменена/);
  expect(h.scripted.calls()).toBe(0);
  for (let i = 0; i < 100 && !fake.calls.includes("release"); i++) await new Promise((r) => setTimeout(r, 25));
  expect(fake.calls).toContain("release");
});

it("holds a ready lease for the whole turn and never falls back to direct inference", async () => {
  let online = true;
  const fake = fakeHub({ providerID: "enki-scripted", modelID: "scripted-large" }, () => true, () => online);
  h = await harness({ broker: fake.broker });
  const dir = h.project("hub-lease");
  const sid = await newSession(h, dir);
  h.scripted.setResponses([fauxAssistantMessage("gpu answer")]);
  await h.command(promptCommand(h, "hub-2", sid, dir, "go"));
  await h.waitReceipt("hub-2", ["completed"]);
  expect(fake.calls.filter((c) => c === "prepare")).toHaveLength(1);
  await h.runtime.hub.renew();
  expect(fake.calls).toContain("release");
  online = false;
  await h.command(promptCommand(h, "hub-3", sid, dir, "hub is down"));
  const refused = await h.waitReceipt("hub-3", ["rejected"]);
  expect(refused.error).toMatch(/Hub/);
  expect(h.scripted.calls()).toBe(1);
});

// Ported from the retired UI coordinator (test/model-hub.test.ts "recovers a
// lost prepare acknowledgement using exactly the same requestKey").
it("a lost prepare acknowledgement is recovered with exactly the same requestKey, once", async () => {
  const keys: string[] = [];
  let lose = true;
  const base = fakeHub({ providerID: "enki-scripted", modelID: "scripted-large" }, () => true);
  const broker: Broker = { ...base.broker, async call<T>(method: BrokerMethod, params: Record<string, unknown>, signal?: AbortSignal, timeout?: number): Promise<T> {
    if (method === "hub.request" && String(params.path) === "model-services/prepare") {
      keys.push(String((params.body as { requestKey?: unknown }).requestKey));
      if (lose) { lose = false; await base.broker.call(method, params, signal, timeout); throw new Error("socket hang up"); }
    }
    return base.broker.call<T>(method, params, signal, timeout);
  } };
  h = await harness({ broker });
  const dir = h.project("hub-lost-ack"), sid = await newSession(h, dir);
  h.scripted.setResponses([fauxAssistantMessage("gpu answer")]);
  await h.command(promptCommand(h, "hub-ack", sid, dir, "go"));
  expect((await h.waitReceipt("hub-ack", ["completed", "failed", "rejected"])).state).toBe("completed");
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect(h.scripted.calls()).toBe(1);
});

it("Stop during streaming aborts and reports the turn as cancelled", async () => {
  h = await harness();
  const dir = h.project("abort");
  const sid = await newSession(h, dir);
  const hold = gate();
  h.scripted.setResponses([async (_c, options) => {
    await Promise.race([hold.wait, new Promise((resolve) => options?.signal?.addEventListener("abort", resolve, { once: true }))]);
    return fauxAssistantMessage("late", { stopReason: options?.signal?.aborted ? "aborted" : "stop" });
  }]);
  await h.command(promptCommand(h, "abort-1", sid, dir, "slow"));
  await h.waitReceipt("abort-1", ["running"]);
  const abort = await h.command({ id: "abort-cmd", kind: "abort", sessionID: sid, directory: dir, payload: {} });
  expect(abort.status).toBe(202);
  await h.waitReceipt("abort-cmd", ["completed"]);
  const receipt = await h.waitReceipt("abort-1", ["cancelled", "completed"]);
  expect(receipt.state).toBe("cancelled");
  hold.open();
});
