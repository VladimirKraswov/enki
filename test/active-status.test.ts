import { expect, it } from "vitest";
import { activeStatusIds } from "../src/state/sidebar";

it("re-checks only sessions that still claim work in the given directory", () => {
  const statuses = { busy: { type: "busy" }, wait: { type: "waiting" }, retry: { type: "retry" }, idle: { type: "idle" }, other: { type: "busy" } };
  const dirs: Record<string, string> = { busy: "/p", wait: "/p", retry: "/p", idle: "/p", other: "/q" };
  expect(activeStatusIds(statuses, id => dirs[id], "/p").sort()).toEqual(["busy", "retry", "wait"]);
  expect(activeStatusIds(statuses, id => dirs[id], "/q")).toEqual(["other"]);
  expect(activeStatusIds({}, () => undefined, "/p")).toEqual([]);
});
