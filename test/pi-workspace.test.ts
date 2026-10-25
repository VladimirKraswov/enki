// @vitest-environment jsdom
// Changes panel of the single runtime: it serves both per-chat edits
// (GET /sessions/:id/diff) and the Git working copy (GET /vcs/diff). The former
// split (Pi → workspace Git only, OpenCode → native session diff) is gone.
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
const fake = vi.hoisted(() => ({
  vcsDiff: vi.fn(async () => [{ file: "tracked.ts", status: "modified", patch: "" }]), sessionDiff: vi.fn(async () => [{ file: "edited.ts", status: "modified", patch: "" }]),
  state: { connection: { phase: "connected", endpoint: "http://127.0.0.1:4096" }, directory: "/workspace", activeSessionId: "chat" as string | null,
    chat: { sessions: {}, sessionPatched: {} }, prefs: { layout: { rightTab: "changes", rightWidth: 400 } } },
}));
vi.mock("../src/state/store", () => ({
  useAppState: () => fake.state,
  useAppSelector: (select: (state: unknown) => unknown) => select(fake.state),
  errText: (e: unknown) => String(e),
  store: { get state() { return fake.state; }, engineIdFor: () => "pi",
    client: { vcsDiff: fake.vcsDiff, sessionDiff: fake.sessionDiff }, setLayout: vi.fn(), setUi: vi.fn() },
}));
import { RightPanel } from "../src/components/RightPanel";
let root: Root;
afterEach(() => { if (root) act(() => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.clearAllMocks(); fake.state.activeSessionId = "chat"; });
const tab = (text: string) => [...document.querySelectorAll("button")].find(b => b.textContent === text)!;
async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => root.render(createElement(RightPanel)));
}

it("shows the open chat's own edits first and the Git working copy on request", async () => {
  await mount();
  expect(fake.sessionDiff).toHaveBeenCalledExactlyOnceWith("chat", "/workspace");
  expect(fake.vcsDiff).not.toHaveBeenCalled();
  expect(tab("Эта задача").className).toContain(" on");
  expect(document.body.textContent).toContain("edited.ts");
  await act(async () => tab("Рабочая копия").click());
  expect(fake.vcsDiff).toHaveBeenCalledExactlyOnceWith("/workspace");
  expect(tab("Рабочая копия").className).toContain(" on");
  expect(document.body.textContent).toContain("tracked.ts");
});

it("without a chat only the working copy is offered", async () => {
  fake.state.activeSessionId = null;
  await mount();
  expect(fake.vcsDiff).toHaveBeenCalledExactlyOnceWith("/workspace");
  expect(fake.sessionDiff).not.toHaveBeenCalled();
  expect(tab("Эта задача").disabled).toBe(true);
  expect(tab("Рабочая копия").className).toContain(" on");
});
