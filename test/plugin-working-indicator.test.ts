// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ running: false, view: null as any, active: null as any }));
vi.mock("../src/state/store", () => ({ store: { isRunning: () => fake.running, client: {}, state: {}, setUi: vi.fn() }, errText: String,
  useAppSelector: (select: any) => select({ connection: { phase: "connected" }, prefs: { theme: "dark" } }) }));
vi.mock("../src/agent/runtime/pluginUi/active", () => ({ activePluginUi: { subscribe: () => () => {}, get: () => fake.active, activate: vi.fn(), deactivate: vi.fn() } }));
vi.mock("../src/components/PluginTerminalSurface", () => ({ PluginTerminalSurface: () => null }));
import { PluginUiPanel } from "../src/components/PluginUiPanel";
afterEach(() => { document.body.innerHTML = ""; vi.unstubAllGlobals(); });
it("generic activity is shown only by the chat; explicit extension progress follows real busy state", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fake.view = { phase: "live", generation: 1, mode: { custom: false, terminalInput: false }, notices: [], snapshot: {
    state: { statuses: { extension: "Расширение подключено" }, working: { visible: true, message: null }, widgets: [] }, pendingDraft: null, pendingSubmission: null,
  } };
  let draft: any = { kind: "offline" };
  fake.active = { session: { sessionID: "chat", subscribe: () => () => {}, getView: () => fake.view }, draft: { subscribe: () => () => {}, getState: () => draft, stash: null } };
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  try {
    fake.running = false; act(() => root.render(createElement(PluginUiPanel, { sessionId: "chat", directory: "/p" })));
    expect(node.querySelector(".plugin-ui-working")).toBeNull();
    expect(node.textContent).toContain("Расширение подключено");
    fake.running = true; act(() => root.render(createElement(PluginUiPanel, { sessionId: "chat", directory: "/p" })));
    expect(node.querySelector(".plugin-ui-working")).toBeNull();
    fake.view.snapshot.state.working.message = "Проверка файлов: 3 из 10";
    act(() => root.render(createElement(PluginUiPanel, { sessionId: "chat", directory: "/p" })));
    expect(node.querySelector(".plugin-ui-working")?.textContent).toBe("Проверка файлов: 3 из 10");
    fake.running = false; act(() => root.render(createElement(PluginUiPanel, { sessionId: "chat", directory: "/p" })));
    expect(node.querySelector(".plugin-ui-working")).toBeNull();
    expect(node.textContent).toContain("Интерфейс расширения");
    fake.view.snapshot.state.statuses = {};
    act(() => root.render(createElement(PluginUiPanel, { sessionId: "chat", directory: "/p" })));
    expect(node.textContent).toBe("");
    fake.running = true;
    fake.view.snapshot.state.working.message = "   ";
    act(() => root.render(createElement(PluginUiPanel, { sessionId: "chat", directory: "/p" })));
    expect(node.textContent).toBe("");
    draft = { kind: "conflict", local: "my draft", canonical: { text: "other window", revision: 2 }, message: "Черновик изменён в другом окне" };
    act(() => root.render(createElement(PluginUiPanel, { sessionId: "chat", directory: "/p" })));
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("Черновик изменён в другом окне");
    draft = { kind: "retrying", message: "Временный сбой" };
    act(() => root.render(createElement(PluginUiPanel, { sessionId: "chat", directory: "/p" })));
    expect(node.querySelector('[role="status"]')?.textContent).toContain("Временный сбой");
  } finally { act(() => root.unmount()); }
});

it("shows uncertain tool failures but leaves discovery failure to the recovery card", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const startup = "Генератор: Не удалось подключиться к сервису MCP. Действия сервиса при подключении не запускались.";
  const action = "Общий MCP недоступен; действие не повторялось.";
  fake.running = false;
  fake.view = { phase: "live", generation: 1, mode: { custom: false, terminalInput: false }, notices: [
    { at: 1, level: "warning", text: startup }, { at: 2, level: "warning", text: action },
  ], snapshot: { state: { statuses: {}, working: { visible: false }, widgets: [] } } };
  const draft = { kind: "synced" };
  fake.active = { session: { sessionID: "chat", subscribe: () => () => {}, getView: () => fake.view },
    draft: { subscribe: () => () => {}, getState: () => draft, stash: null } };
  const node = document.createElement("div"), root = createRoot(node);
  try {
    act(() => root.render(createElement(PluginUiPanel, { sessionId: "chat", directory: "/p" })));
    expect(node.textContent).not.toContain(startup); expect(node.textContent).toContain(action);
  } finally { act(() => root.unmount()); }
});
