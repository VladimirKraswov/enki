// Child chats (subagent sessions of imported archives) open in place without
// joining the root sidebar list. Runs against the actual RuntimeBackend over
// the shared route fixture.
import { afterEach, expect, it, vi } from "vitest";
import { accessRules } from "../src/state/access";
import { bindStore, runtimeFixture } from "./helpers/runtime-fixture";

const childDTO = (id: string, extra: Record<string, unknown> = {}) => ({ id, parentID: "parent", directory: "/test/project", title: "Child", projectID: "p", time: { created: 1, updated: 1 }, ...extra });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("opening a child retains its own model and agent without adding it to root sidebar chats", async () => {
  const { store } = await import("../src/state/store");
  const fx = runtimeFixture();
  const child = { ...childDTO("child"), agent: "child-agent", model: { providerID: "p", id: "child-model", variant: "medium" } };
  fx.on("GET", "/sessions/:id", c => childDTO(c.params.id, { model: child.model }));
  bindStore(store, fx, { directory: child.directory, activeSessionId: "parent", sessions: [], connectedProviderIds: ["p"],
    prefs: { ...store.state.prefs, modelChoice: { "/test/project": { providerID: "p", modelID: "root-model" } }, agentChoice: { "/test/project": "root-agent" } } });
  await store.openChat(child as never);
  expect(store.state.activeSessionId).toBe("child");
  expect(store.getModelChoice()).toEqual({ providerID: "p", modelID: "child-model", variant: "medium" });
  expect(store.getAgentChoice()).toBe("child-agent");
  expect(store.state.sessions.some(s => s.id === "child")).toBe(false);
  expect(fx.made("GET", "/sessions/:id/messages").every(c => c.params.id === "child" && c.query.directory === "/test/project")).toBe(true);
  expect(fx.made("POST", "/commands")).toHaveLength(0);
});

it("updates permissions for an open child without promoting it to the root sidebar", async () => {
  const { store } = await import("../src/state/store");
  const fx = runtimeFixture();
  const child = childDTO("child-access", { permission: [] });
  fx.on("GET", "/sessions/:id", () => child);
  fx.on("PATCH", "/sessions/:id", c => ({ ...child, ...(c.body as object) }));
  bindStore(store, fx, { directory: child.directory, activeSessionId: null, sessions: [] });
  await store.openChat(child as never);
  await store.setAccessMode("read");
  expect(fx.made("PATCH", "/sessions/:id")).toEqual([expect.objectContaining({ path: "/sessions/child-access", query: { directory: "/test/project" }, body: { permission: accessRules("read") } })]);
  expect(store.getAccessMode()).toBe("read");
  expect(store.state.sessions).toEqual([]);
});
