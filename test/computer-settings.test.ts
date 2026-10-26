// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ state: {} as any, invoke: vi.fn(), save: vi.fn(), refresh: vi.fn(), connect: vi.fn() }));
vi.mock("../src/state/store", () => ({ useAppState: () => f.state, store: {
  get state() { return f.state; }, currentHost: () => null, mcpServerStatuses: () => [], mcpConnectionError: () => null,
  capabilitiesCommitted: f.refresh, connectCurrentMcp: f.connect,
} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: f.invoke }));
vi.mock("../src/native/platform", () => ({ platform: () => "macos" }));
vi.mock("../src/components/SettingHelp", () => ({ SettingHelp: () => null }));
vi.mock("../src/capabilities/integration", () => ({ invalidateCapabilities: vi.fn() }));
vi.mock("../src/capabilities/reserved", () => ({ COMPUTER_SERVER: { id: "cua-desktop" }, reservedServerEnabled: async () => true, setReservedServer: f.save }));
import { ComputerSettings } from "../src/components/ComputerSettings";
let root: Root;
const status = { installed: true, enabled: true, version: "0.28.2", permissions: { accessibility: true, screen_recording: true } };
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); (window as any).__TAURI_INTERNALS__ = {};
  f.state = { prefs: { endpoint: "http://127.0.0.1:43123" }, activeSessionId: "same-chat", directory: "/work/a", statuses: {}, activityStatuses: {} };
  f.invoke.mockImplementation(async name => name === "computer_status" ? status : true);
  f.save.mockResolvedValue({}); f.refresh.mockResolvedValue({ reopened: 1, pending: 0 });
  f.connect.mockResolvedValue({ tools: ["mesh_cua_desktop_check_permissions"] });
  const el = document.createElement("div"); document.body.append(el); root = createRoot(el);
  await act(async () => root.render(createElement(ComputerSettings)));
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; delete (window as any).__TAURI_INTERNALS__; vi.unstubAllGlobals(); });
async function connect() { await act(async () => [...document.querySelectorAll("button")].find(b => b.textContent === "Подключить")!.click()); }

it("checks the bridge before registry refresh and confirms tools in the same chat", async () => {
  await connect();
  expect(f.invoke).toHaveBeenCalledWith("shared_install", { nodeProgram: null });
  expect(f.save.mock.invocationCallOrder[0]).toBeGreaterThan(f.invoke.mock.invocationCallOrder[1]);
  expect(f.refresh).toHaveBeenCalledWith(null);
  expect(f.connect).toHaveBeenCalledWith("cua-desktop", "same-chat", "/work/a");
  expect(document.body.textContent).toContain("Подключено к текущему чату · 1 инструментов");
});
it("surfaces a bridge failure without pretending connection succeeded", async () => {
  f.invoke.mockImplementation(async name => { if (name === "shared_install") throw new Error("Не удалось установить мост MCP"); return status; });
  await connect(); expect(f.save).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Не удалось установить мост MCP");
});
it("does not report success until the worker acknowledges tools", async () => {
  f.connect.mockRejectedValue(new Error("Мост MCP не установлен"));
  await connect(); expect(document.body.textContent).not.toContain("Подключено к текущему чату");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Мост MCP не установлен");
  expect(f.invoke).not.toHaveBeenCalledWith("computer_set_enabled", { enabled: false });
});
