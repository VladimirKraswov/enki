// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ running: true, servers: [] as any[], recover: vi.fn(), endpoint: "", ready: true, activeSession: "chat", activeDirectory: "/p", notices: [] as any[] }));
vi.mock("../src/state/store", () => ({ errText: String, store: {
  isRunning: () => f.running, mcpServerStatuses: () => f.servers,
  recoverMcpConnection: (...args: any[]) => f.recover(...args),
}, useAppSelector: (select: any) => select({ connection: { phase: "connected", endpoint: f.endpoint },
  runtime: { instance: "i" }, prefs: { workspaceKey: "local" }, ui: { sending: false } }) }));
vi.mock("../src/agent/runtime/pluginUi/active", () => {
  const active = { session: { get sessionID() { return f.activeSession; }, get directory() { return f.activeDirectory; }, subscribe: () => () => {}, getView: () => ({ phase: f.ready ? "live" : "connecting", notices: f.notices, snapshot: {}, mode: {} }) },
    draft: { subscribe: () => () => {}, getState: () => ({ kind: "synced" }) } };
  return { activePluginUi: { subscribe: () => () => {}, get: () => active } };
});
import { McpRecoveryNotice } from "../src/components/McpRecoveryNotice";
import { isMcpStartupNotice, McpRecoveryBudget } from "../src/capabilities/recovery";
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); f.endpoint = crypto.randomUUID(); f.running = true; f.ready = true; f.activeSession = "chat"; f.activeDirectory = "/p"; f.notices = [];
  f.servers = [{ id: "enki-images", signature: "s", state: "error", tools: [] }]; f.recover.mockReset(); });

it("waits for the current response, retries discovery once and offers an explicit retry after failure", async () => {
  f.recover.mockRejectedValue(new Error("Сервис не ответил"));
  const node = document.createElement("div"), root = createRoot(node);
  const render = async () => { await act(async () => root.render(createElement(McpRecoveryNotice, { sessionId: "chat", directory: "/p" }))); };
  try {
    await render(); expect(f.recover).not.toHaveBeenCalled(); expect(node.textContent).toContain("после текущего ответа");
    expect(node.querySelector("button")?.disabled).toBe(true);
    f.running = false; await render(); expect(f.recover).toHaveBeenCalledOnce(); expect(node.textContent).toContain("Сервис не ответил");
    await render(); expect(f.recover).toHaveBeenCalledOnce();
    f.recover.mockImplementation(async () => { f.servers = [{ id: "enki-images", signature: "s", state: "connected", tools: ["generate_image"] }]; });
    await act(async () => node.querySelector("button")!.click());
    expect(f.recover).toHaveBeenCalledTimes(2); expect(node.textContent).toBe("");
  } finally { act(() => root.unmount()); }
});

it("does not consume recovery while the SDK surface is still opening", async () => {
  f.running = false; f.ready = false; f.recover.mockRejectedValue(Error("not ready"));
  const node = document.createElement("div"), root = createRoot(node);
  try {
    await act(async () => root.render(createElement(McpRecoveryNotice, { sessionId: "chat", directory: "/p" })));
    expect(f.recover).not.toHaveBeenCalled();
    f.ready = true;
    await act(async () => root.render(createElement(McpRecoveryNotice, { sessionId: "chat", directory: "/p" })));
    expect(f.recover).toHaveBeenCalledOnce();
  } finally { act(() => root.unmount()); }
});

it("deduplicates startup notices only; uncertain tool-call errors stay visible", () => {
  expect(isMcpStartupNotice("Генерация изображений: Не удалось подключиться к сервису MCP. Проверьте его настройки в каталоге инструментов. Действия сервиса при подключении не запускались.")).toBe(true);
  expect(isMcpStartupNotice("Общий MCP недоступен. Проверьте каталог инструментов; действие не повторялось.")).toBe(false);
  const b = new McpRecoveryBudget(); expect(b.claim("a")).toBe(true); expect(b.claim("a")).toBe(false);
  expect(b.claim("other-host")).toBe(true); b.connected("a"); expect(b.claim("a")).toBe(true);
});

it("retains discovery recovery across a UI reload with only the scoped startup notice", async () => {
  f.running = false; f.servers = []; f.notices = [{ text: "Генератор: Не удалось подключиться к сервису MCP. Действия сервиса при подключении не запускались." }];
  f.recover.mockRejectedValue(Error("Сервис не ответил"));
  const node = document.createElement("div"), root = createRoot(node);
  try {
    await act(async () => root.render(createElement(McpRecoveryNotice, { sessionId: "chat", directory: "/p" })));
    expect(f.recover).toHaveBeenCalledOnce(); expect(node.textContent).toContain("Сервис не ответил");
  } finally { act(() => root.unmount()); }
});

it.each(["session", "directory"])("does not project another %s's startup notices while switching chats", async changed => {
  f.servers = []; f.running = false;
  f.notices = [{ text: "Генератор: Не удалось подключиться к сервису MCP. Действия сервиса при подключении не запускались." }];
  if (changed === "session") f.activeSession = "old-chat"; else f.activeDirectory = "/old-project";
  const node = document.createElement("div"), root = createRoot(node);
  try {
    await act(async () => root.render(createElement(McpRecoveryNotice, { sessionId: "chat", directory: "/p" })));
    expect(node.textContent).toBe(""); expect(f.recover).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); }
});
