// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/state/store", () => ({ store: {}, useAppState: () => ({}), useAppSelector: () => ({}) }));
import { ToolPartView } from "../src/components/render";
import type { MessagePart } from "../src/api/types";

let root: Root | undefined;
function show(overrides: Partial<MessagePart["state"]> = {}, evidence: "active" | "unconfirmed" | "inactive" = "active") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (!root) { const div = document.createElement("div"); document.body.append(div); root = createRoot(div); }
  const part: MessagePart = { id: "t", sessionID: "s", messageID: "m", type: "tool", tool: "bash", state: {
    status: "running", input: { timeout: 660 }, time: { start: 1000, output: 31000 }, ...overrides,
  } };
  act(() => root!.render(createElement(ToolPartView, { part, evidence })));
}
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.innerHTML = ""; vi.useRealTimers(); vi.unstubAllGlobals(); });

it("shows elapsed time and actual output silence without pretending the model is working", () => {
  vi.useFakeTimers(); vi.setSystemTime(91000); show();
  expect(document.querySelector(".tool-activity")?.textContent).toContain("1 мин 30 с");
  expect(document.querySelector(".tool-silence")?.textContent).toContain("без вывода 1 мин 0 с");
  expect(document.querySelector(".tool-activity")?.getAttribute("title")).toContain("Лимит команды: 11 мин 0 с");
  act(() => vi.advanceTimersByTime(2000)); expect(document.querySelector(".tool-activity")?.textContent).toContain("1 мин 32 с");
  // A real new output event resets silence; merely ticking the timer never does.
  show({ time: { start: 1000, output: 93000 } }); expect(document.querySelector(".tool-silence")).toBeNull();
  show({ time: { start: 1000 }, output: "Earlier runtime output without a timestamp" });
  expect(document.querySelector(".tool-silence")).toBeNull();
});

it("does not animate a clock as live progress when disconnected, inactive or finished", () => {
  vi.useFakeTimers(); vi.setSystemTime(91000); show({}, "unconfirmed");
  expect(document.querySelector(".tool-activity")).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  show(); expect(vi.getTimerCount()).toBe(1);
  show({ status: "completed", time: { start: 1000, end: 61000 } });
  expect(document.querySelector(".tool-activity")).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  expect(document.querySelector(".tool-duration")?.textContent).toBe("60.0 с");
});
