// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { emptyRegistry } from "../src/capabilities/registry";
const fixture = vi.hoisted(() => ({
  state: {} as any,
  invoke: vi.fn(),
  request: vi.fn(),
  configure: vi.fn(),
  close: vi.fn(),
  skills: vi.fn(),
}));
// The runtime is reached through store.maybeBackend(): only the live-worker
// report (GET /extensions) is used here; MCP state comes from worker reports.
vi.mock("../src/state/store", () => ({
  useAppState: () => fixture.state,
  store: {
    currentHost: () => null,
    engineIdFor: () => "pi",
    maybeBackend: () => ({ client: { extensions: fixture.request } }),
    mcpServerStatuses: () => [],
    configureSharedTools: fixture.configure,
  },
}));
vi.mock("../src/capabilities/integration", () => ({
  capabilityNative: fixture.invoke,
  invalidateCapabilities: vi.fn(),
  synchronizeSources: vi.fn(async (c) => ({ catalog: c })),
}));
import { CapabilitiesSettings } from "../src/components/CapabilitiesSettings";
let root: Root;
let catalog: any;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  (window as any).__TAURI_INTERNALS__ = {};
  fixture.state = {
    prefs: { endpoint: "http://127.0.0.1:4096" },
    directory: "/own-project",
    activeSessionId: "own",
    connection: { phase: "connected" },
    statuses: {},
    activityStatuses: {},
    ui: { sending: false },
  };
  catalog = {
    key: "global",
    content: "",
    registry: emptyRegistry(),
    inherited: emptyRegistry(),
    runtimeReady: false,
    scopeDirectory: null,
    command: "/tmp/desktop",
    skills: [
      {
        name: "check-ui",
        description: "Check UI",
        path: "/common/check-ui/SKILL.md",
        managed: true,
        enabled: true,
        engines: ["opencode", "pi"],
        error: null,
      },
    ],
  };
  fixture.invoke.mockImplementation(async (n) => {
    if (n === "shared_catalog") return catalog;
    if (n === "pi_shared_inventory") return { notRunning: true, servers: [] };
    if (n === "shared_save") return catalog;
    return true;
  });
  fixture.request.mockImplementation(async () => ({ sessions: [], mcp: null }));
  fixture.skills.mockResolvedValue([]);
  fixture.configure.mockResolvedValue(undefined);
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  delete (window as any).__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => root.render(createElement(CapabilitiesSettings)));
}
async function click(text: string) {
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent === text)!
      .click(),
  );
}
function input(label: string, text: string) {
  const e = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  )!;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(e, text);
    e.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("does not infer agent readiness from files existing", async () => {
  await mount();
  // The runtime publishes no loaded-skill report: a skill on disk is "not checked", never "found by the agent".
  expect(document.body.textContent).toContain("Агент: Не проверено");
  expect(document.body.textContent).not.toContain("Обнаружен агентом");
  expect(document.body.textContent).toContain("Не установлен");
  expect(fixture.invoke.mock.calls.some((c) => c[0] === "shared_probe")).toBe(
    false,
  );
  expect(fixture.request).toHaveBeenCalledWith("/own-project");
});
it("preserves source scope and refuses changes during another busy agent", async () => {
  fixture.state.activityStatuses = { other: { type: "busy" } };
  await mount();
  input("Идентификатор источника", "shared");
  input("Каталог навыков", "/common");
  const b = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Подключить источник",
  )!;
  expect(b.disabled).toBe(true);
  expect(fixture.invoke.mock.calls.some((c) => c[0] === "shared_save")).toBe(
    false,
  );
});
it("registers the source without rewriting its files and saves only its own registry", async () => {
  await mount();
  input("Идентификатор источника", "shared");
  input("Каталог навыков", "/common");
  await click("Подключить источник");
  expect(fixture.invoke).toHaveBeenCalledWith(
    "shared_save",
    expect.objectContaining({
      scope: "global",
      directory: null,
      expected: "",
      registry: expect.objectContaining({
        sources: [{ id: "shared", path: "/common", enabled: true }],
      }),
    }),
  );
});
// Retired: "closing a current Pi process is explicit and never deletes history".
// No agent process exists to close; SDK reload/newSession preserving the
// transcript is covered by resources/agent/test/sdk-worker-ui.node.ts.
it("offers no action that closes, restarts or clears the running agent session", async () => {
  fixture.request.mockImplementation(async () => ({ sessions: [{ sessionID: "own" }], mcp: null }));
  await mount();
  for (const text of ["Переоткрыть текущую Pi", "Закрыть", "Перезапустить"])
    expect([...document.querySelectorAll("button")].some((b) => b.textContent === text)).toBe(false);
  expect(fixture.close).not.toHaveBeenCalled();
});

it("a bearer change saves a public revision but never the credential in the registry", async () => {
  await mount();
  input("Идентификатор общего MCP", "own-http");
  input("Название общего MCP", "Own HTTP");
  const select = document.querySelector<HTMLSelectElement>(
    '[aria-label="Транспорт общего MCP"]',
  )!;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )!.set!.call(select, "http");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  input("URL общего MCP", "https://fixture.example/mcp");
  input("Токен общего MCP", "own-test-token");
  await click("Сохранить и подключить");
  const saved = fixture.invoke.mock.calls.find(
    (c) => c[0] === "shared_save",
  )![1].registry.servers[0];
  expect(saved.authRevision).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.stringify(saved)).not.toContain("own-test-token");
  expect(fixture.invoke).toHaveBeenCalledWith(
    "shared_mcp_key",
    expect.objectContaining({ value: "own-test-token", id: "own-http" }),
  );
});

// Retired with OpenCode: its /skill discovery endpoint. The runtime loads skills
// through capabilities.prepare (skillPaths) and reports no per-skill evidence,
// so a skill for another agent and a disabled source stay explicit, never "found".
it("never claims live discovery: unsupported agents and disabled sources are explicit", async () => {
  catalog.skills = [
    { ...catalog.skills[0], engines: ["opencode"] },
    { ...catalog.skills[0], path: "/common/off/SKILL.md", name: "off", enabled: false },
  ];
  await mount();
  expect(document.body.textContent).toContain("Агент: Другой агент");
  expect(document.body.textContent).toContain("Агент: Выключен источник; проверьте сессию");
  expect(document.body.textContent).not.toContain("Обнаружен агентом");
});
