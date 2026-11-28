// A held maintenance fence refuses every action with "готовится к обновлению".
// If the update is postponed or the app dies before "end", the fence must expire
// on its own instead of bricking the runtime until the next manual restart.
import { expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DaemonMaintenance, MAINTENANCE_TTL_MS } from "../src/daemon-maintenance.ts";
import { acquireStartLease } from "../src/daemon-control.ts";

const identity = { instance: "i".repeat(36), dataHash: "d".repeat(64) } as never;

function runtimeFake() {
  const state = { fenced: false };
  return {
    state,
    beginMaintenance: async () => { state.fenced = true; },
    endMaintenance: () => { state.fenced = false; },
    backupForUpdate: async () => ({ id: "backup" }) as never,
  };
}

it("releases a fence restored after a restart once its lease expires", () => {
  vi.useFakeTimers();
  try {
    const data = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "enki-maint-")));
    const runtime = runtimeFake();
    const lease = acquireStartLease(data);
    const maintenance = new DaemonMaintenance(data, identity, runtime as never, lease.nonce);
    expect(maintenance.snapshot()).toBeTruthy();
    vi.advanceTimersByTime(MAINTENANCE_TTL_MS + 5_000);
    expect(maintenance.snapshot()).toBeUndefined();
    expect(runtime.state.fenced).toBe(false);
    lease.release();
  } finally { vi.useRealTimers(); }
});

it("an expired fence is not reported as held by the next snapshot", () => {
  vi.useFakeTimers();
  try {
    const data = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "enki-maint-")));
    const runtime = runtimeFake();
    const lease = acquireStartLease(data);
    const maintenance = new DaemonMaintenance(data, identity, runtime as never, lease.nonce);
    const marker = JSON.parse(fs.readFileSync(path.join(data, "daemon-maintenance.json"), "utf8"));
    expect(marker.op).toBe("maintenance");
    vi.advanceTimersByTime(MAINTENANCE_TTL_MS + 1_000);
    const after = JSON.parse(fs.readFileSync(path.join(data, "daemon-maintenance.json"), "utf8"));
    expect(after.expired).toBe(true);
    lease.release();
  } finally { vi.useRealTimers(); }
});
