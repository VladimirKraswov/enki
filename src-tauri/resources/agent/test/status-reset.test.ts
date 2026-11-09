import { expect, it } from "vitest";
import { staleRunningStatuses } from "../src/sessions/status-reset.ts";

const row = (session: string, type: unknown) => ({ session_id: session, payload: JSON.stringify({ type: "session.status", properties: { sessionID: session, status: { type } } }) });

it("resets only last statuses that claim running work", () => {
  expect(staleRunningStatuses([
    row("a", "busy"), row("b", "idle"), row("c", "waiting"), row("d", "retry"),
  ])).toEqual(["a", "c", "d"]);
  expect(staleRunningStatuses([])).toEqual([]);
});

it("ignores malformed events instead of inventing a running state", () => {
  expect(staleRunningStatuses([
    { session_id: "broken", payload: "{not json" },
    { session_id: "empty", payload: JSON.stringify({ type: "session.status", properties: {} }) },
    { session_id: "ok", payload: JSON.stringify({ type: "session.status", properties: { status: { type: "busy" } } }) },
  ])).toEqual(["ok"]);
});
