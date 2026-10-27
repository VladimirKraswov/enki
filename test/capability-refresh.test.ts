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

it("Connect opens the selected SDK surface without sending a model prompt and waits for its MCP report", async () => {
  await store.setDirectory("/work/a");
  store.state = { ...store.state, activeSessionId: "same-chat" };
  const { activePluginUi } = await import("../src/agent/runtime/pluginUi/active");
  const open = vi.fn(), unsubscribe = vi.fn();
  vi.spyOn(activePluginUi, "activate").mockReturnValue({ session: { open, subscribe: () => unsubscribe, getView: () => ({ phase: "waiting" }) } } as any);
  const waiting = store.connectCurrentMcp("cua-desktop", "same-chat", "/work/a");
  expect(open).toHaveBeenCalledOnce();
  const server = { id: "cua-desktop", signature: "ready", state: "connected", tools: ["mesh_cua_desktop_check_permissions"] };
  fx.emit({ type: "mcp.status", properties: { sessionID: "same-chat", servers: [server] } }, "/work/a");
  await expect(waiting).resolves.toEqual(server);
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(fx.made("POST", "/commands")).toHaveLength(0);
});

it("retains bridge errors for settings and discards stale success when refreshing an idle current chat", async () => {
  await store.setDirectory("/work/a");
  store.state = { ...store.state, activeSessionId: "same-chat" };
  fx.emit({ type: "mcp.status", properties: { sessionID: "same-chat", servers: [], error: "Мост MCP не установлен" } }, "/work/a");
  expect(store.mcpConnectionError("same-chat")).toBe("Мост MCP не установлен");
  await store.capabilitiesCommitted(null);
  expect(store.mcpConnectionError("same-chat")).toBeNull();
  expect(store.mcpServerStatuses("same-chat")).toEqual([]);
});

it.each([false, true])("recovers failed discovery in the same idle chat without a prompt (notice-only reload=%s)", async (noticeOnly) => {
  await store.setDirectory("/work/a");
  store.state = { ...store.state, activeSessionId: "same-chat" };
  const { activePluginUi } = await import("../src/agent/runtime/pluginUi/active");
  const settle = vi.fn(async () => {});
  const open = vi.fn(() => fx.emit({ type: "mcp.status", properties: { sessionID: "same-chat", servers: [
    { id: "enki-images", signature: "ready", state: "connected", tools: ["generate_image"] },
  ] } }, "/work/a"));
  const active = { session: { client: fx.backend.client, sessionID: "same-chat", directory: "/work/a", open,
    getView: () => ({ phase: "live", mode: { custom: false, terminalInput: false }, snapshot: {}, notices: noticeOnly ? [{ text: "Генератор: Не удалось подключиться к сервису MCP. Действия сервиса при подключении не запускались." }] : [] }) },
    draft: { settle, getState: () => ({ kind: "synced" }) } };
  vi.spyOn(activePluginUi, "get").mockReturnValue(active as any);
  if (!noticeOnly) fx.emit({ type: "mcp.status", properties: { sessionID: "same-chat", servers: [
    { id: "enki-images", signature: "ready", state: "error", tools: [] },
  ] } }, "/work/a");
  await store.recoverMcpConnection("same-chat", "/work/a");
  expect(settle).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledOnce();
  expect(fx.made("POST", "/capabilities/refresh").at(-1)?.body).toEqual({ directory: "/work/a" });
  expect(fx.made("POST", "/commands")).toHaveLength(0);
  expect(store.mcpServerStatuses("same-chat")[0].state).toBe("connected");
});

it("does not refresh or reopen a running chat or an old selection", async () => {
  await store.setDirectory("/work/a"); store.state = { ...store.state, activeSessionId: "same-chat" };
  const before = fx.made("POST", "/capabilities/refresh").length;
  vi.spyOn(store, "isRunning").mockReturnValue(true);
  await expect(store.recoverMcpConnection("same-chat", "/work/a")).rejects.toThrow("после текущего ответа");
  await expect(store.recoverMcpConnection("other-chat", "/work/a")).rejects.toThrow();
  expect(fx.made("POST", "/capabilities/refresh")).toHaveLength(before);
});

it("a selection change while settling a draft cannot refresh a successor's tools", async () => {
  await store.setDirectory("/work/a"); store.state = { ...store.state, activeSessionId: "same-chat" };
  fx.emit({ type: "mcp.status", properties: { sessionID: "same-chat", servers: [
    { id: "enki-images", signature: "ready", state: "error", tools: [] },
  ] } }, "/work/a");
  const { activePluginUi } = await import("../src/agent/runtime/pluginUi/active");
  const open = vi.fn();
  const active = { session: { client: fx.backend.client, sessionID: "same-chat", open,
    getView: () => ({ phase: "live", mode: {}, snapshot: {} }) }, draft: {
      settle: async () => { store.state = { ...store.state, activeSessionId: "successor" }; },
      getState: () => ({ kind: "synced" }),
    } };
  vi.spyOn(activePluginUi, "get").mockReturnValue(active as any);
  const before = fx.made("POST", "/capabilities/refresh").length;
  await expect(store.recoverMcpConnection("same-chat", "/work/a")).rejects.toThrow("изменились");
  expect(open).not.toHaveBeenCalled(); expect(fx.made("POST", "/capabilities/refresh")).toHaveLength(before);
});

it("restores MCP reports on a UI reload and never overwrites a newer live report", async () => {
  await store.setDirectory("/work/a");
  const failed = { id: "enki-images", signature: "s", state: "error", tools: [] };
  fx.on("GET", "/extensions", () => ({ sessions: [{ sessionID: "same-chat", errors: [], unsupported: [], mcp: { servers: [failed] } }], mcp: [] }));
  await store.configureSharedTools("/work/a"); expect(store.mcpServerStatuses("same-chat")).toEqual([failed]);
  let complete!: (value: unknown) => void;
  fx.on("GET", "/extensions", () => new Promise(resolve => { complete = resolve; }));
  const pending = store.configureSharedTools("/work/a");
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  const connected = { ...failed, state: "connected", tools: ["generate_image"] };
  fx.emit({ type: "mcp.status", properties: { sessionID: "same-chat", servers: [connected] } }, "/work/a");
  complete({ sessions: [{ sessionID: "same-chat", errors: [], unsupported: [], mcp: { servers: [failed] } }], mcp: [] });
  await pending; expect(store.mcpServerStatuses("same-chat")).toEqual([connected]);
});
