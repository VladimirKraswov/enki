// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const fake = vi.hoisted(() => ({
  state: { prefs: { browser: {} } } as { prefs: { browser: { environment?: unknown } } },
  invoke: vi.fn(),
  setBrowserSettings: vi.fn(),
}));
vi.mock("../src/state/store", () => ({
  useAppState: () => fake.state,
  store: { setBrowserSettings: fake.setBrowserSettings, get state() { return fake.state; } },
}));
vi.mock("../src/browser/integration", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/browser/integration")>();
  return { ...actual, browserNative: fake.invoke };
});
import { BrowserEnvironmentSettings } from "../src/components/BrowserEnvironmentSettings";
import { browserEnvironmentDefaults } from "../src/browser/environment";

let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fake.invoke.mockReset();
  fake.setBrowserSettings.mockReset();
  fake.state.prefs = { browser: {} };
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const mount = async () =>
  act(async () => root.render(createElement(BrowserEnvironmentSettings, { disabled: false, running: false })));
const button = (text: string) => [...document.querySelectorAll("button")].find(el => el.textContent === text)!;
const profile = (title: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(el => el.querySelector("strong")?.textContent === title)!;
const summary = () => document.querySelector(".browser-summary")?.textContent ?? "";

it("explains every ready profile and shows what the current draft will do", async () => {
  await mount();
  for (const title of ["Стандартный", "Быстрый", "Совместимость", "Приватный"]) {
    expect(document.body.textContent).toContain(title);
  }
  // The default profile is the embedded browser with hidden automation markers.
  expect(summary()).toContain("Chromium Enki (встроенный)");
  expect(summary()).toContain("Во встроенной панели Enki");
  expect(summary()).toContain("Обычный Chrome, маркеры скрыты");
  expect(summary()).toContain("Сохраняются между запусками");
  expect(button("Сохранить профиль").disabled).toBe(true);
  expect(document.querySelector<HTMLDetailsElement>(".browser-advanced")!.open).toBe(false);
});

it("reports an unsaved profile and clears the warning after returning to saved values", async () => {
  const dirty = vi.fn();
  await act(async () => root.render(createElement(BrowserEnvironmentSettings, { disabled: false, running: false, onDirtyChange: dirty })));
  expect(dirty).toHaveBeenLastCalledWith(false);
  await act(async () => profile("Приватный").click()); expect(dirty).toHaveBeenLastCalledWith(true);
  await act(async () => profile("Стандартный").click()); expect(dirty).toHaveBeenLastCalledWith(false);
  expect(fake.setBrowserSettings).not.toHaveBeenCalled(); expect(fake.invoke).not.toHaveBeenCalled();
});

it("updates the summary and enables saving when another profile is chosen", async () => {
  await mount();
  await act(async () => profile("Совместимость").click());
  expect(summary()).toContain("Google Chrome (установленный)");
  expect(summary()).toContain("В обычном окне браузера");
  expect(summary()).toContain("Обычный Chrome, маркеры скрыты");
  expect(summary()).toContain("пауза 150 мс");
  expect(button("Сохранить профиль").disabled).toBe(false);
  await act(async () => button("Сохранить профиль").click());
  expect(fake.setBrowserSettings).toHaveBeenCalledWith({
    environment: expect.objectContaining({ engine: "chrome", display: "window", reduceAutomationSignals: true, actionDelayMs: 150 }),
  });
});

it("makes the speed and fingerprint trade-offs of the fast profile explicit", async () => {
  await mount();
  await act(async () => profile("Быстрый").click());
  expect(summary()).toContain("Видны следы автоматизации");
  expect(summary()).toContain("Самый быстрый запуск");
  await act(async () => profile("Приватный").click());
  expect(summary()).toContain("Временные, до закрытия");
});

it("marks a hand-tuned set as custom instead of pretending it is a preset", async () => {
  await mount();
  const engine = document.getElementById("browser-env-engine") as HTMLSelectElement;
  act(() => {
    engine.value = "chrome";
    engine.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.body.textContent).toContain("Настройки изменены вручную");
  expect(summary()).toContain("Google Chrome (установленный)");
  expect(document.querySelectorAll(".browser-profile.is-active")).toHaveLength(0);
});

it("resets to the recommended default profile", async () => {
  await mount();
  await act(async () => profile("Совместимость").click());
  await act(async () => button("Сбросить профиль").click());
  expect(summary()).toContain("Chromium Enki (встроенный)");
  expect(summary()).toContain("Во встроенной панели Enki");
  expect(summary()).toContain("Обычный Chrome, маркеры скрыты");
  expect(summary()).toContain("Сохраняются между запусками");
  expect(browserEnvironmentDefaults.reduceAutomationSignals).toBe(true);
});
