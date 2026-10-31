// @vitest-environment jsdom
// Behavior: «Применить на этом устройстве» while an agent is busy.
// Old defect (proven before the fix): the busy check ran before reading the
// models.json, so repeating an already-applied catalog was refused with a red
// error, and the refusal only appeared after the click.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { hubModelsState, mergePiModels, planCatalog } from "../src/models/catalog";

const { fetchCatalog, applyCatalog } = vi.hoisted(() => ({ fetchCatalog: vi.fn(), applyCatalog: vi.fn() }));
vi.mock("../src/hub/modelCatalog", async (importActual) => ({
  ...(await importActual<typeof import("../src/hub/modelCatalog")>()),
  fetchCatalog,
  applyCatalog,
  publishCatalog: vi.fn(),
}));
const fakeStore = vi.hoisted(() => ({
  state: { prefs: { hubModels: {} as Record<string, unknown> }, activityStatuses: {} as Record<string, { type: string }>, statuses: {} as Record<string, { type: string }> },
  client: null as unknown,
  setHubModels: vi.fn(),
  currentHost: vi.fn(() => null),
  refreshModelCatalog: vi.fn(),
}));
vi.mock("../src/state/store", () => ({ useAppState: () => fakeStore.state, store: fakeStore }));
import { ModelCatalogSettings } from "../src/components/ModelCatalogSettings";

const catalog = {
  version: 3,
  models: [{ id: "qwen", label: "Qwen", pi: { providerId: "local-qwen", provider: { baseUrl: "http://127.0.0.1:18021/v1", api: "openai-completions", models: [{ id: "qwen38-flash-next" }] } } }],
};

/** Live models.json that already equals the catalog plan (an applied v3). */
function appliedContent(excluded: string[] = []): string {
  const prefs = hubModelsState({ hubModels: { enabled: true, excluded } });
  const plan = planCatalog(catalog, prefs);
  return mergePiModels('{"providers":{"owner-local":{"models":[]}}}', plan.pi, plan.removePi).text;
}

function port(content: string) {
  return {
    configStatus: vi.fn(async () => ({ state: "none" })),
    modelsConfig: vi.fn(async () => ({ path: "/agent/models.json", content, readOnly: false })),
    saveModelsConfig: vi.fn(async () => ({})),
    refreshProviders: vi.fn(async () => ({ errors: [] })),
  };
}

async function mount(content: string, opts: { busy?: boolean; hubModels?: Record<string, unknown> } = {}) {
  fakeStore.state.prefs.hubModels = { enabled: true, excluded: [], appliedVersion: 2, appliedOpencode: [], appliedPi: ["local-qwen"], ...(opts.hubModels ?? {}) };
  fakeStore.state.activityStatuses = opts.busy ? { s1: { type: "busy" } } : {};
  fakeStore.state.statuses = {};
  const client = port(content);
  fakeStore.client = client;
  fetchCatalog.mockReset().mockResolvedValue(structuredClone(catalog));
  applyCatalog.mockReset();
  fakeStore.setHubModels.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(ModelCatalogSettings)));
  return { host, client, root };
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const buttons = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].filter((b) => b.textContent === text);

beforeEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks?.(); });

it("re-applying an already matching catalog succeeds while an agent is busy, writing nothing", async () => {
  const { host, client } = await mount(appliedContent(), { busy: true });
  await settle(); // readiness preview resolves
  await act(async () => { buttons(host, "Применить на этом устройстве")[0].click(); });
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain("уже применён");
  expect(applyCatalog).not.toHaveBeenCalled();
  expect(client.saveModelsConfig).not.toHaveBeenCalled();
  expect(client.refreshProviders).not.toHaveBeenCalled();
  expect(fakeStore.setHubModels).toHaveBeenCalledWith(expect.objectContaining({ appliedVersion: 3, appliedPi: ["local-qwen"] }));
});

it("real changes are visible before the click and stay blocked while busy, without touching the config", async () => {
  const { host, client, root } = await mount('{"providers":{"owner-local":{"models":[]}}}', { busy: true });
  await settle();
  // The status is visible without a click and is a status, not an error.
  expect(host.textContent).toContain("В каталоге есть изменения настроек моделей");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => { buttons(host, "Применить на этом устройстве")[0].click(); });
  // A refusal while busy is a transient status, not a red error.
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain("Агенты ещё работают — изменения каталога не применены");
  expect(applyCatalog).not.toHaveBeenCalled();
  expect(client.saveModelsConfig).not.toHaveBeenCalled();
  expect(client.refreshProviders).not.toHaveBeenCalled();
  // When the reason disappears, the refusal clears by itself (no stickiness).
  fakeStore.state.activityStatuses = {};
  await act(async () => { root.render(createElement(ModelCatalogSettings)); });
  expect(host.textContent).not.toContain("Агенты ещё работают");
});

it("work that starts during the delayed preview read aborts before any write", async () => {
  const { host, client } = await mount('{"providers":{"owner-local":{"models":[]}}}', { busy: false });
  await settle();
  // Slow the models.json read; an agent starts while the plan is in flight.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  // Capture the implementation, not the mock function: invoking the latter
  // after mockImplementation would recursively call this delayed replacement.
  const original = client.modelsConfig.getMockImplementation()!;
  client.modelsConfig.mockImplementation(async () => { await gate; return original(); });
  await act(async () => { buttons(host, "Применить на этом устройстве")[0].click(); });
  fakeStore.state.activityStatuses = { s9: { type: "busy" } };
  await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain("Агенты ещё работают");
  expect(applyCatalog).not.toHaveBeenCalled();
  expect(client.saveModelsConfig).not.toHaveBeenCalled();
  expect(client.refreshProviders).not.toHaveBeenCalled();
});

it("a per-device disable of an applied model is a real change, not a false no-op", async () => {
  const { host } = await mount(appliedContent(), { busy: true, hubModels: { excluded: ["qwen"] } });
  await settle();
  await act(async () => { buttons(host, "Применить на этом устройстве")[0].click(); });
  expect(host.textContent).toContain("Агенты ещё работают");
  expect(host.textContent).not.toContain("уже применён");
  expect(applyCatalog).not.toHaveBeenCalled();
});

it("when idle, a matching apply records ownership/version locally and writes nothing", async () => {
  const { host, client } = await mount(appliedContent(), { busy: false });
  await settle();
  await act(async () => { buttons(host, "Применить на этом устройстве")[0].click(); });
  expect(host.textContent).toContain("уже применён");
  expect(applyCatalog).not.toHaveBeenCalled();
  expect(client.saveModelsConfig).not.toHaveBeenCalled();
  expect(fakeStore.setHubModels).toHaveBeenCalledWith(expect.objectContaining({ appliedVersion: 3, appliedPi: ["local-qwen"] }));
});

it("when idle and changed, apply proceeds through the full catalog write path", async () => {
  const { host } = await mount('{"providers":{"owner-local":{"models":[]}}}', { busy: false });
  await settle();
  applyCatalog.mockResolvedValue({ report: { added: ["local-qwen"], replaced: [], removed: [] }, appliedOpencode: [], appliedPi: ["local-qwen"] });
  await act(async () => { buttons(host, "Применить на этом устройстве")[0].click(); });
  expect(applyCatalog).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("добавлены: local-qwen");
});

it("a foreign provider refresh timeout is reported as a re-read problem after a real write, not a lost apply", async () => {
  const { host } = await mount('{"providers":{"owner-local":{"models":[]}}}', { busy: false });
  await settle();
  const { CatalogRefreshError: CRE } = await import("../src/hub/modelCatalog");
  applyCatalog.mockRejectedValue(new CRE("Каталог записан, но среда выполнения сообщила об ошибках при перечитывании моделей: deepseek: timeout", ["local-qwen"]));
  await act(async () => { buttons(host, "Применить на этом устройстве")[0].click(); });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Каталог записан");
  expect(fakeStore.setHubModels).toHaveBeenCalledWith(expect.objectContaining({ appliedPi: ["local-qwen"] }));
});
