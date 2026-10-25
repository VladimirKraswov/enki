// CONFIG caller integration: the imported Pi defaultProvider/defaultModel is a
// typed request validated against the LIVE catalog and the active projection's
// admission. It applies to sessions created without an explicit model and is
// offered via GET /config/defaults; an explicit model always wins; an unknown
// or blocked default is null with a structured code, never a silent fallback.
import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Broker, BrokerMethod } from "../src/control/broker.ts";
import { ConfigProjection } from "../src/models/config.ts";
import { harness, tempDir, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

/** Owned in-memory authority: a committed generation directory with exactly
 * these sanitized files; secret reads fail (no value exists anywhere). */
function authority(settings: Record<string, unknown>, bindings: unknown[] = []): Broker {
  const directory = tempDir("config-generation"), files = [] as Array<{ name: string; sha256: string; size: number }>;
  for (const [name, value] of [["settings.json", settings], ["models.json", { providers: {} }]] as const) {
    const bytes = Buffer.from(JSON.stringify(value));
    fs.writeFileSync(path.join(directory, name), bytes);
    files.push({ name, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
  }
  const snapshot = { configRevision: 3, generationId: "generation-1", directory, files, bindings, deferred: [] };
  return { kind: "supervisor", available: () => true,
    call: async <T,>(method: BrokerMethod) => { if (method === "config.current") return snapshot as T; throw new Error("no secret in this fixture"); } };
}
async function project(broker: Broker): Promise<void> {
  h.runtime.configProjection = await ConfigProjection.load(broker, { agentDir: h.runtime.paths.agentDir });
}
async function create(body: Record<string, unknown>) {
  const created = await h.request<{ id: string }>("POST", "/sessions", body);
  expect(created.status).toBe(200);
  return h.runtime.catalog.get(created.body.id)!.model;
}

it("a valid imported default applies to model-less sessions only; explicit models win", async () => {
  h = await harness();
  const dir = h.project("defaults");
  expect((await h.request("GET", "/config/defaults")).body).toEqual({ model: null, code: null });
  expect(await create({ directory: dir })).toBeNull();
  await project(authority({ defaultProvider: h.scripted.provider, defaultModel: h.scripted.models.small, defaultThinkingLevel: "low" }));
  expect(h.runtime.configStatus().state).toBe("ready");
  const expected = { providerID: h.scripted.provider, modelID: h.scripted.models.small };
  expect((await h.request("GET", "/config/defaults")).body).toEqual({ model: expected, code: null });
  expect(await create({ directory: dir })).toEqual(expected);
  expect(await create({ directory: dir, model: h.model("large") })).toEqual(h.model("large"));
});

it("settings report the only discovery policy that applies: no owner resources, no ambient discovery", async () => {
  h = await harness();
  const saved = await h.request<Record<string, unknown>>("PUT", "/settings", { useUserPiResources: true, noDiscoveredExtensions: false });
  expect(saved.status).toBe(200);
  expect(saved.body).toMatchObject({ useUserPiResources: false, noDiscoveredExtensions: true });
  expect(h.runtime.settings()).toMatchObject({ useUserPiResources: false, noDiscoveredExtensions: true });
});

it("an unknown or blocked imported default is refused with a code and never selected", async () => {
  h = await harness();
  const dir = h.project("defaults-refused");
  await project(authority({ defaultProvider: h.scripted.provider, defaultModel: "vanished-model" }));
  expect((await h.request("GET", "/config/defaults")).body).toEqual({ model: null, code: "CONFIG_DEFAULT_MODEL_UNAVAILABLE" });
  expect(await create({ directory: dir })).toBeNull();
  // The provider's imported key binding cannot be resolved: blocked, fail closed.
  await project(authority({ defaultProvider: h.scripted.provider, defaultModel: h.scripted.models.small },
    [{ vaultId: "v1", provider: h.scripted.provider, kind: "api-key", pointer: `/models/providers/${h.scripted.provider}/apiKey` }]));
  expect(h.runtime.configStatus().state).toBe("blocked");
  const refused = (await h.request<{ model: unknown; code: string }>("GET", "/config/defaults")).body;
  expect(refused.model).toBeNull();
  expect(refused.code).toMatch(/^CONFIG_/);
  expect(await create({ directory: dir })).toBeNull();
  // Malformed selectors are not even a request.
  await project(authority({ defaultProvider: "bad provider", defaultModel: "x" }));
  expect((await h.request("GET", "/config/defaults")).body).toEqual({ model: null, code: null });
});
