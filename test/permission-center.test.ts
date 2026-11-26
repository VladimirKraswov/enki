import { describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
import {
  openPermissionSettings,
  permissionRows,
  permissionSettingsUrl,
  shouldOpenPermissionCenter,
  PERMISSION_VERSION_KEY,
  type SystemPermissionStatus,
} from "../src/permissions/status";

const base: SystemPermissionStatus = {
  platform: "macos",
  version: "2.0.83",
  screen_recording: true,
  accessibility: true,
  microphone: null,
  full_disk_access: null,
};

describe("macOS permission center", () => {
  it("opens after an update only when a real grant is missing", () => {
    expect(shouldOpenPermissionCenter(base)).toBe(false);
    expect(shouldOpenPermissionCenter({ ...base, screen_recording: false })).toBe(true);
    expect(shouldOpenPermissionCenter({ ...base, accessibility: false })).toBe(true);
  });

  it("does not treat an unknown preflight as granted or missing", () => {
    const rows = permissionRows({ ...base, screen_recording: null });
    const screen = rows.find((row) => row.key === "screen");
    expect(screen?.state).toBe("unknown");
    expect(screen?.canRequest).toBe(false);
  });

  it("marks microphone only after an explicit probe", () => {
    expect(
      permissionRows(base, "unknown").find((row) => row.key === "microphone")?.state,
    ).toBe("unknown");
    expect(
      permissionRows(base, "denied").find((row) => row.key === "microphone")?.state,
    ).toBe("missing");
    expect(
      permissionRows(base, "granted").find((row) => row.key === "microphone")?.state,
    ).toBe("granted");
  });

  it("keeps manual macOS grants manual instead of pretending to request them", () => {
    const rows = permissionRows(base, "granted");
    const disk = rows.find((row) => row.key === "fullDisk");
    const files = rows.find((row) => row.key === "files");
    expect(disk?.state).toBe("manual");
    expect(files?.state).toBe("manual");
    expect(disk?.canRequest).toBe(false);
    expect(files?.canRequest).toBe(false);
  });

  it("links to the exact privacy pane rather than a generic settings page", () => {
    expect(permissionSettingsUrl("screen")).toContain("Privacy_ScreenCapture");
    expect(permissionSettingsUrl("accessibility")).toContain("Privacy_Accessibility");
    expect(permissionSettingsUrl("microphone")).toContain("Privacy_Microphone");
    expect(permissionSettingsUrl("fullDisk")).toContain("Privacy_AllFiles");
    expect(permissionSettingsUrl("files")).toContain("Privacy_FilesAndFolders");
    expect(PERMISSION_VERSION_KEY).toBe("enki.permissions.checked-version");
  });

  it("opens the macOS privacy pane through the native command, not the URL opener", async () => {
    await openPermissionSettings("accessibility");
    expect(native.invoke).toHaveBeenCalledWith("system_permissions_open_settings", {
      url: permissionSettingsUrl("accessibility"),
    });
  });
});
