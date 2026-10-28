// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ session: "a", mounted: new Set<string>(), opened: 0, closed: 0 }));
vi.mock("../src/state/store", () => ({ applyTheme: vi.fn(), store: {
  state: { prefs: { theme: "dark" }, ui: {} }, connect: async () => {}, restorePiRuntime: async () => {},
  refreshPiActivity: async () => {}, isLegacySession: () => false, workspaceToolsAvailable: () => false,
}, useAppSelector: () => ({ prefs: { layout: { sidebarOpen: false } }, ui: {}, connection: { phase: "connected" }, directory: "/project", activeSessionId: f.session }) }));
vi.mock("../src/native/platform", () => ({ platform: () => "mac", isNative: () => false, hasOverlayWindowControls: () => false }));
vi.mock("../src/agent/runtime/backend", () => ({ RUNTIME_CAPABILITIES: {} }));
vi.mock("../src/components/McpRecoveryNotice", () => ({ McpRecoveryNotice: ({ sessionId }: { sessionId: string }) => createElement("div", { "data-recovery": sessionId }, sessionId) }));
vi.mock("../src/components/PluginUiPanel", () => ({ PluginUiBelowComposer: () => null, PluginUiPanel: ({ sessionId }: { sessionId: string }) => {
  useEffect(() => { f.opened++; f.mounted.add(sessionId); return () => { f.closed++; f.mounted.delete(sessionId); }; }, [sessionId]);
  return createElement("div", { "data-plugin": sessionId }, sessionId);
} }));
vi.mock("../src/components/ChatView", () => ({ ChatView: () => createElement("div", { "data-chat": true }) }));
vi.mock("../src/components/Composer", () => ({ Composer: () => createElement("div", { "data-composer": true }) }));
vi.mock("../src/updates/runtime", () => ({ UpdateRuntime: () => null }));
vi.mock("../src/memory/Runtime", () => ({ MemoryRuntime: () => null }));
vi.mock("../src/hub/Runtime", () => ({ HubRuntime: () => null }));
vi.mock("../src/schedules/Runtime", () => ({ ScheduleRuntime: () => null }));
vi.mock("../src/components/ContextPanel", () => ({ ContextPanel: () => null }));
vi.mock("../src/components/HandoffDialog", () => ({ HandoffDialog: () => null }));
vi.mock("../src/components/BrowserPanel", () => ({ BrowserPanel: () => null, BrowserPresence: () => null }));
vi.mock("../src/components/PiDialog", () => ({ PiDialog: () => null }));
vi.mock("../src/components/HostDialogs", () => ({ HostDialogs: () => null }));
vi.mock("../src/components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("../src/components/TopBar", () => ({ TopBar: () => null }));
vi.mock("../src/components/RightPanel", () => ({ RightPanel: () => null }));
vi.mock("../src/components/Dialogs", () => ({ ConnectionGate: () => null, DeleteConfirm: () => null, Toast: () => null }));
vi.mock("../src/components/TerminalPanel", () => ({ TerminalPanel: () => null }));
vi.mock("../src/components/Palette", () => ({ Palette: () => null }));
import App from "../src/App";

it("switching chats retains exactly one recovery notice and one owned plugin connection, and releases the previous chat", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div"), root = createRoot(node);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  f.opened = f.closed = 0; f.mounted.clear();
  try {
    for (const session of ["a", "b", "c", "a", "b", "c", "a"]) {
      f.session = session;
      await act(async () => root.render(createElement(App)));
      expect(node.querySelectorAll("[data-recovery]")).toHaveLength(1);
      expect(node.querySelector("[data-recovery]")?.getAttribute("data-recovery")).toBe(session);
      expect(node.querySelectorAll("[data-plugin]")).toHaveLength(1);
      expect([...f.mounted]).toEqual([session]);
      expect(f.opened - f.closed).toBe(1);
      expect([...node.querySelector(".chat-col")!.children].map(n => n.getAttributeNames().find(a => a.startsWith("data-"))))
        .toEqual(["data-chat", "data-recovery", "data-plugin", "data-composer"]);
    }
    expect(errors).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); errors.mockRestore(); vi.unstubAllGlobals(); }
  expect(f.mounted.size).toBe(0); expect(f.closed).toBe(f.opened);
});
