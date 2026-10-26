import { expect, it } from "vitest";
import { sessionWorkMark } from "../src/state/sidebar";

it("shows pending user action instead of a busy SDK spinner, including background chats", () => {
  for (const status of ["busy", "retry", "waiting", "idle", undefined]) expect(sessionWorkMark(true, status, true)).toBe("waiting");
  expect(sessionWorkMark(false, "busy", true)).toBe("working");
  expect(sessionWorkMark(false, "waiting", true)).toBe("working"); // e.g. compaction, not a question for the user
});
it("keeps disconnected work unconfirmed and never invents pending interaction", () => {
  expect(sessionWorkMark(false, "busy", false)).toBe("unconfirmed");
  expect(sessionWorkMark(false, "idle", true)).toBe("none");
});
