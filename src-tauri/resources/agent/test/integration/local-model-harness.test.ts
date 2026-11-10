// Local providers get the compact per-turn policy and bounded head+tail command
// output. This runs the REAL pinned SDK loop with a faux provider whose id has
// the owner-configured `local-` prefix; no GPU or network is involved.
import { afterEach, expect, it } from "vitest";
import { fauxProvider } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "../../src/sdk/testing.ts";
import { WORK_QUALITY_CONTEXT } from "../../src/policy/workQuality.ts";
import { gate, harness, newSession, promptCommand, type Harness } from "../helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

async function localHarness() {
  h = await harness();
  const faux = fauxProvider({
    provider: "local-scripted",
    models: [{ id: "local-large", name: "Local large", contextWindow: 200_000, maxTokens: 8_000, reasoning: true, input: ["text"] }],
    tokensPerSecond: 100_000,
  });
  h.scripted.modelRuntime.registerNativeProvider(faux.provider);
  await h.scripted.modelRuntime.setRuntimeApiKey("local-scripted", "scripted-test-key");
  return faux;
}
const MODEL = { providerID: "local-scripted", modelID: "local-large" };

it("a local model receives the compact policy, a cloud model keeps the full text", async () => {
  const faux = await localHarness();
  const prompts: string[] = [];
  const capture: FauxResponseStep = async (context) => {
    prompts.push(context.systemPrompt ?? "");
    return fauxAssistantMessage("done");
  };
  const dir = h.project("local-policy");
  const sid = await newSession(h, dir, { model: MODEL, permission: [{ permission: "*", pattern: "*", action: "allow" }] });
  faux.setResponses([capture]);
  const id = `local-policy-${sid}`;
  await h.command(promptCommand(h, id, sid, dir, "hello", MODEL));
  expect((await h.waitReceipt(id, ["completed", "failed"])).state).toBe("completed");
  expect(prompts[0]).toContain("план из 2–4 пунктов");
  expect(prompts[0]).not.toContain(WORK_QUALITY_CONTEXT);

  // Тот же харнес, облачный провайдер: текст политики не меняется.
  h.scripted.setResponses([capture]);
  const cloudDir = h.project("cloud-policy");
  const cloudSid = await newSession(h, cloudDir, { model: h.model("large") });
  const cloudId = `cloud-policy-${cloudSid}`;
  await h.command(promptCommand(h, cloudId, cloudSid, cloudDir, "hello", h.model("large")));
  expect((await h.waitReceipt(cloudId, ["completed", "failed"])).state).toBe("completed");
  expect(prompts[1]).toContain(WORK_QUALITY_CONTEXT);
  expect(prompts[1]).not.toContain("план из 2–4 пунктов");
}, 60_000);

it("a local model sees head+tail of a long bash result instead of the whole log", async () => {
  const faux = await localHarness();
  const dir = h.project("local-output");
  const sid = await newSession(h, dir, { model: MODEL, permission: [{ permission: "*", pattern: "*", action: "allow" }] });
  let toolText = "";
  const capture: FauxResponseStep = async (context) => {
    for (const m of context.messages) {
      if (m.role !== "toolResult") continue;
      for (const c of m.content) if (c.type === "text") toolText += c.text;
    }
    return fauxAssistantMessage("done");
  };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "python3 -c \"print('A'*4000); print('B'*20000); print('C'*2000)\"" })], { stopReason: "toolUse" }),
    capture,
  ]);
  const id = `local-output-${sid}`;
  await h.command(promptCommand(h, id, sid, dir, "run", MODEL));
  expect((await h.waitReceipt(id, ["completed", "failed"])).state).toBe("completed");
  expect(toolText.length).toBeGreaterThan(0);
  expect(toolText.length).toBeLessThan(13_000);
  expect(toolText).toContain("пропущено");
  expect(toolText).toContain("A".repeat(1000));
  expect(toolText).toContain("C".repeat(1000));
  expect(toolText).not.toContain("B".repeat(20_000));
}, 60_000);
