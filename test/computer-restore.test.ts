// After every update the owner must keep the access he enabled. This routine is
// idempotent, runs once per version, and never switches control on by itself.
import { expect, it, vi } from "vitest";
import { restoreComputerAfterUpdate, type ComputerRestoreDeps } from "../src/computer/restore";
import { version } from "../package.json";

function deps(overrides: Partial<ComputerRestoreDeps> = {}): ComputerRestoreDeps & { reports: string[] } {
  const reports: string[] = [];
  return {
    reports,
    native: true, local: true,
    accessMode: () => "full",
    ownedByOwner: () => true,
    checkedVersion: () => undefined,
    markChecked: vi.fn(),
    status: async () => ({ supported: true, installed: true }),
    setPolicy: vi.fn(async () => ({})),
    repairBridge: vi.fn(async () => ({})),
    enableEntry: vi.fn(async () => ({})),
    refreshCapabilities: vi.fn(async () => ({})),
    report: (message) => reports.push(message),
    ...overrides,
  };
}

it("re-applies the owner's decision once per installed version", async () => {
  const d = deps();
  await expect(restoreComputerAfterUpdate(d)).resolves.toEqual({ action: "repaired" });
  expect(d.setPolicy).toHaveBeenCalledWith(true);
  expect(d.repairBridge).toHaveBeenCalledOnce();
  expect(d.enableEntry).toHaveBeenCalledOnce();
  expect(d.markChecked).toHaveBeenCalledWith(version);
});

it("does nothing twice for the same version", async () => {
  const d = deps({ checkedVersion: () => version });
  await expect(restoreComputerAfterUpdate(d)).resolves.toEqual({ action: "skipped", reason: "already-checked" });
  expect(d.repairBridge).not.toHaveBeenCalled();
});

it("never enables computer control the owner did not ask for", async () => {
  const d = deps({ ownedByOwner: () => false });
  await expect(restoreComputerAfterUpdate(d)).resolves.toEqual({ action: "skipped", reason: "not-owned" });
  expect(d.setPolicy).not.toHaveBeenCalled();
  expect(d.enableEntry).not.toHaveBeenCalled();
});

it("asks the owner when the driver disappeared and keeps the decision for later", async () => {
  const d = deps({ status: async () => ({ supported: true, installed: false }) });
  await expect(restoreComputerAfterUpdate(d)).resolves.toEqual({ action: "needs-owner", reason: "not-installed" });
  expect(d.reports.join(" ")).toMatch(/Cua Driver не установлен/);
  expect(d.markChecked).toHaveBeenCalledWith(version);
});

it("explains a failed repair instead of pretending success", async () => {
  const d = deps({ enableEntry: vi.fn(async () => { throw new Error("registry busy"); }) });
  await expect(restoreComputerAfterUpdate(d)).resolves.toEqual({ action: "needs-owner" });
  expect(d.reports.join(" ")).toMatch(/включите переключатель/i);
  expect(d.markChecked).not.toHaveBeenCalled();
});

it("narrow access mode restores a safe policy", async () => {
  const d = deps({ accessMode: () => "ask" });
  await restoreComputerAfterUpdate(d);
  expect(d.setPolicy).toHaveBeenCalledWith(false);
});
