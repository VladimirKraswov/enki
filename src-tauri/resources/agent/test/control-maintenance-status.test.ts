// Native lost-ACK reconciliation asks for the exact receipt of an earlier
// begin/end id with a read-only `status`; begin is never re-sent.
import { expect, it } from "vitest";
import { parseSupervisorMessage } from "../src/control/channel.ts";

const generation = "g".repeat(43);
const id = "11111111-1111-4111-8111-111111111111", target = "22222222-2222-4222-9222-222222222222";
const line = (value: Record<string, unknown>) => JSON.stringify({ type: "maintenance", generation, requestId: id, ...value });

it("parses an exact status query for another request id", () => {
  expect(parseSupervisorMessage(line({ mode: "status", target }))).toEqual({ type: "maintenance", generation, requestId: id, mode: "status", target });
});

it("refuses status without an exact distinct target, and unknown modes", () => {
  expect(parseSupervisorMessage(line({ mode: "status" }))).toBeNull();
  expect(parseSupervisorMessage(line({ mode: "status", target: id }))).toBeNull();
  expect(parseSupervisorMessage(line({ mode: "status", target: "not-a-uuid" }))).toBeNull();
  expect(parseSupervisorMessage(line({ mode: "replay", target }))).toBeNull();
});

it("begin and end are unchanged", () => {
  expect(parseSupervisorMessage(line({ mode: "begin" }))).toEqual({ type: "maintenance", generation, requestId: id, mode: "begin" });
  expect(parseSupervisorMessage(line({ mode: "end" }))).toEqual({ type: "maintenance", generation, requestId: id, mode: "end" });
});
