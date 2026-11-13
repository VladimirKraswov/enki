// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
const fake = vi.hoisted(() => ({ compact: vi.fn(), running: false, provider: null as { providerID: string; modelID: string } | null, limit: undefined as number | undefined, setMonthlyLimit: vi.fn(), windows: null as unknown, quota: null as unknown }));
vi.mock("../src/usage/windows", async (original) => {
  const real = await original<typeof import("../src/usage/windows")>();
  return { ...real, loadMonthlyUsage: vi.fn(async () => fake.windows) };
});
vi.mock("../src/state/store", () => ({
  useAppState: () => ({ activeSessionId: "pi-chat", providers: [{ id: "kimi-coding", name: "Kimi For Coding" }, { id: "deepseek", name: "DeepSeek" }] }),
  store: {
    engineIdFor: () => "pi", isRunning: () => fake.running,
    conversation: () => ({ capabilities: { compaction: true } }),
    compactSession: fake.compact,
    contextInfo: () => ({ limit: 262144, threshold: 229376, used: 1000, percent: 0, auto: false, compacting: false }),
    getModelChoice: () => fake.provider,
    monthlyLimit: () => fake.limit,
    setMonthlyLimit: fake.setMonthlyLimit,
    client: { providerUsage: async () => { if (!fake.quota) throw new Error('no quota'); return fake.quota; } },
  },
}));
import { ContextMeter } from "../src/components/ContextMeter";
let root: Root;
afterEach(() => { if (root) act(() => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); fake.running = false; fake.provider = null; fake.limit = undefined; fake.windows = null; fake.quota = null; vi.clearAllMocks(); });
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
  expect(document.body.textContent).toContain("Месячный расход · Kimi For Coding");
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

it("does not pretend a provider without an official quota API is still loading", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  fake.provider = { providerID: "deepseek", modelID: "deepseek-flash" };
  fake.windows = { usage: { provider: "deepseek", tokens: 100, replies: 1, resetAt: Date.now() }, failures: [] };
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  act(() => root.render(createElement(ContextMeter)));
  act(() => document.querySelector<HTMLButtonElement>(".context-trigger")!.click());
  await act(async () => { await Promise.resolve(); });
  const text = document.body.textContent ?? "";
  expect(text).toContain("Квота провайдера · DeepSeek");
  expect(text).toContain("не публикует официальный остаток квоты");
  expect(text).not.toContain("Запрашиваю официальную квоту");
  expect(text).not.toContain("Квота подписки ·");
});

it("shows the provider's own quota when it answers, with reset times", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  fake.provider = { providerID: "kimi-coding", modelID: "k3.1-pro" };
  fake.windows = { usage: { provider: "kimi-coding", tokens: 1000, replies: 1, resetAt: new Date(2026, 11, 1).getTime() }, failures: [] };
  fake.quota = {
    limit5h: { usedRatio: 1, resetAt: new Date(2026, 10, 9, 17, 51).toISOString() },
    limit7d: null,
    monthTotal: { usedRatio: 0.1341, resetAt: new Date(2026, 11, 8, 17, 3).toISOString() },
    monthCode: { usedRatio: 0.05, resetAt: null },
    extraUsage: null,
  };
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  act(() => root.render(createElement(ContextMeter)));
  act(() => document.querySelector<HTMLButtonElement>(".context-trigger")!.click());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const text = document.body.textContent ?? "";
  expect(text).toContain("Квота подписки · Kimi For Coding");
  expect(text).toContain("5 часов");
  expect(text).toContain("100%");
  expect(text).toContain("Месяц · всего");
  expect(text).toContain("13%");
  expect(text).not.toContain("Неделя");  // отсутствующее окно не выдумывается
  expect(document.querySelectorAll('progress[aria-label^="Израсходовано"]').length).toBe(3); // 5ч, месяц·Код, месяц·всего
});
