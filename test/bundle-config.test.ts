// Guards the split between the platform-neutral Tauri config and the three
// reviewed platform variants. Tauri 2 merges `tauri.<platform>.conf.json` into
// `tauri.conf.json`; object keys are merged, but arrays are *replaced*, which is
// exactly where a silent drift (or a macOS-only key reaching Linux) would hide.

import { readFileSync, existsSync } from "node:fs";
import { expect, it } from "vitest";

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../src-tauri/${name}`, import.meta.url), "utf8"));

const base = read("tauri.conf.json");
const macos = read("tauri.macos.conf.json");
const linux = read("tauri.linux.conf.json");
const windows = read("tauri.windows.conf.json");
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const cargo = readFileSync(
  new URL("../src-tauri/Cargo.toml", import.meta.url),
  "utf8",
);

/** macOS-only keys, allowed in the macOS overlay and nowhere else. */
const MAC_ONLY_WINDOW_KEYS = ["titleBarStyle", "hiddenTitle"];

it("keeps macOS window chrome and entitlements out of the shared config", () => {
  const window = base.app.windows[0];
  for (const key of MAC_ONLY_WINDOW_KEYS) expect(window[key]).toBeUndefined();
  expect(base.bundle.macOS).toBeUndefined();
  // The Linux overlay must not reintroduce either of them.
  expect(linux.app).toBeUndefined();
  expect(linux.bundle.macOS).toBeUndefined();
  expect(windows.app).toBeUndefined();
  expect(windows.bundle.macOS).toBeUndefined();
});

it("preserves the Hardened Runtime microphone entitlement on the macOS variant", () => {
  expect(macos.bundle.macOS.entitlements).toBe("Entitlements.plist");
  expect(
    existsSync(new URL("../src-tauri/Entitlements.plist", import.meta.url)),
  ).toBe(true);
  const entitlements = readFileSync(
    new URL("../src-tauri/Entitlements.plist", import.meta.url),
    "utf8",
  );
  expect(entitlements).toContain("com.apple.security.device.audio-input");
});

it("re-declares the whole window object in the macOS overlay, since arrays are replaced", () => {
  // Without this, moving a shared window field would silently drop it on macOS.
  const shared = base.app.windows[0];
  const mac = macos.app.windows[0];
  for (const [key, value] of Object.entries(shared))
    expect(mac[key], `macOS overlay lost ${key}`).toEqual(value);
  expect(Object.keys(mac).sort()).toEqual(
    [...Object.keys(shared), ...MAC_ONLY_WINDOW_KEYS].sort(),
  );
});

it("gives each reviewed variant exactly one bundle target set", () => {
  expect(linux.bundle.targets).toEqual(["deb"]);
  expect(macos.bundle.targets).toEqual(["app", "dmg"]);
  expect(windows.bundle.targets).toEqual(["nsis"]);
});

it("ships the reviewed Windows variant as a per-user NSIS installer", () => {
  expect(windows.bundle.windows.nsis.installMode).toBe("currentUser");
  expect(pkg.scripts["build:windows"]).toBe(
    "npm run runtime:prepare -- --platform win32-x64 && tauri build --bundles nsis --config src-tauri/tauri.runtime.conf.json",
  );
});

it("bundles the prepared agent runtime only through the runtime overlay", () => {
  // The shared config stays buildable for `cargo test`; release builds add the
  // verified artifact staged under target/ (outside the native fingerprint).
  expect(base.bundle.resources).toBeUndefined();
  const overlay = read("tauri.runtime.conf.json");
  expect(overlay.bundle.resources).toEqual({ "target/enki-agent/current/": "agent-runtime/" });
  for (const name of ["build:linux", "build:windows", "build:macos", "build:release:macos"]) {
    expect(pkg.scripts[name]).toContain("runtime:prepare");
    expect(pkg.scripts[name]).toContain("--config src-tauri/tauri.runtime.conf.json");
  }
});

it("describes the product truthfully: one bundled runtime, no external engine", () => {
  expect(base.bundle.shortDescription).not.toMatch(/OpenCode/);
  expect(base.bundle.longDescription).not.toMatch(/independently installed/);
});

it("keeps one product version across package, Cargo and Tauri", () => {
  expect(base.version).toBe(pkg.version);
  expect(cargo).toContain(`version = "${pkg.version}"`);
});
