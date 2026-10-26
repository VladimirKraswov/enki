import { expect, it, vi } from "vitest";
import { ConnectionError, ApiError } from "../src/api/http";
import { reconcileOpenCodeImport } from "../src/agent/runtime/migration";
import type { MigrationsDTO } from "../src/agent/runtime/client";

const old: MigrationsDTO = { archives: [], journal: [{ id: "old", kind: "opencode", state: "committed", updatedAt: 1 }], sources: { opencode: "/owner/source.db", piCli: null } };
function snapshot(state: string): MigrationsDTO {
  return { ...old, journal: [...old.journal, { id: "new", kind: "opencode", state, detail: JSON.stringify({ archive: "exact-new-archive" }), updatedAt: 2 }],
    archives: state === "committed" ? [{ id: "exact-new-archive", kind: "opencode", source: "/owner/source.db", createdAt: 2, sha256: "x", counts: {}, importer: "v2", sessions: 3 }] : [] };
}
function port(...states: MigrationsDTO[]) {
  let index = 0;
  return { read: vi.fn(async () => states[Math.min(index++, states.length - 1)]), current: () => true, notify: vi.fn(), pause: vi.fn(async () => {}) };
}
it("follows the exact new job after a lost acknowledgement, without any mutation call", async () => {
  const p = port(snapshot("snapshotted"), snapshot("verified"), snapshot("committed"));
  await reconcileOpenCodeImport(new ConnectionError("timeout"), "/owner/source.db", old, p);
  expect(p.read).toHaveBeenCalledTimes(3); expect(p.notify.mock.calls).toEqual([["snapshotted"], ["verified"]]);
});
it("refuses a previous successful archive or missing acknowledgement evidence", async () => {
  const error = new ConnectionError("lost");
  await expect(reconcileOpenCodeImport(error, "/owner/source.db", old, port(old))).rejects.toBe(error);
  const wrong = snapshot("committed"); wrong.archives[0].id = "old-archive";
  await expect(reconcileOpenCodeImport(error, "/owner/source.db", old, port(wrong))).rejects.toBe(error);
});
it("never reconciles a validation or authorization rejection", async () => {
  const p = port(snapshot("committed")), error = new ApiError(403, "denied");
  await expect(reconcileOpenCodeImport(error, "/owner/source.db", old, p)).rejects.toBe(error);
  expect(p.read).not.toHaveBeenCalled();
});
it("stops after a failed job, a changed source or changed connection", async () => {
  await expect(reconcileOpenCodeImport(new ConnectionError("lost"), "/owner/source.db", old, port(snapshot("rolled_back")))).rejects.toThrow("остановлен");
  const wrong = snapshot("committed"); wrong.sources = { opencode: "/other/source.db", piCli: null };
  await expect(reconcileOpenCodeImport(new ConnectionError("lost"), "/owner/source.db", old, port(wrong))).rejects.toThrow("Источник");
  const p = { ...port(snapshot("committed")), current: () => false };
  await expect(reconcileOpenCodeImport(new ConnectionError("lost"), "/owner/source.db", old, p)).rejects.toThrow("Подключение");
  expect(p.read).not.toHaveBeenCalled();
});
it("bounds a job that never finishes", async () => {
  const p = port(snapshot("snapshotted"));
  await expect(reconcileOpenCodeImport(new ConnectionError("lost"), "/owner/source.db", old, p)).rejects.toThrow("ещё не подтверждена");
  expect(p.read).toHaveBeenCalledTimes(600); expect(p.notify).toHaveBeenCalledTimes(1);
});
it("retries bounded read-only transport failures but never authentication failures", async () => {
  const p = port(snapshot("committed"));
  p.read.mockRejectedValueOnce(new ConnectionError("temporary")).mockRejectedValueOnce(new ConnectionError("temporary"));
  await reconcileOpenCodeImport(new ConnectionError("lost"), "/owner/source.db", old, p);
  expect(p.read).toHaveBeenCalledTimes(3);
  const denied = port(snapshot("committed")); denied.read.mockRejectedValue(new ApiError(401, "denied"));
  await expect(reconcileOpenCodeImport(new ConnectionError("lost"), "/owner/source.db", old, denied)).rejects.toBeInstanceOf(ApiError);
  expect(denied.read).toHaveBeenCalledTimes(1);
  const disconnected = port(snapshot("committed")); disconnected.read.mockRejectedValue(new ConnectionError("offline"));
  await expect(reconcileOpenCodeImport(new ConnectionError("lost"), "/owner/source.db", old, disconnected)).rejects.toThrow("offline");
  expect(disconnected.read).toHaveBeenCalledTimes(3);
});
