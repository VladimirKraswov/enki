import { expect, it } from "vitest";
import { sessionStatusConfirmed } from "../src/state/sidebar";

const base = { phase: "connected" as const, statusError: null };

it("keeps a running session confirmed when another chat is selected", () => {
  // Поток не в простое: выбор другой вкладки ничего не меняет.
  expect(sessionStatusConfirmed(base, "/other-project", "/current", false)).toBe(true);
  expect(sessionStatusConfirmed(base, "/current", "/current", false)).toBe(true);
});

it("only a lasting outage or a failed status check makes a task unconfirmed", () => {
  expect(sessionStatusConfirmed(base, "/p", "/current", true)).toBe(false);
  expect(sessionStatusConfirmed({ ...base, statusError: "нет доступа" }, "/current", "/current", false)).toBe(false);
  expect(sessionStatusConfirmed({ ...base, phase: "disconnected" }, "/p", "/current", false)).toBe(false);
});
