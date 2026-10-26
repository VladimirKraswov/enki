// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ReadyUpdateBadge } from "../src/updates/ReadyUpdateBadge";
import type { Release } from "../src/updates/controller";
let root: Root | undefined;
function show(release: Release | null, prepared = false, downloaded = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (!root) { const div = document.createElement("div"); document.body.append(div); root = createRoot(div); }
  const open = vi.fn();
  act(() => root!.render(createElement(ReadyUpdateBadge, { release, prepared, downloaded, onOpen: open })));
  return open;
}
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it("stays quiet while a native package is unknown, building or unavailable", () => {
  for (const binary of [undefined, { state: "pending" as const }, { state: "unavailable" as const }]) {
    show({ available: true, version: "2.0.9", kind: "source", binary });
    expect(document.querySelector("button")).toBeNull();
  }
  show(null); expect(document.querySelector("button")).toBeNull();
});

it("appears when the current platform package becomes ready, and only opens settings", () => {
  const release: Release = { available: true, version: "2.0.9", kind: "source", binary: { state: "pending" } };
  show(release); expect(document.querySelector("button")).toBeNull();
  const open = show({ ...release, binary: { state: "ready" } });
  const button = document.querySelector("button")!;
  expect(button.title).toBe("Готовое обновление доступно для загрузки · 2.0.9");
  act(() => button.click()); expect(open).toHaveBeenCalledTimes(1);
});

it("also offers a verified local build or a compatible interface update", () => {
  show({ available: true, version: "2.0.9", kind: "source", binary: { state: "pending" } }, true);
  expect(document.querySelector("button")?.title).toContain("Готово к установке");
  show({ available: true, version: "2.0.9", kind: "hot" });
  expect(document.querySelector("button")?.title).toContain("Готовое обновление интерфейса");
  show({ available: true, version: "2.0.9", kind: "hot" }, false, true);
  expect(document.querySelector("button")?.title).toContain("Готово к установке");
  show({ available: false, version: "2.0.9", kind: "hot" }, true, true);
  expect(document.querySelector("button")).toBeNull();
});
