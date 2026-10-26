// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ state: { activeSessionId: "chat", directory: "/p", connection: { phase: "connected" }, prefs: { endpoint: "local", layout: { sidebarOpen: true, rightOpen: false, bottomOpen: false } }, ui: {} } as any, layout: vi.fn(), ui: vi.fn(), terminal: vi.fn() }));
vi.mock("../src/state/store", () => ({ useAppState: () => fake.state, store: { activeSession: () => ({ id: "chat", title: "A very long chat title" }), isLegacySession: () => false, currentHost: () => null,
  workspaceToolsAvailable: () => true, setLayout: fake.layout, setUi: fake.ui, toggleTerminal: fake.terminal } }));
vi.mock("../src/components/ContextPanel", () => ({ CONTEXT_PANEL_ID: "chat-context-panel" }));
vi.mock("../src/components/BrowserSettings", () => ({ BrowserButton: ({ compact }: { compact: boolean }) => createElement("button", { "aria-label": "Открыть браузер агента", "data-compact": compact }, compact ? "" : "Браузер") }));
vi.mock("../src/agent/runtime/backend", () => ({ RUNTIME_CAPABILITIES: { fork: true } }));
vi.mock("../src/components/RecoveryCenter", () => ({ RecoveryCenter: () => createElement("div", { role: "dialog", "aria-label": "Восстановление" }, "Журнал") }));
import { TopBar } from "../src/components/TopBar";
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); document.body.innerHTML = ""; });
it("keeps three compact controls and exposes named actions with keyboard navigation", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  try {
    act(() => root.render(createElement(TopBar)));
    expect(node.querySelectorAll(".chat-toolbar button")).toHaveLength(3);
    expect(node.querySelector('[aria-label="Открыть браузер агента"]')?.getAttribute("data-compact")).toBe("true");
    act(() => node.querySelector<HTMLButtonElement>('[aria-label="Действия чата"]')!.click());
    const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(rows.map(r => r.textContent)).toEqual(["ТерминалCtrl+`", "Изменения и файлы", "Передать задание", "Журнал отправок и восстановление"]);
    expect(document.activeElement).toBe(rows[0]);
    act(() => rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(rows.at(-1));
    act(() => rows.at(-1)!.click());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="dialog"][aria-label="Восстановление"]')).not.toBeNull();
    expect(fake.terminal).not.toHaveBeenCalled(); expect(fake.layout).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); }
});
