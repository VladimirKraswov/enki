// @vitest-environment jsdom
// Regression: the yellow update badge must open the «Обновления» section even
// when React re-runs the mount render (Suspense retry / discarded concurrent
// attempt). The old code consumed a module flag inside the useState
// initializer, so the second render saw "false" and opened «Общее».
// Proof: test/update-navigation-flag.test.ts demonstrates the loss mechanism;
// these tests exercise the real App.tsx pattern with the real SettingsScreen.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StrictMode, Suspense, lazy, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { DEFAULT_PREFS } from "../src/state/prefs";
const fake = vi.hoisted(() => ({ state: {} as any, setUi: vi.fn(), setAsr: vi.fn(), setHelperEndpoint: vi.fn(), setAppearance: vi.fn(), setTheme: vi.fn(), connect: vi.fn() }));
vi.mock("../src/state/store", () => ({ useAppState: () => fake.state, store: { ...fake, hostLabel: () => "Этот компьютер", maybeBackend: () => null, getSnapshot: () => ({ ...fake.state, statuses: {}, activityStatuses: {}, chat: { permissions: {}, questions: {} }, ui: { sending: false, workspacePreparing: false, agentDialog: false, ...fake.state.ui } }) } }));
vi.mock("../src/components/CapabilitiesSettings", () => ({ CapabilitiesSettings: ({ onDirtyChange }: any) => { const [value, setValue] = useState(""); return createElement("input", { "aria-label": "Общий черновик", value, onChange: (e: any) => { setValue(e.target.value); onDirtyChange(true); } }); } }));
vi.mock("../src/components/ComputerSettings", () => ({ ComputerSettings: () => createElement("p", {}, "Cua Driver") }));
vi.mock("../src/components/PiSettings", () => ({ PiSettings: ({ onDirtyChange }: any) => { const [value, setValue] = useState(""); return createElement("input", { "aria-label": "Черновик Pi", value, onChange: (e: any) => { setValue(e.target.value); onDirtyChange(true); } }); } }));
vi.mock("../src/components/BrowserSettings", () => ({ BrowserSettings: ({ onDirtyChange }: any) => { const [value, setValue] = useState(""); return createElement("input", { "aria-label": "Профиль браузера", value, onChange: (e: any) => { setValue(e.target.value); onDirtyChange(true); } }); } }));
import { SettingsScreen } from "../src/components/SettingsScreen";
import { requestUpdateSettings } from "../src/updates/controller";

// Same code-split shape as App.tsx:27 (lazy chunk) and App.tsx:200 (conditional
// mount inside a Suspense boundary).
const SettingsLazy = lazy(() => import("../src/components/SettingsScreen").then(m => ({ default: m.SettingsScreen })));

let root: Root;
function openSettings(strict: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const body = () => createElement(Suspense, { fallback: createElement("p", { id: "fallback" }, "Загрузка настроек…") },
    createElement(SettingsLazy));
  act(() => root.render(strict ? createElement(StrictMode, null, body()) : body()));
  return host;
}

beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollTo = vi.fn();
  fake.state = { prefs: structuredClone(DEFAULT_PREFS), ui: { settingsOpen: true }, connection: { version: "x", phase: "connected", streamState: "open" }, connectedProviderIds: ["local"], agents: [] };
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
const h1 = () => document.querySelector("h1")?.textContent;
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

it("badge click opens the updates section through the lazy app pattern", async () => {
  requestUpdateSettings(); // badge onOpen: intent + settings open (chunk not loaded yet)
  openSettings(false);
  expect(document.getElementById("fallback")).not.toBeNull(); // WKWebView chunk gap
  await settle();
  expect(h1()).toBe("Обновления");
});

it("keeps the navigation when the first mount render is discarded mid-flight", async () => {
  // A descendant suspends AFTER SettingsScreen rendered inside the same
  // boundary: React drops the attempt (state never committed) and re-runs the
  // render when the promise resolves. The consumed-flag initializer lost the
  // navigation here; the render-safe peek keeps it.
  let started = false;
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  function Gate() { if (!started) { started = true; throw promise; } return null; }
  requestUpdateSettings();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(Suspense, { fallback: createElement("p", { id: "fallback" }, "…") },
    createElement("div", null, createElement(SettingsScreen), createElement(Gate)))));
  await act(async () => { resolve(); await new Promise(r => setTimeout(r, 0)); });
  expect(h1()).toBe("Обновления");
});

it("ordinary settings open is unaffected and navigation is not sticky", async () => {
  openSettings(true);
  await settle();
  expect(h1()).toBe("Общее"); // plain open never jumps to updates
  act(() => root.unmount());
  document.body.innerHTML = "";
  openSettings(true);
  await settle();
  expect(h1()).toBe("Общее"); // a committed visit consumed the intent once
});

it("badge click while settings are already mounted navigates to updates", async () => {
  openSettings(true);
  await settle();
  expect(h1()).toBe("Общее");
  act(() => { requestUpdateSettings(); });
  expect(h1()).toBe("Обновления");
});
