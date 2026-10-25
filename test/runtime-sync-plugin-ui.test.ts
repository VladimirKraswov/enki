// Runtime-only events added with the plugin UI / question pass: live shared-MCP
// reports reach the store, plugin surface projections stay out of the chat
// reducer (the scope-fenced UI stream owns them) and UI faults are visible.
// Questions are NOT consumed here: the chat reducer shows them in the existing card.
import { expect, it, vi } from "vitest";
import { AgentDialogs, routeRuntimeEvent, type RuntimeSyncHost } from "../src/state/runtimeSync";
import type { RuntimeServerStatus } from "../src/capabilities/registry";

function host() {
  const calls = { notice: vi.fn<(sessionID: string | null, text: string) => void>(), mcp: vi.fn<(sessionID: string, servers: RuntimeServerStatus[]) => void>() };
  const value: RuntimeSyncHost = { queue: () => {}, replaceQueues: () => {}, dialog: () => {}, schedule: () => {}, broker: () => {}, notice: calls.notice, mcp: calls.mcp };
  return { value, calls };
}

it("forwards validated worker MCP reports to the store", () => {
  const h = host();
  const good: RuntimeServerStatus = { id: "cua-desktop", signature: "abc", state: "connected", tools: ["click"] };
  expect(routeRuntimeEvent({ type: "mcp.status", properties: { sessionID: "s1", servers: [good, { id: 5 }] } }, h.value, new AgentDialogs())).toBe(true);
  expect(h.calls.mcp).toHaveBeenCalledWith("s1", [good]);
});

it("keeps plugin surface projections out of the chat reducer and shows UI faults", () => {
  const h = host(), dialogs = new AgentDialogs();
  for (const type of ["extension.ui.state", "extension.ui.mode", "extension.ui.available", "extension.draft", "extension.draft.pending", "extension.draft.submission"])
    expect(routeRuntimeEvent({ type, properties: { sessionID: "s1" } }, h.value, dialogs)).toBe(true);
  expect(routeRuntimeEvent({ type: "extension.ui.error", properties: { sessionID: "s1", message: "widget failed" } }, h.value, dialogs)).toBe(true);
  expect(h.calls.notice).toHaveBeenCalledWith("s1", "widget failed");
});

it("lets structured questions reach the chat reducer (existing question card)", () => {
  const h = host();
  expect(routeRuntimeEvent({ type: "question.asked", properties: { id: "que_1", sessionID: "s1", questions: [] } }, h.value, new AgentDialogs())).toBe(false);
  expect(routeRuntimeEvent({ type: "question.replied", properties: { requestID: "que_1" } }, h.value, new AgentDialogs())).toBe(false);
});
