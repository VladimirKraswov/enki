// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { SESSION_DROP_ATTRIBUTE, sessionDropTargetAt, startSessionDrag } from "../src/chat/sessionDrag";

const fakeElement = (value: string | null) => ({
  closest: () => (value === null ? null : { getAttribute: () => value }),
}) as unknown as Element;
afterEach(() => { delete document.body.dataset.sessionDragging; });

it("resolves a project directory, the projectless area and nothing else", () => {
  expect(sessionDropTargetAt(fakeElement("/Users/user/enki-projects/Compute Mesh"))).toEqual({ directory: "/Users/user/enki-projects/Compute Mesh" });
  expect(sessionDropTargetAt(fakeElement("recent"))).toEqual({ directory: null });
  expect(sessionDropTargetAt(fakeElement(""))).toEqual({ directory: null });
  expect(sessionDropTargetAt(fakeElement(null))).toBeNull();
  expect(sessionDropTargetAt(null)).toBeNull();
  expect(SESSION_DROP_ATTRIBUTE).toBe("data-session-drop");
});

it("turns a short press into a click, a longer gesture into a drag and drop", () => {
  const onHover = vi.fn(), onDrop = vi.fn();
  const cleanup = startSessionDrag(100, 100, { targetAt: () => fakeElement("/p/one"), onHover, onDrop });
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 103, clientY: 102 }));
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: 103, clientY: 102 }));
  expect(onHover).not.toHaveBeenCalled(); expect(onDrop).not.toHaveBeenCalled();
  expect(document.body.dataset.sessionDragging).toBeUndefined();
  cleanup();
});

it("moves a chat onto a project and back into the projectless area", () => {
  const hovered: Array<string | null | undefined> = [], drops: Array<string | null> = [];
  let target: Element = fakeElement("/p/one");
  const cleanup = startSessionDrag(10, 10, { targetAt: () => target, onHover: d => hovered.push(d), onDrop: d => drops.push(d) });
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 80, clientY: 40 }));
  expect(document.body.dataset.sessionDragging).toBe("true");
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: 80, clientY: 40 }));
  target = fakeElement("recent");
  const second = startSessionDrag(10, 10, { targetAt: () => target, onHover: vi.fn(), onDrop: d => drops.push(d) });
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 20, clientY: 90 }));
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: 20, clientY: 90 }));
  second();
  cleanup();
  expect(hovered.at(-1)).toBe("/p/one");
  expect(drops).toEqual(["/p/one", null]);
});

it("reports a hovered area while dragging and drops nothing over empty space", () => {
  const onHover = vi.fn(), onDrop = vi.fn();
  const cleanup = startSessionDrag(0, 0, { targetAt: () => fakeElement(null), onHover, onDrop });
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 30 }));
  expect(onHover).toHaveBeenLastCalledWith(null);
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: 30, clientY: 30 }));
  expect(onDrop).not.toHaveBeenCalled();
  expect(document.body.dataset.sessionDragging).toBeUndefined();
  cleanup();
});

it("cancel and cleanup leave no listeners or drag state behind", () => {
  const onHover = vi.fn(), onDrop = vi.fn();
  const cleanup = startSessionDrag(0, 0, { targetAt: () => fakeElement("/p"), onHover, onDrop });
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 40, clientY: 40 }));
  window.dispatchEvent(new MouseEvent("pointercancel"));
  expect(onHover).toHaveBeenLastCalledWith(undefined);
  expect(document.body.dataset.sessionDragging).toBeUndefined();
  cleanup(); cleanup();
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: 40, clientY: 40 }));
  expect(onDrop).not.toHaveBeenCalled();
});
