// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ setUi: vi.fn(), newSession: vi.fn() }));
vi.mock("../src/state/store", () => ({ useAppState: () => ({ ui: { paletteOpen: true }, prefs: { layout: {} }, sessions: [] }), store: { ...fake, projectDirectories: () => [] } }));
vi.mock("../src/components/Sidebar", () => ({ pickFolder: vi.fn() }));
import { Palette } from "../src/components/Palette";
it("keeps keyboard focus in search, reaches the last action with Up and restores the opener", () => {
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
 const opener = document.createElement("button"), node = document.createElement("div"); document.body.append(opener, node); opener.focus();
 const root = createRoot(node);
 try {
  act(() => root.render(createElement(Palette)));
  const input = document.querySelector("input")!, rows = [...document.querySelectorAll<HTMLButtonElement>(".palette-row")];
  expect(document.activeElement).toBe(input);
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowUp", bubbles:true})));
  expect(document.activeElement).toBe(rows[rows.length-1]);
  act(() => rows[rows.length-1].dispatchEvent(new KeyboardEvent("keydown", {key:"Tab", bubbles:true})));
  expect(document.activeElement).toBe(input);
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", {key:"Tab", shiftKey:true, bubbles:true})));
  expect(document.activeElement).toBe(rows[rows.length-1]);
  act(() => rows[rows.length-1].dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true})));
  expect(fake.setUi).toHaveBeenCalledWith({paletteOpen:false}); expect(fake.newSession).not.toHaveBeenCalled();
 } finally { act(() => root.unmount()); }
 expect(document.activeElement).toBe(opener);
 document.body.innerHTML=""; vi.unstubAllGlobals();
});
