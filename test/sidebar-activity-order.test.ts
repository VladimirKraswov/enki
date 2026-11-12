import { expect, it } from "vitest";
import type { Session } from "../src/api/types";
import { sortSessionsByActivity } from "../src/state/sidebar";

function session(id: string, updated: number): Session {
  return { id, directory: "/project", title: id, time: { created: 1, updated } };
}

it("orders recent sessions by the latest live activity, not only stored update time", () => {
  const sessions = [session("ESP32", 400), session("VPN", 300), session("Mash", 200), session("Mac", 100)];
  const live = { ESP32: 400, Mac: 350, VPN: 300, Mash: 200 };
  expect(sortSessionsByActivity(sessions, id => live[id as keyof typeof live] ?? 0).map(s => s.id))
    .toEqual(["ESP32", "Mac", "VPN", "Mash"]);
});

it("keeps detached helper sessions in the same deterministic order", () => {
  const sessions = [session("b", 5), session("a", 5), session("new", 9)];
  expect(sortSessionsByActivity(sessions, () => 0).map(s => s.id)).toEqual(["new", "a", "b"]);
});
