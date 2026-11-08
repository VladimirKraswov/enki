// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
const fake = vi.hoisted(() => ({ compact: vi.fn(), running: false, provider: null as { providerID: string; modelID: string } | null, limit: undefined as number | undefined, setMonthlyLimit: vi.fn(), windows: null as unknown }));
vi.mock("../src/usage/windows", async (original) => {
  const real = await original<typeof import("../src/usage/windows")>();
  return { ...real, loadMonthlyUsage: vi.fn(async () => fake.windows) };
});
vi.mock("../src/state/store", () => ({
  useAppState: () => ({ activeSessionId: "pi-chat" }),
  store: {
    engineIdFor: () => "pi", isRunning: () => fake.running,
    conversation: () => ({ capabilities: { compaction: true } }),
    compactSession: fake.compact,
    contextInfo: () => ({ limit: 262144, threshold: 229376, used: 1000, percent: 0, auto: false, compacting: false }),
    getModelChoice: () => fake.provider,
    monthlyLimit: () => fake.limit,
    setMonthlyLimit: fake.setMonthlyLimit,
  },
}));
import { ContextMeter } from "../src/components/ContextMeter";
let root: Root;
afterEach(() => { if (root) act(() => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); fake.running = false; fake.provider = null; fake.limit = undefined; fake.windows = null; vi.clearAllMocks(); });
it("offers native compaction for an idle Pi chat and keeps it disabled while running", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  act(() => root.render(createElement(ContextMeter)));
  act(() => document.querySelector<HTMLButtonElement>(".context-trigger")!.click());
  const button = [...document.querySelectorAll("button")].find(b => b.textContent === "Сжать сейчас")!;
  expect(button.disabled).toBe(false); act(() => button.click());
  expect(fake.compact).toHaveBeenCalledWith("pi-chat");
  fake.running = true; act(() => root.render(createElement(ContextMeter)));
  expect(button.disabled).toBe(true);
  expect(document.body.textContent).not.toContain("Автосжатие отключено в OpenCode");
});
it("shows monthly Enki consumption and the configured limit next to the context meter", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  fake.provider = { providerID: "kimi-coding", modelID: "k3.1-pro" };
  fake.windows = { usage: { provider: "kimi-coding", tokens: 4000, replies: 3, resetAt: new Date(2026, 11, 1).getTime() }, failures: [] };
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  act(() => root.render(createElement(ContextMeter)));
  act(() => document.querySelector<HTMLButtonElement>(".context-trigger")!.click());
  await act(async () => { await Promise.resolve(); });
  expect(document.body.textContent).toContain("Месячный расход · kimi-coding");
  expect(document.body.textContent).toContain("4\u00A0000");
  // Без лимита процентов нет — никаких выдуманных цифр.
  expect(document.body.textContent).not.toContain("Осталось до лимита");
  expect(document.body.textContent).not.toContain("Месяц 40%");
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Месячный лимит провайдера в токенах"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "10000"); input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(fake.setMonthlyLimit).toHaveBeenCalledWith("kimi-coding", 10000);
  // Пользователь задал лимит: теперь появляются проценты и остаток.
  fake.limit = 10000; await act(async () => root.render(createElement(ContextMeter)));
  expect(document.body.textContent).toContain("Осталось до лимита");
  expect(document.body.textContent).toContain("6\u00A0000");
  expect(document.body.textContent).toContain("Месяц 40%");
});
