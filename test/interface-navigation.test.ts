// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SelectMenu } from "../src/components/SelectMenu";
import { ChatWorkspace } from "../src/components/ChatWorkspace";

let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; vi.useRealTimers(); vi.unstubAllGlobals(); });
const key = (target: Element, value: string) => act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })));

it("opens a short picker from the keyboard on the requested edge and restores trigger focus", () => {
  const change = vi.fn();
  act(() => root.render(createElement(SelectMenu, { label: "Модель", value: "a", options: [{ value: "a", label: "Первая" }, { value: "x", label: "Недоступна", disabled: true }, { value: "b", label: "Последняя" }], onChange: change })));
  const trigger = document.querySelector<HTMLButtonElement>(".select-trigger")!;
  act(() => trigger.focus()); key(trigger, "ArrowUp");
  expect(document.activeElement?.textContent).toBe("Последняя");
  key(document.activeElement!, "ArrowDown"); expect(document.activeElement?.textContent).toBe("Первая");
  key(document.activeElement!, "Escape"); expect(document.querySelector(".select-popover")).toBeNull();
  expect(document.activeElement).toBe(trigger); expect(change).not.toHaveBeenCalled();
  key(trigger, "ArrowDown"); expect(document.activeElement?.textContent).toBe("Первая");
});

it("distinguishes a search miss from unavailable models and clears only the filter", () => {
  const refresh = vi.fn(), change = vi.fn();
  act(() => root.render(createElement(SelectMenu, { label: "Модель", value: "0", options: Array.from({ length: 9 }, (_, i) => ({ value: String(i), label: `Модель ${i}` })), onChange: change, onRefresh: refresh })));
  act(() => document.querySelector<HTMLButtonElement>(".select-trigger")!.click());
  const input = document.querySelector<HTMLInputElement>(".select-popover input")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "missing"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(document.querySelector('[role="status"]')?.textContent).toContain("Ничего не найдено");
  expect(document.querySelector(".select-popover")?.textContent).not.toContain("Доступных моделей пока нет");
  act(() => document.querySelector<HTMLButtonElement>(".select-empty button")!.click());
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(9);
  expect(document.activeElement).toBe(input); expect(refresh).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
});

it("keeps a live chat and its draft through panel animation and a rapidly reversed close", () => {
  vi.useFakeTimers(); const mounted = vi.fn(), stopped = vi.fn();
  function Chat() {
    const [draft, setDraft] = useState("");
    useEffect(() => { mounted(); return stopped; }, []);
    return createElement("textarea", { value: draft, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value) });
  }
  const render = (open: boolean) => act(() => root.render(createElement(ChatWorkspace, { open, panel: createElement("aside", {}, "Контекст"), children: createElement(Chat) })));
  render(false); const input = document.querySelector("textarea")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Мой черновик"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  render(true); expect(document.querySelector("aside")).not.toBeNull();
  render(false); expect(document.querySelector("aside")?.parentElement?.hasAttribute("inert")).toBe(true);
  act(() => vi.advanceTimersByTime(100)); render(true); act(() => vi.advanceTimersByTime(300));
  expect(document.querySelector("aside")).not.toBeNull(); render(false); act(() => vi.advanceTimersByTime(240));
  expect(document.querySelector("aside")).toBeNull(); expect(document.querySelector("textarea")).toBe(input);
  expect(input.value).toBe("Мой черновик"); expect(mounted).toHaveBeenCalledTimes(1); expect(stopped).not.toHaveBeenCalled();
});
