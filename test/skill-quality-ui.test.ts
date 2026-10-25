// @vitest-environment jsdom
// Skill trials list the skills the bundled runtime can load. Native
// capabilities.rs reports `engines: ["pi"]` for every catalog skill; the former
// filter also required "opencode", so the list was always empty.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const fake = vi.hoisted(() => ({ native: vi.fn(), invoke: vi.fn(), committed: vi.fn() }));
vi.mock("../src/state/store", () => ({
  useAppState: () => ({ prefs: { endpoint: "http://127.0.0.1:43123" }, directory: "/p", statuses: {}, activityStatuses: {}, ui: { sending: false }, activeSessionId: null, chat: { sessions: {} } }),
  store: { currentHost: () => null, engineIdFor: () => "pi", capabilitiesCommitted: fake.committed },
}));
vi.mock("../src/capabilities/integration", () => ({ capabilityNative: fake.native, invalidateCapabilities: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
import { SkillQualitySettings } from "../src/components/SkillQualitySettings";

let root: Root;
const skill = (name: string, engines: string[]) => ({ name, description: "", path: `/skills/${name}/SKILL.md`, source: "own", managed: true, enabled: true, engines, error: null });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fake.native.mockResolvedValue({ skills: [skill("runtime-skill", ["pi"]), skill("foreign", ["claude"])] });
  fake.invoke.mockResolvedValue([]);
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it("offers every skill the runtime loads and nothing it cannot", async () => {
  await act(async () => root.render(createElement(SkillQualitySettings, { onDirtyChange: () => {} })));
  await vi.waitFor(() => expect(document.querySelectorAll('select[aria-label="Навык"] option')).toHaveLength(2));
  const names = [...document.querySelectorAll('select[aria-label="Навык"] option')].map(o => o.textContent);
  expect(names).toEqual(["Выберите навык", "runtime-skill"]);
  expect(document.body.textContent).not.toContain("OpenCode");
});

// Promote rewrites the skill on this computer: the runtime's host-scoped
// refresh port reopens idle chats; the notice reports the real counts.
it("promoting a verified candidate refreshes the runtime's open chats through the typed port", async () => {
  const trial = (n: number) => ({ phase: "candidate", revision: "r2", caseId: "c", engine: "pi", model: "p/m", sessionId: `s${n}`, messageId: `m${n}`, skillRead: true, passed: true, wallMs: 1000, tokens: 10, errors: 0 });
  const experiment = { id: "e1", scope: "global", directory: null, path: "/skills/runtime-skill/SKILL.md", name: "runtime-skill", baseline: "r1", candidate: "r2", baselinePath: "/b", candidatePath: "/c", trials: [trial(1), trial(2), trial(3)], state: "candidate" };
  fake.invoke.mockImplementation(async (_cmd: string, args: { request: { action: string } }) => args.request.action === "list" ? [experiment] : { ...experiment, state: "promoted" });
  fake.committed.mockResolvedValue({ reopened: 1, pending: 2 });
  await act(async () => root.render(createElement(SkillQualitySettings, { onDirtyChange: () => {} })));
  await vi.waitFor(() => expect(document.querySelectorAll('select[aria-label="Эксперимент"] option')).toHaveLength(2));
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Эксперимент"]')!;
  await act(async () => { select.value = "e1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  const promote = [...document.querySelectorAll("button")].find(b => b.textContent === "Применить проверенную версию")!;
  await act(async () => promote.click());
  await vi.waitFor(() => expect(document.body.textContent).toContain("занятые (2)"));
  expect(fake.committed).toHaveBeenCalledExactlyOnceWith(null);
  expect(fake.invoke).toHaveBeenCalledWith("skill_quality", expect.objectContaining({ request: expect.objectContaining({ action: "promote", experimentId: "e1" }) }));
});
