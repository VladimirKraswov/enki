// Model transition × Hub leases, Stop and manual compaction. A lease always
// names the model the SDK actually uses next (source while it summarizes,
// target before its turn); Stop in any phase sends nothing to the target and
// never selects it; manual compaction stays a current-model operation.
import { afterEach, expect, it } from "vitest";
import type { Broker, BrokerMethod } from "../../src/control/broker.ts";
import { fauxAssistantMessage, type FauxResponseStep } from "../../src/sdk/testing.ts";
import { gate, harness, newSession, promptCommand, type Harness } from "../helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

const TICKETS: Record<string, string> = { "scripted-large": "11111111-1111-1111-1111-111111111111", "scripted-small": "22222222-2222-2222-2222-222222222222" };

function fakeHub(routed: string[], ready: (modelID: string) => boolean, log: string[]) {
  const calls: string[] = [];
  const broker: Broker = {
    kind: "supervisor",
    available: () => true,
    async call<T>(method: BrokerMethod, params: Record<string, unknown>): Promise<T> {
      if (method === "hub.identity") return { scope: "hub-test" } as T;
      const path = String(params.path).replace("model-services/", "");
      calls.push(path);
      if (path === "catalog") return { schema: 1, routes: routed.map((modelID) => ({ service: `gpu-${modelID}`, label: modelID, providerID: "enki-scripted", modelID, agent: "pi", target: modelID })) } as T;
      const body = (params.body ?? {}) as { modelID?: string; ticket?: string };
      if (path === "release") return {} as T;
      const model = path === "prepare" ? String(body.modelID) : Object.keys(TICKETS).find((id) => TICKETS[id] === body.ticket) ?? "";
      if (path === "prepare") log.push(`prepare:${model}`);
      const isReady = ready(model);
      return { schema: 1, operation_id: TICKETS[model] ?? null, phase: isReady ? "ready" : "loading", ready: isReady,
        active_model: isReady ? model : null, target_model: model, elapsed_seconds: 1, active_requests: 0, error: null, loader: null } as T;
    },
  };
  return { broker, calls };
}

async function longChat(h: Harness, dir: string): Promise<string> {
  h.runtime.saveSettings({ ...h.runtime.settings(), compaction: { enabled: true, keepRecentTokens: 64, reserveTokens: 64 } });
  const sid = await newSession(h, dir, { model: h.model("large") });
  h.scripted.setResponses([fauxAssistantMessage("noted ".repeat(800)), fauxAssistantMessage("noted again ".repeat(100))]);
  await h.command(promptCommand(h, "long-1", sid, dir, "context ".repeat(4000), h.model("large")));
  await h.waitReceipt("long-1", ["completed"]);
  await h.command(promptCommand(h, "long-2", sid, dir, "more context ".repeat(2000), h.model("large")));
  await h.waitReceipt("long-2", ["completed"]);
  return sid;
}

function recorder(h: Harness, log: string[], hold?: { wait: Promise<void> }, entered?: () => void): void {
  const step: FauxResponseStep = async (_context, _options, _state, model) => {
    log.push(`call:${model.id}`);
    if (model.id === h.scripted.models.large && hold) { entered?.(); await hold.wait; }
    return fauxAssistantMessage(model.id === h.scripted.models.small ? "small answer" : "Short summary of the task so far.");
  };
  h.scripted.setResponses(Array.from({ length: 6 }, () => step));
}

const wait = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 25)); };

it("the Hub lease names the source while it summarizes and never a model the SDK does not use", async () => {
  const log: string[] = [];
  const fake = fakeHub(["scripted-large"], () => true, log);
  h = await harness({ broker: fake.broker });
  const dir = h.project("hub-source");
  const sid = await longChat(h, dir);
  log.length = 0;
  await h.runtime.hub.renew(); // the settled turn's lease is released
  recorder(h, log);
  await h.command(promptCommand(h, "to-small", sid, dir, "continue", h.model("small")));
  expect((await h.waitReceipt("to-small", ["completed", "failed", "rejected"])).state).toBe("completed");
  expect(log[0]).toBe("prepare:scripted-large");
  expect(log.filter((entry) => entry.startsWith("prepare:"))).toEqual(["prepare:scripted-large"]);
  expect(log.at(-1)).toBe("call:scripted-small");
});

it("a Hub-routed target is prepared only after the source summary; Stop while it loads sends nothing", async () => {
  const log: string[] = [];
  const fake = fakeHub(["scripted-small"], () => false, log);
  h = await harness({ broker: fake.broker });
  const dir = h.project("hub-target");
  const sid = await longChat(h, dir);
  recorder(h, log);
  await h.command(promptCommand(h, "to-small", sid, dir, "continue", h.model("small")));
  await wait(() => log.includes("prepare:scripted-small"));
  const prepared = log.indexOf("prepare:scripted-small");
  expect(log.slice(0, prepared).some((entry) => entry === "call:scripted-large")).toBe(true);
  expect(h.runtime.ledger.get("to-small")?.state).toBe("accepted");
  await h.request("POST", `/sessions/${sid}/stop`, {});
  const receipt = await h.waitReceipt("to-small", ["cancelled", "rejected", "completed"]);
  expect(receipt.state).toBe("cancelled");
  expect(log).not.toContain("call:scripted-small");
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.large);
  await wait(() => fake.calls.includes("release"));
  expect(fake.calls).toContain("release");
});

it("Stop during the source summary cancels; the target is never selected and a retry runs once", async () => {
  h = await harness();
  const dir = h.project("stop-summary");
  const sid = await longChat(h, dir);
  const log: string[] = [], hold = gate();
  let entered = false;
  recorder(h, log, hold, () => { entered = true; });
  await h.command(promptCommand(h, "to-small", sid, dir, "continue", h.model("small")));
  await wait(() => entered);
  expect(entered).toBe(true);
  const stopping = h.request("POST", `/sessions/${sid}/stop`, {});
  await new Promise((r) => setTimeout(r, 50));
  hold.open();
  await stopping;
  expect((await h.waitReceipt("to-small", ["cancelled", "rejected", "completed"])).state).toBe("cancelled");
  expect(log).not.toContain("call:scripted-small");
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.large);
  const retry: string[] = [];
  recorder(h, retry);
  await h.command(promptCommand(h, "retry", sid, dir, "continue", h.model("small")));
  expect((await h.waitReceipt("retry", ["completed", "failed", "rejected"])).state).toBe("completed");
  expect(retry.filter((entry) => entry === "call:scripted-small")).toHaveLength(1);
  expect(retry.at(-1)).toBe("call:scripted-small");
});

it("manual compaction runs on the current model and refuses a different requested model", async () => {
  h = await harness();
  const dir = h.project("manual-compact");
  const sid = await longChat(h, dir);
  const log: string[] = [];
  recorder(h, log);
  await h.command({ id: "wrong-model", kind: "compact", sessionID: sid, directory: dir, payload: { model: h.model("small") } });
  const refused = await h.waitReceipt("wrong-model", ["rejected", "completed", "failed"]);
  expect(refused.state).toBe("rejected");
  expect(refused.error).toMatch(/model\.transition/);
  expect(log).toEqual([]);
  await h.command({ id: "same-model", kind: "compact", sessionID: sid, directory: dir, payload: { model: h.model("large") } });
  expect((await h.waitReceipt("same-model", ["rejected", "completed", "failed"])).state).toBe("completed");
  expect(log.length).toBeGreaterThan(0);
  expect(log.every((entry) => entry === "call:scripted-large")).toBe(true);
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.large);
});

it("a huge caller budget cannot enlarge the target window", async () => {
  h = await harness();
  const dir = h.project("huge-budget");
  const sid = await longChat(h, dir);
  const log: string[] = [];
  recorder(h, log);
  await h.command({ id: "huge", kind: "model.transition", sessionID: sid, directory: dir, payload: { model: h.model("small"), budget: Number.MAX_SAFE_INTEGER } });
  expect((await h.waitReceipt("huge", ["completed", "failed", "rejected"])).state).toBe("completed");
  expect(log.length).toBeGreaterThan(0);
  expect(log.every((entry) => entry === "call:scripted-large")).toBe(true);
  expect(h.runtime.catalog.get(sid)?.model?.modelID).toBe(h.scripted.models.small);
});
