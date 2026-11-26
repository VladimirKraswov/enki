// Updates replace the app bundle and its bundled runtime artifact, so anything
// the owner enabled must be proven again after a version change: the MCP bridge
// scripts belong to the new build, and the reserved entry has to keep pointing at
// it. The owner's decision (enabled / full access) is never invented here — it is
// remembered and re-applied; only the system-level grants stay a user action.
import { version } from "../../package.json";

export interface ComputerRestoreDeps {
  native: boolean;
  local: boolean;
  accessMode: () => string;
  /** The owner explicitly enabled computer control at least once. */
  ownedByOwner: () => boolean;
  checkedVersion: () => string | undefined;
  markChecked: (version: string) => void;
  status: () => Promise<{ supported?: boolean; installed?: boolean; enabled?: boolean }>;
  setPolicy: (fullAccess: boolean) => Promise<unknown>;
  repairBridge: () => Promise<unknown>;
  enableEntry: () => Promise<unknown>;
  refreshCapabilities: () => Promise<unknown>;
  /** Report a condition only the owner can resolve (missing driver/permission). */
  report: (message: string) => void;
  log?: (message: string) => void;
}

export interface ComputerRestoreResult {
  action: "skipped" | "repaired" | "needs-owner";
  reason?: "not-native" | "not-local" | "already-checked" | "not-installed" | "not-supported" | "not-owned";
}

/**
 * Idempotent, once per installed version. Returns honestly what it could and
 * could not restore; never enables computer control on its own initiative.
 */
export async function restoreComputerAfterUpdate(deps: ComputerRestoreDeps): Promise<ComputerRestoreResult> {
  if (!deps.native) return { action: "skipped", reason: "not-native" };
  if (!deps.local) return { action: "skipped", reason: "not-local" };
  if (deps.checkedVersion() === version) return { action: "skipped", reason: "already-checked" };
  const status = await deps.status();
  if (!status.supported) { deps.markChecked(version); return { action: "skipped", reason: "not-supported" }; }
  if (!status.installed) {
    // The preconditions are gone: tell the owner once, keep the marker so a later
    // reinstall restores everything without asking again.
    deps.report("Cua Driver не установлен. Управление компьютером останется выключенным, пока драйвер не установлен.");
    deps.markChecked(version);
    return { action: "needs-owner", reason: "not-installed" };
  }
  if (!deps.ownedByOwner()) {
    // Installed but never enabled by the owner: never switch it on silently.
    deps.markChecked(version);
    return { action: "skipped", reason: "not-owned" };
  }
  await deps.setPolicy(deps.accessMode() === "full");
  try {
    await deps.repairBridge();
    await deps.enableEntry();
    await deps.refreshCapabilities();
  } catch (error) {
    deps.log?.(`computer restore: ${error instanceof Error ? error.message : String(error)}`);
    deps.report("Управление компьютером нужно подтвердить заново: откройте Настройки → Компьютер и включите переключатель.");
    return { action: "needs-owner" };
  }
  deps.markChecked(version);
  return { action: "repaired" };
}
