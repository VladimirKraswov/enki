// @vitest-environment jsdom
// The remote-send dialog must show real Hub devices, address one concrete
// session (or a new one), and report delivery honestly — never a silent success.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const fake = vi.hoisted(() => ({
  overview: vi.fn(), command: vi.fn(), send: vi.fn(), create: vi.fn(),
  state: {} as any, setUi: vi.fn(),
}));
vi.mock("../src/hub/remote", async () => {
  const actual = await vi.importActual<typeof import("../src/hub/remote")>("../src/hub/remote");
  return {
    ...actual,
    remoteOverview: fake.overview, remoteCommand: fake.command,
    sendToSession: fake.send, createRemoteSession: fake.create,
  };
});
vi.mock("../src/state/store", () => ({
  useAppState: () => fake.state,
  store: { get state() { return fake.state; }, setUi: fake.setUi, engineIdFor: () => "pi", currentHost: () => null },
}));
import { RemoteSendDialog } from "../src/components/RemoteSendDialog";

const session = { id: "ses_local", title: "Локальный чат", directory: "/work/here" };
const device = {
  id: "66b9db46-6647-4fc7-81e6-ab1da6116714", name: "Энки Ольга", platform: "macos", online: true,
  overview: {
    sessions: [{ id: "aa11", title: "Калининград", directory: "/Users/olga/proj",
      model: { id: "deepseek-flash", providerID: "deepseek" } }],
    projects: ["/Users/olga/proj"],
  },
};
let root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fake.state = { activeSessionId: session.id, directory: session.directory, prefs: { workspaceKey: "k", endpoint: "http://127.0.0.1:4096" }, ui: { remoteSend: session } };
  fake.overview.mockResolvedValue({ devices: [device] });
  fake.command.mockResolvedValue({ id: "c1", device: device.id, session: "aa11", kind: "prompt", state: "done", result: {} });
  fake.send.mockResolvedValue({ id: "c1", card: { id: "c1", state: "queued" } });
  fake.create.mockResolvedValue({ id: "c2", card: { id: "c2", state: "queued" } });
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

const mount = async () => { await act(async () => root.render(createElement(RemoteSendDialog))); await act(async () => { await Promise.resolve(); }); };
const fill = async (label: string, value: string) => {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const button = (text: string) => [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;

it("sends a request into the chosen session on the chosen device", async () => {
  await mount();
  expect(document.querySelector('[aria-label="Устройство получателя"]')).not.toBeNull();
  expect(document.body.textContent).toContain("Энки Ольга");
  await act(async () => document.querySelector<HTMLButtonElement>(".handoff-target")!.click());
  await fill("Текст запроса", "  привет из мастерской  ");
  await act(async () => button("Отправить").click());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(fake.send).toHaveBeenCalledWith(device.id, expect.objectContaining({ id: "aa11" }), "привет из мастерской");
  expect(document.body.textContent).toContain("Запрос отправлен");
  expect(document.body.textContent).toContain("Калининград");
});

it("creates a new session in a folder of the receiving device", async () => {
  await mount();
  const mode = document.querySelector<HTMLSelectElement>('[aria-label="Способ отправки"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(mode), "value")!.set!;
    setter.call(mode, "new");
    mode.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    const pick = document.querySelector<HTMLSelectElement>('[aria-label="Папка проекта"]')!;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(pick), "value")!.set!;
    setter.call(pick, "/Users/olga/proj");
    pick.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await fill("Текст запроса", "новая задача");
  await act(async () => button("Отправить").click());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(fake.create).toHaveBeenCalledWith(device.id, "/Users/olga/proj", "новая задача",
    { providerID: "deepseek", modelID: "deepseek-flash", variant: null });
});

it("reports a receiver-side failure instead of claiming success", async () => {
  fake.command.mockResolvedValue({ id: "c1", device: device.id, session: "aa11", kind: "prompt", state: "done", result: { error: "Выберите модель." } });
  await mount();
  await act(async () => document.querySelector<HTMLButtonElement>(".handoff-target")!.click());
  await fill("Текст запроса", "задача");
  await act(async () => button("Отправить").click());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(document.body.textContent).toContain("Получатель не выполнил запрос");
  expect(document.body.textContent).toContain("Выберите модель.");
});

it("does not offer devices the Hub knows nothing about", async () => {
  fake.overview.mockResolvedValue({ devices: [{ id: "x", name: "Старый", platform: "macos", online: false }] });
  await mount();
  expect(document.body.textContent).toContain("Нет доступных устройств");
  expect(button("Отправить").disabled).toBe(true);
});
