// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PendingCorrections } from "../src/components/PendingCorrections";
import type { PendingCorrectionDTO } from "../src-tauri/resources/agent/src/protocol";

let root: Root | undefined;
const item: PendingCorrectionDTO = { id: "fix", text: "Бэкап системы в /NAS/1tb\nИгры я копирую сам", state: "running", createdAt: 1 };
function show(items: PendingCorrectionDTO[], connected = true) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (!root) { const div = document.createElement("div"); document.body.append(div); root = createRoot(div); }
  act(() => root!.render(createElement(PendingCorrections, { items, connected })));
}
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it("shows the saved text while the current tool runs, including after returning to the chat", () => {
  show([item]);
  expect(document.querySelector('[aria-label="Уточнения текущей задачи"]')?.textContent).toContain(item.text);
  expect(document.querySelector('[role="status"]')?.textContent).toBe("Ждёт следующего шага агента");
  expect(document.body.textContent).not.toContain("Доставлено");
  act(() => root!.unmount()); root = undefined; document.body.innerHTML = ""; show([item]);
  expect(document.body.textContent).toContain(item.text);
  show([]); expect(document.querySelector("section")).toBeNull();
});

it("distinguishes lost connection and uncertain delivery and never offers an automatic resend", () => {
  show([item], false); expect(document.body.textContent).toContain("Сохранено · нет связи с агентом");
  show([{ ...item, state: "uncertain", error: "Runtime перезапустилась" }]);
  expect(document.querySelector('[role="status"]')?.textContent).toBe("Доставка не подтверждена");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Runtime перезапустилась");
  expect(document.body.textContent).not.toContain("Отправить снова");
});

it("renders attachment names and user text safely without adding a new queued job", () => {
  show([{ ...item, text: "<img src=x onerror=alert(1)>", attachments: [{ name: "source.png" }] }]);
  expect(document.body.textContent).toContain("source.png"); expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector(".queued-prompt")).toBeNull();
});
