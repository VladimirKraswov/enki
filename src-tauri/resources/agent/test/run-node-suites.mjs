#!/usr/bin/env node
// Genuine gate for EVERY real-SDK / legacy `*.node.ts` suite (Vitest collects
// only test/**/*.test.ts). Pinned interpreter only; a private harness root with
// redirected HOME/USERPROFILE/XDG/Pi agent dir; the owned-listener network
// guard and then the production SDK-profile installer are imported before any
// suite; any guard refusal fails the gate; bounded deadline; no model,
// provider or owner data.
// Usage: npm --prefix src-tauri/resources/agent run test:node [-- <suite filter>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateProfile, releaseProfile } from "./setup/sdk-profile-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pinned = JSON.parse(fs.readFileSync(path.join(root, "runtime-lock.json"), "utf8")).node.version;
// Suites that must exist: a missing/renamed one fails the gate instead of silently shrinking it.
const REQUIRED = ["sdk-worker-ui.node.ts", "sdk-shell-fallback.node.ts", "runtime-lifecycle.node.ts", "config-vault.node.ts", "extension-boundary.node.ts", "legacy-qualified/pi-migration.node.ts",
  "legacy-qualified/continuation.node.ts", "legacy-qualified/continuation-import.node.ts", "legacy-qualified/import-hardening.node.ts",
  "legacy-qualified/import-regressions.node.ts", "legacy-qualified/reader-regressions.node.ts", "legacy-qualified/snapshot-crash.node.ts",
  "legacy-qualified/reader/v1-history.node.ts", "legacy-qualified/reader/v2-history.node.ts", "legacy-qualified/reader/corruption.node.ts",
  "legacy-qualified/reader/constructor-close.node.ts", "legacy-qualified/reader/pagination-validation.node.ts"];

function discover(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) discover(file, found); else if (entry.isFile() && entry.name.endsWith(".node.ts")) found.push(file);
  }
  return found;
}

async function main() {
  if (process.version !== `v${pinned}`) throw new Error(`Node suites require the pinned interpreter v${pinned}; found ${process.version}`);
  const tests = path.join(root, "test"), suites = discover(tests), relative = suites.map((file) => path.relative(tests, file).split(path.sep).join("/"));
  const missing = REQUIRED.filter((name) => !relative.includes(name));
  if (missing.length) throw new Error(`Required node suites missing: ${missing.join(", ")}`);
  const filter = process.argv[2], selected = filter ? suites.filter((_, index) => relative[index].includes(filter)) : suites;
  if (!selected.length) throw new Error(`No node suite matches ${filter}`);
  const harness = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "enki-sdk-harness-"));
  const sdk = path.join(harness, "sdk");
  try {
    const home = path.join(harness, "home"), tmp = path.join(harness, "tmp"), agent = path.join(harness, "pi-agent");
    for (const directory of [home, tmp, agent, sdk]) fs.mkdirSync(directory, { mode: 0o700 });
    // The same owned immutable profile fixture Vitest uses, installed by the
    // production installer in a preload before any suite imports the SDK.
    const profile = generateProfile(sdk);
    const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"),
      APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local"), TMPDIR: tmp, TMP: tmp, TEMP: tmp,
      PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", ENKI_SDK_HARNESS_ROOT: harness, ENKI_TEST_SDK_PROFILE: profile, NODE_ENV: "test" };
    for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) if (process.env[key] !== undefined) env[key] = process.env[key];
    const guard = pathToFileURL(path.join(tests, "node-guard.mjs")).href, sdkEnvironment = pathToFileURL(path.join(tests, "setup", "node-sdk-environment.mjs")).href;
    const code = await new Promise((resolve, reject) => {
      // store/db.ts uses parameter properties, which strip-only TS cannot load.
      const child = spawn(process.execPath, ["--experimental-transform-types", "--import", guard, "--import", sdkEnvironment, "--test", "--test-concurrency=1", ...selected], { cwd: root, env, stdio: "inherit", shell: false, windowsHide: true });
      const timer = setTimeout(() => { child.kill(); reject(new Error("Node suites exceeded 30 minutes")); }, 30 * 60_000);
      child.once("error", reject);
      child.once("exit", (status, signal) => { clearTimeout(timer); resolve(status ?? (signal ? 1 : 0)); });
    });
    // Every refused connection/lookup is a gate failure, even when the suite's
    // own assertions passed (e.g. a pool reconnecting to an expired port).
    const denied = path.join(harness, "guard", "denied.log");
    const refusals = fs.existsSync(denied) ? fs.readFileSync(denied, "utf8").trim().split("\n").filter(Boolean) : [];
    if (refusals.length) { console.error(`test:node: ${refusals.length} guarded network attempt(s) refused:\n${refusals.join("\n")}`); return code || 1; }
    return code;
  } finally { releaseProfile(sdk); fs.rmSync(harness, { recursive: true, force: true }); }
}

main().then((code) => { process.exitCode = code; }, (error) => { console.error(`test:node: ${error.message}`); process.exitCode = 1; });
