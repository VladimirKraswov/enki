// @vitest-environment jsdom
// SSH host dialog of the sole bundled runtime. The external engine's server
// setup (port, `opencode serve`, API password) is gone: the native side runs
// the installed remote runtime's `ensure` over strict known-host SSH and
// tunnels its own loopback port. The saved host port is only workspace
// identity (`ssh:<target>:<port>` keys drafts/queues/timers) and is preserved.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const fake = vi.hoisted(() => ({ state: {} as any, current: undefined as any, saveRemoteHost: vi.fn(), connectHost: vi.fn(), setUi: vi.fn() }));
vi.mock("../src/state/store", () => ({
  useAppState: () => fake.state, errText: (e: unknown) => String(e),
  store: { currentHost: () => fake.current, saveRemoteHost: fake.saveRemoteHost, connectHost: fake.connectHost, setUi: fake.setUi,
    hostLabel: () => "Этот компьютер", removeRemoteHost: vi.fn(), get state() { return fake.state; } },
}));
vi.mock("../src/native/hosts", async original => ({ ...await original<object>(), sshAliases: async () => ["vm-v100"] }));
import { HostDialogs } from "../src/components/HostDialogs";

let root: Root;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fake.current = undefined;
  fake.state = { ui: { hostDialogOpen: true, remoteFolderOpen: false }, prefs: { activeHost: undefined, remoteHosts: [] }, connection: { error: null } };
  fake.connectHost.mockResolvedValue(true);
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
const mount = () => act(async () => root.render(createElement(HostDialogs)));
function type(label: string, value: string) {
  const input = [...document.querySelectorAll("label")].find(l => l.textContent?.startsWith(label))!.querySelector("input")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
const submit = () => act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });

it("offers no removed-engine port or password controls and explains the bundled remote runtime", async () => {
  await mount();
  expect(document.body.textContent).not.toMatch(/OpenCode|opencode serve/);
  expect(document.querySelector('input[type="number"]')).toBeNull();
  expect(document.querySelector('input[type="password"]')).toBeNull();
  expect(document.body.textContent).toContain("runtime-dist/current");
  // The real public entry that checks host Node BEFORE loading the installer.
  expect(document.body.textContent).toContain("scripts/runtime/install-remote-entry.mjs");
  expect(document.body.textContent).toContain("known_hosts");
  expect(document.body.textContent).toContain("не переключится на этот компьютер");
});

it("a new host gets the stable identity port and connects only through the native SSH runtime", async () => {
  await mount();
  type("SSH-алиас", "user@box");
  await submit();
  expect(fake.saveRemoteHost).toHaveBeenCalledExactlyOnceWith({ id: "ssh:user@box:4096", name: "user@box", target: "user@box", port: 4096 });
  expect(fake.connectHost).toHaveBeenCalledExactlyOnceWith("ssh:user@box:4096");
  expect(fake.setUi).toHaveBeenCalledWith({ hostDialogOpen: false, remoteFolderOpen: false });
});

it("re-adding a saved target keeps its saved identity, so its chats, queues and timers stay attached", async () => {
  fake.state.prefs.remoteHosts = [{ id: "ssh:vm-v100:22", name: "GPU", target: "vm-v100", port: 22 }];
  await mount();
  type("SSH-алиас", "vm-v100"); type("Название", "GPU сервер");
  await submit();
  expect(fake.saveRemoteHost).toHaveBeenCalledExactlyOnceWith({ id: "ssh:vm-v100:22", name: "GPU сервер", target: "vm-v100", port: 22 });
  expect(fake.connectHost).toHaveBeenCalledWith("ssh:vm-v100:22");
});

it("a failed remote connection stays in the dialog with the runtime's reason (no local fallback)", async () => {
  fake.connectHost.mockResolvedValue(false);
  fake.state.connection.error = "На удалённой машине не найдена среда выполнения Enki.";
  await mount();
  type("SSH-алиас", "user@box");
  await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("не найдена среда выполнения");
  expect(fake.setUi).not.toHaveBeenCalledWith({ hostDialogOpen: false, remoteFolderOpen: false });
});
