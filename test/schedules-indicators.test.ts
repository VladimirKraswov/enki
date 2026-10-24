// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { activeTimers, directoryTimers } from "../src/schedules/indicators";
import { TimerBadge } from "../src/components/TimerBadge";
import type { ScheduledTask } from "../src/schedules/tasks";

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: "t1", server: "http://127.0.0.1:4096", directory: "/work/a", sessionID: "s1", engine: "opencode",
  title: "Проверка", prompt: "p", minutes: 15, mode: "repeat",
  model: { providerID: "p", modelID: "m" }, enabled: true, nextAt: Date.now() + 60_000,
  state: "ready", ...over,
});

afterEach(() => { document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it("marks a chat by session id even when the stored server or directory drifted", () => {
  const tasks = [
    task(),
    task({ id: "t2", sessionID: "s2" }),
    task({ id: "t3", enabled: false }),
    task({ id: "t4", server: "other-host", directory: "/elsewhere" }),
  ];
  expect(activeTimers(tasks, "s1").map(t => t.id)).toEqual(["t1", "t4"]);
  expect(activeTimers(tasks, "s2").map(t => t.id)).toEqual(["t2"]);
  expect(activeTimers(tasks, "missing")).toEqual([]);
});

it("lists enabled timers of a project for the collapsed hint", () => {
  const tasks = [task(), task({ id: "t2", directory: "/work/b" }), task({ id: "t3", enabled: false })];
  expect(directoryTimers(tasks, "/work/a").map(t => t.id)).toEqual(["t1"]);
  expect(directoryTimers(tasks, "/work/b").map(t => t.id)).toEqual(["t2"]);
  expect(directoryTimers(tasks, "/work/c")).toEqual([]);
});

it("renders a clock badge with the next-run tooltip and nothing without timers", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  act(() => root.render(createElement(TimerBadge, { tasks: [], label: "Запланировано пробуждение" })));
  expect(node.querySelector(".session-timer")).toBeNull();
  act(() => root.render(createElement(TimerBadge, { tasks: [task({ nextAt: Date.now() + 3_600_000 })], label: "Запланировано пробуждение" })));
  const badge = node.querySelector(".session-timer")!;
  expect(badge.getAttribute("role")).toBe("status");
  expect(badge.getAttribute("aria-label")).toBe("Запланировано пробуждение");
  expect(badge.getAttribute("title")).toContain("Проверка");
  act(() => root.unmount());
});
