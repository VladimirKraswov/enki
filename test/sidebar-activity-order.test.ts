import { afterEach, expect, it, vi } from "vitest";
import type { Session } from "../src/api/types";
import { sortSessionsByActivity } from "../src/state/sidebar";
import { emptyChatRoot, reduceEvent } from "../src/state/chatReducer";
import type { ServerEvent } from "../src/api/types";

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

const evt = (type: string, id: string, properties: Record<string, unknown>) => ({ id, type, properties }) as unknown as ServerEvent;

afterEach(() => vi.useRealTimers());

it("stream deltas and model-transition status flapping never change the sidebar order timestamp", () => {
  vi.useFakeTimers();
  const root = emptyChatRoot(), sid = "s-order";
  vi.setSystemTime(1_000);
  reduceEvent(root, evt("message.updated", "e-user", { sessionID: sid, info: { id: "m-user", sessionID: sid, role: "user", time: { created: 1_000 } } }));
  expect(root.sessions[sid].orderAt).toBe(1_000);
  vi.setSystemTime(2_000);
  reduceEvent(root, evt("session.status", "e-busy", { sessionID: sid, status: { type: "busy" } }));
  expect(root.sessions[sid].orderAt).toBe(2_000);
  vi.setSystemTime(3_000);
  for (let i = 0; i < 50; i++)
    reduceEvent(root, evt("message.part.delta", `e-delta-${i}`, { sessionID: sid, messageID: "m-assistant", partID: "p-text", field: "text", delta: "x", partType: "text" }));
  reduceEvent(root, evt("session.status", "e-wait", { sessionID: sid, status: { type: "waiting", message: "Сжатие" } }));
  reduceEvent(root, evt("session.status", "e-busy-2", { sessionID: sid, status: { type: "busy" } }));
  expect(root.sessions[sid].lastEventAt).toBe(3_000);
  expect(root.sessions[sid].orderAt).toBe(2_000);
  vi.setSystemTime(4_000);
  reduceEvent(root, evt("session.idle", "e-idle", { sessionID: sid, status: { type: "idle" } }));
  expect(root.sessions[sid].orderAt).toBe(4_000);
});
