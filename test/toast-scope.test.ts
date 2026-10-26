// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ state: {} as any, setUi: vi.fn() }));
vi.mock("../src/state/store", () => ({ store: { setUi: f.setUi }, useAppState: () => f.state }));
import { Toast } from "../src/components/Dialogs";
let root: Root | undefined;
function show(patch: object = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (!root) {
    f.setUi.mockClear(); f.state = { prefs: { endpoint: "local" }, directory: "/a", activeSessionId: "s", ui: { toast: "Уточнение сохранено." } };
    const div = document.createElement("div"); document.body.append(div); root = createRoot(div);
  }
  f.state = { ...f.state, ...patch }; act(() => root!.render(createElement(Toast)));
}
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); });
it("does not carry an old chat receipt into settings or another chat", () => {
  show(); expect(f.setUi).not.toHaveBeenCalled();
  show({ ui: { ...f.state.ui, settingsOpen: true } }); expect(f.setUi).toHaveBeenCalledWith({ toast: null });
});
it("keeps a new navigation message and exposes an accessible explicit dismissal", () => {
  show(); show({ directory: "/b", ui: { toast: "Не удалось открыть папку." } });
  expect(f.setUi).not.toHaveBeenCalled();
  const close = document.querySelector<HTMLButtonElement>('[aria-label="Закрыть уведомление"]')!;
  expect(close).not.toBeNull(); act(() => close.click()); expect(f.setUi).toHaveBeenCalledWith({ toast: null });
});
