// Final integration: the UI uses the ACTUAL runtime ports — POST
// /capabilities/refresh {directory?} -> {reopened,pending} only after a
// confirmed commit, GET /config/defaults, pendingRestart and the 501
// CONFIG_SOURCE_UNCONFIGURED refusal. Real store + runtime fixture. Written, NOT RUN.
import { beforeEach, expect, it, vi } from "vitest";
import type { RuntimeFixture } from "./helpers/runtime-fixture";
import type { ConfigStatusDTO } from "../src/agent/runtime/client";

const hosts = vi.hoisted(() => ({ backend: null as unknown }));
vi.mock("../src/agent/registry", async (original) => ({ ...(await original<typeof import("../src/agent/registry")>()),
  connectRuntime: vi.fn(async () => hosts.backend) }));

let store: any, fx: RuntimeFixture;
beforeEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v), removeItem: (k: string) => saved.delete(k) });
  vi.stubGlobal("document", { hidden: false, hasFocus: vi.fn(() => true) });
  const fixture = await import("./helpers/runtime-fixture");
  store = (await import("../src/state/store")).store;
  fx = fixture.runtimeFixture(); hosts.backend = fx.backend;
  fx.on("POST", "/capabilities/refresh", () => ({ reopened: 2, pending: 1 }));
  expect(await store.connectLocal()).toBe(true);
});

it("a confirmed commit refreshes this computer's runtime once with the exact scope; a plain check does not", async () => {
  await store.setDirectory("/work/a");
  const before = fx.made("POST", "/capabilities/refresh").length;
  expect(await store.capabilitiesCommitted("/work/a")).toEqual({ reopened: 2, pending: 1 });
  expect(await store.capabilitiesCommitted(null)).toEqual({ reopened: 2, pending: 1 });
  const calls = fx.made("POST", "/capabilities/refresh").slice(before);
  expect(calls.map((c) => c.body)).toEqual([{ directory: "/work/a" }, {}]);
  // Re-reading the pool (connection check, folder open) is not a commit.
  await store.configureSharedTools("/work/a");
  expect(fx.made("POST", "/capabilities/refresh").length).toBe(before + 2);
});

it("the UI texts state what really happened to open chats and to the Pi import", async () => {
  const { registryNotice } = await import("../src/components/CapabilitiesSettings");
  expect(registryNotice({ reopened: 2, pending: 1 })).toMatch(/обновлено: 2.*завершения текущей работы: 1/);
  expect(registryNotice(null)).toMatch(/уже открытые сохраняют прежний набор/);
  const { configSummary, configImportError } = await import("../src/components/PiSettings");
  const status: ConfigStatusDTO = { state: "none", code: null, configRevision: 0, generationId: null, deferred: [] };
  expect(configSummary(null, null)).toBe("Состояние неизвестно");
  expect(configSummary({ ...status, pendingRestart: { configRevision: 1, generationId: "g" } }, null)).toMatch(/Ожидает перезапуска/);
  expect(configSummary({ ...status, state: "ready" }, { model: { providerID: "p", modelID: "m" }, code: null })).toMatch(/p\/m/);
  expect(configSummary({ ...status, state: "ready" }, { model: null, code: "CONFIG_DEFAULT_MODEL_UNAVAILABLE" })).toMatch(/недоступна/);
  expect(configImportError(new Error("CONFIG_SOURCE_UNCONFIGURED: x"))).toMatch(/Источник импорта не настроен/);
});

it("the client speaks the merged runtime contract for defaults and refresh", async () => {
  fx.on("GET", "/config/defaults", () => ({ model: { providerID: "p", modelID: "m" }, code: null }));
  const backend = store.maybeBackend();
  expect(await backend.client.configDefaults()).toEqual({ model: { providerID: "p", modelID: "m" }, code: null });
  expect(await backend.client.refreshCapabilities(null)).toEqual({ reopened: 2, pending: 1 });
});
