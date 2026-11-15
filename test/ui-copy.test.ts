// Guards against macOS-only wording reaching the Linux (and later Windows) build.
//
// The app shipped as a Mac-only product for 0.2.x, so a lot of user-visible copy
// said "на этом Mac" / "настройкам macOS". On Linux that text is simply wrong and
// sends the user looking for System Settings panes that do not exist.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { captureErrorMessage, micUnavailableMessage } from "../src/voice/captureError";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * Files allowed to name macOS, because they describe a genuinely macOS-only
 * surface and already gate themselves on the detected platform.
 */
const ALLOWED = new Set([
  "components/ComputerSettings.tsx", // Cua Driver: macOS-only integration
  "components/PermissionCenter.tsx", // gated by platform(): macOS TCC center
  "permissions/status.ts", // its macOS-only rows and Settings anchors
  "state/computer.ts", // its readiness message
  "voice/captureError.ts", // per-platform permission hints
  "native/platform.ts", // the detector itself
  "components/TerminalPanel.tsx", // a code comment about /tmp symlinks
  "state/prefs.ts", // a code comment
]);

function sources(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) out.push(...sources(full, rel));
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

it("names no operating system in copy shared by every platform", () => {
  const offenders: string[] = [];
  for (const rel of sources(SRC)) {
    if (ALLOWED.has(rel)) continue;
    const text = readFileSync(join(SRC, rel), "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      // A line may name an OS when it explicitly scopes the claim to it, e.g.
      // the settings entry for the macOS-only computer-control integration.
      if (/Только macOS|только на macOS/.test(line)) continue;
      if (/\bmacOS\b|\bMac\b|\bWindows\b|⌘/.test(line))
        offenders.push(`${rel}:${index + 1}: ${line.trim().slice(0, 90)}`);
    }
  }
  expect(offenders, offenders.join("\n")).toEqual([]);
});

it("keeps the platform-specific microphone hints truthful", () => {
  expect(micUnavailableMessage("linux")).toContain("xdg-desktop-portal");
  expect(micUnavailableMessage("linux")).not.toContain("macOS");
  expect(micUnavailableMessage("macos")).toContain("системных настройках");
  expect(micUnavailableMessage("windows")).toContain("Windows");
  // The generic capture failure must not send a Linux user to macOS sound prefs.
  expect(captureErrorMessage(new Error("x"), "linux")).not.toContain("macOS");
});
