// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BrowserSetup, BrowserStatus } from "../src/browser/integration";

const fake = vi.hoisted(() => ({
  state: {} as any, setup: {} as BrowserSetup, native: true, host: null as object | null,
  invoke: vi.fn(), configureBrowser: vi.fn(), ensureChatWorkspace: vi.fn(), createSessionNow: vi.fn(), setBrowserSettings: vi.fn(), setUi: vi.fn(),
}));
vi.mock("../src/state/store", () => ({ useAppState: () => fake.state, store: {
  currentHost: () => fake.host, configureBrowser: fake.configureBrowser,
  ensureChatWorkspace: fake.ensureChatWorkspace, createSessionNow: fake.createSessionNow,
  get state() { return fake.state; }, engineIdFor: () => "pi",
  setBrowserSettings: fake.setBrowserSettings, setUi: fake.setUi,
} }));
vi.mock("../src/browser/integration", async importOriginal => { const actual=await importOriginal<typeof import("../src/browser/integration")>(); return {
  ...actual,
  openSessionBrowser: (...args: any[]) => actual.openSessionBrowser(args[0],args[1],args[2],args[3],fake.invoke),
  browserNative: fake.invoke, useBrowserSetup: () => fake.setup, browserSetupSnapshot: () => fake.setup,
}; });
vi.mock("../src/native/platform", () => ({ isNative: () => fake.native }));
import { BrowserButton, BrowserSettings } from "../src/components/BrowserSettings";

let root: Root;
let status: BrowserStatus;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fake.native = true; fake.host = null;
  fake.state = { activeSessionId:"ses_test",directory:"/test",chat: { sessions: {} }, ui: { sending: false, workspacePreparing: false }, prefs: { endpoint: "http://127.0.0.1:4096", browser: { enabled: true }, pi: { nodeProgram: "/opt/homebrew/bin/node" } } };
  status = { supported: true, installed: true, running: true, browserOpen: false,
    command: "/Applications/OpenCode Desktop.app/Contents/MacOS/app", nodeProgram: "/opt/homebrew/bin/node",
    skillPath: "/tmp/browser/skill", runtimePath: "/tmp/browser/current", profilePath: "/tmp/browser/profile", version: "0.0.83" };
  // The actual BrowserSetup DTO of the single runtime (no per-engine fields).
  fake.setup = { phase: "ready", agent: "Подключается к новым сессиям агента", status };
  fake.invoke.mockImplementation(async (command: string) => {
    if (command === "browser_status") return status;
    if (command === "browser_start") return status;
    if (command === "browser_session") return {result:{scopeKey:"fixture-key",scope:{engine:"pi",sessionID:fake.state.activeSessionId ?? "ses_test"}}};
    if (command === "browser_open") return { ...status, browserOpen: true };
    if (command === "browser_stop") return { ...status, running: false, browserOpen: false };
    throw new Error(`Unexpected command: ${command}`);
  });
  fake.configureBrowser.mockResolvedValue(undefined);
  fake.ensureChatWorkspace.mockResolvedValue(true);
  fake.createSessionNow.mockImplementation(async () => ({id:"ses_test",directory:fake.state.directory}));
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

const mount = async (Component = BrowserSettings) => { await act(async () => root.render(createElement(Component))); };
const button = (text: string) => [...document.querySelectorAll("button")].find(el => el.textContent === text)!;
const opens = () => fake.invoke.mock.calls.filter(([command]) => command === "browser_open");
function input(id: string, value: string) {
  const el = document.getElementById(id) as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const enter = async () => { await act(async () => document.getElementById("browser-address")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

it.each(["remote host", "remote endpoint", "web preview", "disabled", "checking", "installing", "configuring", "not installed"])("cannot bypass browser controls with Enter while %s", async reason => {
  if (reason === "remote host") fake.host = {};
  if (reason === "remote endpoint") fake.state.prefs.endpoint = "http://192.168.31.22:4096";
  if (reason === "web preview") fake.native = false;
  if (reason === "disabled") fake.state.prefs.browser.enabled = false;
  if (["checking", "installing", "configuring"].includes(reason)) fake.setup.phase = reason as BrowserSetup["phase"];
  if (reason === "not installed") status.installed = false;
  await mount(); input("browser-address", "https://example.com/private"); await enter();
  expect(button("Открыть браузер").disabled).toBe(true);
  expect(opens()).toHaveLength(0);
  expect(fake.configureBrowser).not.toHaveBeenCalled();
  if (reason.startsWith("remote")) {
    expect(document.body.textContent).toContain("Для настройки выберите «Этот компьютер»");
    expect(button("Сохранить и проверить путь").disabled).toBe(true);
  }
  if (reason === "web preview") {
    expect(document.body.textContent).toContain("Откройте установленное приложение");
    expect(fake.invoke).not.toHaveBeenCalled();
  }
});

it("opens the entered URL locally with the explicit browser Node path", async () => {
  fake.state.prefs.browser.nodeProgram = "/Applications/Node Runtime/node";
  await mount(); input("browser-address", "  https://example.com/project?q=code  "); await enter();
  expect(opens()).toEqual([["browser_open", { url: "https://example.com/project?q=code", nodeProgram: "/Applications/Node Runtime/node", scopeKey:"fixture-key" }]]);
  expect(document.body.textContent).toContain("Браузер открыт в Enki");
  expect(fake.setBrowserSettings).not.toHaveBeenCalled();
});

it("ignores a second Enter while the first browser open is pending", async () => {
  const pending = deferred<BrowserStatus>();
  // The native scope echoes the runtime's engine tag; the strict scope guard is unchanged.
  fake.invoke.mockImplementation((command: string) => command === "browser_open" ? pending.promise : Promise.resolve(command === "browser_session" ? {result:{scopeKey:"fixture-key",scope:{engine:"pi",sessionID:"ses_test"}}} : status));
  await mount(); await enter(); await enter();
  expect(opens()).toHaveLength(1);
  expect(button("Открыть браузер").disabled).toBe(true);
  await act(async () => pending.resolve({ ...status, browserOpen: true }));
  expect(button("Открыть браузер").disabled).toBe(false);
});

it("shows a failed open honestly and clears its alert after a successful refresh", async () => {
  fake.invoke.mockImplementation(async (command: string) => {
    if (command === "browser_open") throw new Error("Chromium could not start");
    if (command === "browser_session") return {result:{scopeKey:"fixture-key",scope:{engine:"pi",sessionID:"ses_test"}}};
    return status;
  });
  await mount(); await enter();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Chromium could not start");
  expect(document.body.textContent).not.toContain("Браузер открыт в Enki");
  await act(async () => button("Обновить состояние").click());
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it("refuses to open a browser whose native scope belongs to another chat or engine tag", async () => {
  for (const scope of [{ engine: "opencode", sessionID: "ses_test" }, { engine: "pi", sessionID: "ses_other" }]) {
    fake.invoke.mockImplementation(async (command: string) => command === "browser_session" ? { result: { scopeKey: "foreign", scope } } : status);
    await mount(); await enter();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("другого чата");
  }
  expect(opens()).toHaveLength(0);
});

it("saves an optional Node path without changing agent permissions or opening a browser", async () => {
  await mount(); input("browser-node", "  /Users/example/Node Runtime/node  ");
  await act(async () => button("Сохранить и проверить путь").click());
  expect(fake.setBrowserSettings).toHaveBeenCalledExactlyOnceWith({ nodeProgram: "/Users/example/Node Runtime/node" });
  expect(opens()).toHaveLength(0);
  expect(fake.configureBrowser).not.toHaveBeenCalled();
});

it("offers an emergency stop for the owned local service even when a remote host is selected", async () => {
  fake.host = {}; await mount();
  expect(button("Открыть браузер").disabled).toBe(true);
  expect(button("Остановить управление").disabled).toBe(false);
  await act(async () => button("Остановить управление").click());
  expect(fake.invoke).toHaveBeenCalledWith("browser_stop");
  expect(fake.setBrowserSettings).toHaveBeenCalledWith({ enabled: false });
  expect(document.body.textContent).toContain("Остановлен");
});

it("does not open from the toolbar after configuration reports an MCP error", async () => {
  fake.configureBrowser.mockImplementation(async () => { fake.setup = { ...fake.setup, phase: "error", error: "MCP не подключён" }; });
  await mount(BrowserButton);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Открыть браузер агента"]')!.click());
  expect(fake.configureBrowser).toHaveBeenCalledOnce();
  expect(opens()).toHaveLength(0);
  expect(fake.setUi).toHaveBeenNthCalledWith(1, { browserOpen: true });
  expect(fake.setUi).toHaveBeenLastCalledWith({ toast: "Браузер: MCP не подключён" });
  expect(document.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
});

it("waits for toolbar configuration, prevents duplicate clicks, and opens a blank tab on success", async () => {
  const pending = deferred<void>(); fake.configureBrowser.mockReturnValue(pending.promise);
  await mount(BrowserButton);
  const control = document.querySelector<HTMLButtonElement>('[aria-label="Открыть браузер агента"]')!;
  await act(async () => control.click());
  expect(control.disabled).toBe(true); expect(control.textContent).toContain("Открываю"); expect(opens()).toHaveLength(0);
  expect(fake.setUi).toHaveBeenCalledWith({browserOpen:true});
  await act(async () => control.click()); expect(fake.configureBrowser).toHaveBeenCalledOnce();
  await act(async () => pending.resolve());
  // The legacy Pi CLI Node path in prefs is ignored: null lets native discovery choose.
  expect(opens()).toEqual([["browser_open", { url: null, nodeProgram: null,scopeKey:"fixture-key" }]]);
  expect(control.disabled).toBe(false); expect(fake.setUi).toHaveBeenCalledWith({ browserOpen: true });
});

// BrowserSettings renders the single runtime's `agent` state (the removed
// setup.openCode/setup.pi fields crashed the initial idle render).
it("renders the initial setup state of the single runtime without per-engine rows", async () => {
  fake.setup = { phase: "idle", agent: "Не проверено" };
  await mount();
  expect(document.body.textContent).toContain("Настройка при запуске приложения");
  expect(document.body.textContent).not.toContain("OpenCode");
  fake.setup = { phase: "ready", agent: "Подключается к новым сессиям агента", status };
  await mount();
  expect(document.body.textContent).toContain("Подключается к новым сессиям агента");
});

it("creates an empty scoped chat and opens the browser before any model turn", async () => {
  fake.state.activeSessionId = null;
  fake.state.directory = null;
  fake.ensureChatWorkspace.mockImplementation(async () => { fake.state.directory = "/test/browser-workspace"; return true; });
  fake.createSessionNow.mockImplementation(async (title: string) => {
    expect(title).toBe("Браузер");
    fake.state.activeSessionId = "ses_browser";
    return {id:"ses_browser",directory:fake.state.directory};
  });
  await mount(BrowserButton);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Открыть браузер агента"]')!.click());
  expect(fake.ensureChatWorkspace).toHaveBeenCalledOnce();
  expect(fake.createSessionNow).toHaveBeenCalledOnce();
  expect(fake.invoke).toHaveBeenCalledWith("browser_open", expect.objectContaining({url:null,scopeKey:"fixture-key"}));
  expect(fake.setUi).toHaveBeenCalledWith({browserOpen:true});
});

it("reads numeric diagnostics on demand without navigating or fetching session history", async () => {
  fake.invoke.mockImplementation(async command => command === "browser_presence" ? {performance:{calls:3,failed:1,queueMs:1000,actionMs:2000,observeMs:500,completedSteps:2}} : status);
  await mount(); expect(fake.invoke.mock.calls.filter(([c]) => c === "browser_presence")).toHaveLength(0);
  await act(async () => button("Обновить метрики").click());
  expect(document.body.textContent).toContain("1.0 с / 2.0 с / 0.5 с");
  expect(document.body.textContent).toContain("3 / 1 / 2"); expect(opens()).toHaveLength(0);
});

it("applies environment settings without stopping or navigating an active session", async () => {
  fake.invoke.mockImplementation(async command => command === "browser_input" ? {pending:2} : status);
  await mount(); input("browser-env-locale", " en-us "); input("browser-env-timezone", "Europe/Moscow");
  await act(async () => button("Сохранить профиль").click());
  expect(fake.invoke).toHaveBeenCalledWith("browser_input", {action:"preferences", args:{environment:expect.objectContaining({locale:"en-US",timezone:"Europe/Moscow"})}});
  expect(fake.setBrowserSettings).toHaveBeenCalledWith({environment:expect.objectContaining({locale:"en-US",timezone:"Europe/Moscow"})});
  expect(fake.invoke.mock.calls.some(([c]) => ["browser_stop","browser_open"].includes(c))).toBe(false);
  expect(document.body.textContent).toContain("2");
});
it("keeps failed environment changes unsaved and rejects invalid locales before a native call", async () => {
  await mount(); input("browser-env-locale", "not a locale");
  await act(async () => button("Сохранить профиль").click());
  expect(fake.setBrowserSettings).not.toHaveBeenCalled();
  expect(fake.invoke.mock.calls.some(([c]) => c === "browser_input")).toBe(false);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("язык");
  input("browser-env-locale", "ru-RU");
  fake.invoke.mockRejectedValueOnce(new Error("Settings transport unavailable"));
  await act(async () => button("Сохранить профиль").click());
  expect(fake.setBrowserSettings).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Settings transport unavailable");
});
it("saves environment offline without starting the browser and disables remote editing", async () => {
  status.running = false;
  await mount(); input("browser-env-timezone", "Europe/Moscow");
  await act(async () => button("Сохранить профиль").click());
  expect(fake.setBrowserSettings).toHaveBeenCalledOnce();
  expect(fake.invoke.mock.calls.some(([c]) => c !== "browser_status")).toBe(false);
  fake.host = {};
  await mount();
  expect((document.getElementById("browser-env-locale") as HTMLInputElement).disabled).toBe(true);
  expect(button("Сбросить профиль").disabled).toBe(true);
});
