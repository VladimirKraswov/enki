// ONE owned, read-only fixture of the immutable bundled SDK profile, shared by
// the Vitest globalSetup and the public Node-suite runner. Production installs
// the real profile with installSdkEnvironment(); tests install THIS directory
// through the same function before any SDK value import. HOME is never changed.
import fs from "node:fs";
import path from "node:path";

/** Marker every inert placeholder carries; the setup coverage test asserts it. */
export const FIXTURE_TOOL_MARKER = "enki-vitest-sdk-profile-placeholder";
/** Distinct exit status: a placeholder that is executed fails loudly, never "finds nothing". */
export const FIXTURE_TOOL_EXIT = 97;
export const TOOLS = Object.freeze(["rg", "fd"]);
export const exe = (name) => name + (process.platform === "win32" ? ".exe" : "");

// The suites declare NO search-tool scenario. Any execution is outside the
// fixture and must fail explicitly. On Windows the text file is not a PE image,
// so CreateProcess refuses it; it can never act as a search binary either.
function placeholder(name) {
  return [
    "#!/bin/sh",
    `echo "${FIXTURE_TOOL_MARKER}: ${name} is an inert Vitest SDK-profile placeholder, not a qualified search binary; this suite declares no search scenario." >&2`,
    `exit ${FIXTURE_TOOL_EXIT}`,
    "",
  ].join("\n");
}

/** Create `<parent>/profile` (immutable for the run, like the bundled profile). */
export function generateProfile(parent) {
  const profile = path.join(parent, "profile"), bin = path.join(profile, "bin");
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  for (const name of TOOLS) fs.writeFileSync(path.join(bin, exe(name)), placeholder(name), { mode: 0o555, flag: "wx" });
  fs.chmodSync(bin, 0o555);
  fs.chmodSync(profile, 0o555);
  return profile;
}

/** Make a generated profile removable again (its parent is removed by the caller). */
export function releaseProfile(parent) {
  for (const directory of [path.join(parent, "profile"), path.join(parent, "profile", "bin")]) {
    try { fs.chmodSync(directory, 0o700); } catch { /* absent after a partial generate */ }
  }
}
