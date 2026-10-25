// Model selection over the runtime. Carries the independent lifecycle
// contracts of the retired engine-routing/pi-backend suites: a late readiness
// answer never commits to another chat or over a newer selection; a failed
// selection keeps the previous model and the draft; the explicit access check is
// a runtime probe (POST /models/check) that records or revokes evidence only.
import { beforeEach, expect, it, vi } from "vitest";
import type { RuntimeFixture } from "./helpers/runtime-fixture";
let store: any, fx: RuntimeFixture, fixture: typeof import("./helpers/runtime-fixture");
const session = (id: string) => ({ id, directory: "/p", title: id, projectID: "p", time: { created: 1, updated: 1 } });
const deferred = () => { let resolve!: (v: unknown) => void; const promise = new Promise((r) => (resolve = r)); return { promise, resolve }; };
beforeEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
  fixture = await import("./helpers/runtime-fixture");
  store = (await import("../src/state/store")).store;
  fx = fixture.runtimeFixture();
  fixture.withProvider(fx, "p", ["old", "new", "other"], ["medium"]);
  fx.on("GET", "/sessions", () => [session("a"), session("b")]);
  fixture.bindStore(store, fx);
  await store.setDirectory("/p", { sessionId: "a" });
  store.setModelChoice("p", "old", "medium");
  store.setDraft("my draft");
});
const choice = (sid: string) => store.state.prefs.modelChoice[`session:${sid}`];

it("a late readiness answer does not commit the model to the chat the user moved to", async () => {
  const health = deferred();
  fx.on("GET", "/health", () => health.promise);
  const selecting = store.selectModel("p", "new", "medium");
  await vi.waitFor(() => expect(fx.made("GET", "/health").length).toBeGreaterThan(0));
  await store.selectSession("b");
  health.resolve({ healthy: true, version: "test", contract: 1, schema: 2, sdk: "x", node: "24", platform: "t", arch: "t", instance: "fixture-instance", startedAt: 1, host: "local", draining: false });
  expect(await selecting).toBe(false);
  expect(choice("a")).toEqual({ providerID: "p", modelID: "old", variant: "medium" });
  expect(choice("b")).toBeUndefined();
});

// Readiness is the runtime's: the window's only awaited step before the single
// durable model.transition command is the runtime health check, and the
// outcome comes from that command's ledger receipt (state/modelTransition.ts).
const healthy = { healthy: true, version: "test", contract: 1, schema: 2, sdk: "x", node: "24", platform: "t", arch: "t", instance: "fixture-instance", startedAt: 1, host: "local", draining: false };
const transitions = () => fx.made("POST", "/commands").filter(c => (c.body as { kind: string }).kind === "model.transition");
const prompts = () => fx.made("POST", "/commands").filter(c => (c.body as { kind: string }).kind !== "model.transition");
it("a newer selection wins over an older one that finishes later", async () => {
  const gates: Array<() => void> = [];
  fx.on("GET", "/health", () => new Promise(resolve => { gates.push(() => resolve(healthy)); }));
  fx.on("POST", "/commands", c => ({ id: (c.body as { id: string }).id, kind: "model.transition", sessionID: "a", state: "completed", createdAt: 1, updatedAt: 1 }));
  const older = store.selectModel("p", "new", "medium");
  await vi.waitFor(() => expect(gates).toHaveLength(1));
  const newer = store.selectModel("p", "other", "medium");
  await vi.waitFor(() => expect(gates).toHaveLength(2));
  gates[1](); expect(await newer).toBe(true);
  gates[0](); expect(await older).toBe(false);
  expect(choice("a")).toMatchObject({ modelID: "other" });
  // The superseded choice never reached the runtime.
  expect(transitions().map(c => (c.body as { payload: { model: { modelID: string } } }).payload.model.modelID)).toEqual(["other"]);
  expect(prompts()).toEqual([]);
});

it("a failed selection keeps the previous model and the draft", async () => {
  fx.on("POST", "/commands", c => ({ id: (c.body as { id: string }).id, kind: "model.transition", sessionID: "a", state: "failed", error: "Сервис модели не готов", createdAt: 1, updatedAt: 1 }));
  await expect(store.selectModel("p", "new", "medium")).rejects.toThrow("не готов");
  fx.on("GET", "/health", () => ({ healthy: false, version: "test" }));
  await expect(store.selectModel("p", "new", "medium")).rejects.toThrow("Нет связи");
  await expect(store.selectModel("p", "missing", "medium")).rejects.toThrow("не настроена");
  expect(choice("a")).toEqual({ providerID: "p", modelID: "old", variant: "medium" });
  expect(store.getDraft()).toBe("my draft");
  expect(transitions()).toHaveLength(1);
  expect(prompts()).toEqual([]);
});

it("the access check is a runtime probe that records or revokes evidence and creates nothing", async () => {
  fx.on("POST", "/models/check", () => ({ ok: true, detail: "Модель ответила на тестовый запрос." }));
  expect(await store.checkPiModelAccess("p/new")).toEqual({ ok: true, detail: "Модель ответила на тестовый запрос." });
  expect(fx.made("POST", "/models/check").map(c => c.body)).toEqual([{ providerID: "p", modelID: "new" }]);
  expect(store.state.prefs.pi?.verifiedModels?.["p/new"]).toEqual(expect.any(Number));
  fx.on("POST", "/models/check", () => ({ ok: false, detail: "401 invalid api key" }));
  expect(await store.checkPiModelAccess("p/new")).toMatchObject({ ok: false, detail: expect.stringContaining("401") });
  expect(store.state.prefs.pi?.verifiedModels?.["p/new"]).toBeUndefined();
  expect(store.state.prefs.pi?.verifiedModel).toBeUndefined();
  expect(fx.made("POST", "/sessions")).toEqual([]);
  expect(fx.made("POST", "/commands")).toEqual([]);
  // Evidence is a badge: the model stays selectable.
  expect(store.piModelOptions().map((m: { modelID: string }) => m.modelID)).toContain("new");
});
