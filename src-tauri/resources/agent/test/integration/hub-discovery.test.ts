// Trusted Hub route discovery precedes the direct-vs-Hub decision on a FRESH
// runtime (empty route cache, no pre-seeding, no caller flag):
//   - Hub connected but its catalog unreadable → refused, never sent directly;
//   - Hub unavailable → genuine direct providers keep working;
//   - catalog read and the model absent → direct, without re-reading the
//     catalog for every prompt;
//   - /models/check discovers too.
// The four RED cases in cancel-and-hub / model-context-hub cover the positive
// "prepare before first inference" path and stay unchanged.
import { afterEach, expect, it } from "vitest";
import type { Broker, BrokerMethod } from "../../src/control/broker.ts";
import { fauxAssistantMessage } from "../../src/sdk/testing.ts";
import { harness, newSession, promptCommand, type Harness } from "../helpers.ts";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

function broker(mode: { identity: "connected" | "absent" | "throws"; catalog: "ok" | "fails"; routes?: unknown[] }) {
  const calls: string[] = [];
  const value: Broker = {
    kind: "supervisor",
    available: () => true,
    async call<T>(method: BrokerMethod, params: Record<string, unknown>): Promise<T> {
      if (method === "hub.identity") {
        calls.push("identity");
        if (mode.identity === "throws") throw new Error("Hub offline");
        return { scope: mode.identity === "connected" ? "hub-test" : null } as T;
      }
      const path = String(params.path).replace("model-services/", "");
      calls.push(path);
      if (path === "catalog") {
        if (mode.catalog === "fails") throw new Error("catalog 502");
        return { schema: 1, routes: mode.routes ?? [] } as T;
      }
      throw new Error(`unexpected Hub call ${path}`);
    },
  };
  return { broker: value, calls };
}

it("a connected Hub with an unreadable catalog refuses instead of sending directly", async () => {
  const fake = broker({ identity: "connected", catalog: "fails" });
  h = await harness({ broker: fake.broker });
  const dir = h.project("hub-unknown");
  const sid = await newSession(h, dir);
  h.scripted.setResponses([fauxAssistantMessage("must not be sent")]);
  await h.command(promptCommand(h, "disc-1", sid, dir, "hello"));
  const receipt = await h.waitReceipt("disc-1", ["rejected", "failed", "completed"]);
  expect(receipt.state).not.toBe("completed");
  expect(receipt.error).toMatch(/каталог моделей Hub/);
  expect(h.scripted.calls()).toBe(0);
});

it("an unavailable Hub leaves genuine direct providers working", async () => {
  const fake = broker({ identity: "throws", catalog: "ok" });
  h = await harness({ broker: fake.broker });
  const dir = h.project("hub-down");
  const sid = await newSession(h, dir);
  h.scripted.setResponses([fauxAssistantMessage("direct answer")]);
  await h.command(promptCommand(h, "disc-2", sid, dir, "hello"));
  expect((await h.waitReceipt("disc-2", ["rejected", "failed", "completed"])).state).toBe("completed");
  expect(fake.calls).not.toContain("prepare");
});

it("a read catalog without this model goes direct and is not re-read for every prompt", async () => {
  const fake = broker({ identity: "connected", catalog: "ok", routes: [{ service: "gpu", label: "GPU", providerID: "other", modelID: "big", agent: "pi", target: "big" }] });
  h = await harness({ broker: fake.broker });
  const dir = h.project("hub-direct");
  const sid = await newSession(h, dir);
  h.scripted.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
  await h.command(promptCommand(h, "disc-3", sid, dir, "first"));
  expect((await h.waitReceipt("disc-3", ["rejected", "failed", "completed"])).state).toBe("completed");
  const catalogReads = fake.calls.filter((c) => c === "catalog").length;
  expect(catalogReads).toBeGreaterThanOrEqual(1);
  await h.command(promptCommand(h, "disc-4", sid, dir, "second"));
  expect((await h.waitReceipt("disc-4", ["rejected", "failed", "completed"])).state).toBe("completed");
  expect(fake.calls.filter((c) => c === "catalog").length).toBe(catalogReads); // within the discovery TTL
  // The discovered foreign route is fail-closed for its own model.
  expect(h.runtime.hub.route("other", "big")).toBeDefined();
});

it("the direct model check discovers first and refers a Hub-owned model to the Hub", async () => {
  const model = { providerID: "enki-scripted", modelID: "scripted-large" };
  const fake = broker({ identity: "connected", catalog: "ok", routes: [{ service: "gpu", label: "GPU", ...model, agent: "pi", target: model.modelID }] });
  h = await harness({ broker: fake.broker });
  const result = await h.request<{ message?: string }>("POST", "/models/check", model);
  expect(result.status).toBe(409);
  expect(h.scripted.calls()).toBe(0);
});
