// Vitest globalSetup (main process, once per run). Provides the physical
// private SDK profile that test/setup/sdk-environment.ts installs inside each
// worker's Vite module graph BEFORE any test imports SDK value modules.
//
// Ordinary CI runs this before runtime:prepare, so no app artifact is required:
// by default an owned, read-only fixture profile is generated under the OS temp
// directory and removed on teardown. ENKI_TEST_SDK_PROFILE may name an already
// prepared profile explicitly; it is verified and never modified or deleted.
// HOME/USERPROFILE are never changed; no owner profile, ADC, provider or network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    enkiSdkProfile: string;
    enkiSdkProfileOrigin: "generated" | "explicit";
    enkiOriginalEnvironment: Record<"HOME" | "USERPROFILE" | "PI_CODING_AGENT_DIR" | "PI_OFFLINE" | "GOOGLE_APPLICATION_CREDENTIALS", string | null>;
  }
}

// One fixture policy shared with the public Node-suite runner (run-node-suites.mjs).
import { exe, FIXTURE_TOOL_EXIT, FIXTURE_TOOL_MARKER, generateProfile, releaseProfile, TOOLS } from "./sdk-profile-fixture.mjs";
export { FIXTURE_TOOL_EXIT, FIXTURE_TOOL_MARKER };

function verifyExplicit(profile: string): string {
  if (!path.isAbsolute(profile)) throw new Error("ENKI_TEST_SDK_PROFILE must be absolute");
  const physical = fs.realpathSync(profile);
  if (physical !== path.resolve(profile) || !fs.lstatSync(physical).isDirectory()) throw new Error("ENKI_TEST_SDK_PROFILE must be a physical directory without symlinks");
  const ownerPi = path.join(os.homedir(), ".pi");
  if (physical === ownerPi || physical.startsWith(ownerPi + path.sep)) throw new Error("ENKI_TEST_SDK_PROFILE must not be the owner's Pi profile");
  for (const name of TOOLS) {
    const file = path.join(physical, "bin", exe(name));
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) throw new Error(`ENKI_TEST_SDK_PROFILE lacks a regular bin/${exe(name)}`);
  }
  if (fs.existsSync(path.join(physical, ".no-ambient-adc"))) throw new Error("ENKI_TEST_SDK_PROFILE contains an ADC file");
  return physical;
}

function generate(): { root: string; profile: string } {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "enki-vitest-sdk-"));
  try {
    // Immutable for the run, like the bundled profile: the SDK must not write here.
    return { root, profile: generateProfile(root) };
  } catch (error) {
    release(root);
    throw error;
  }
}

function release(root: string): void {
  releaseProfile(root);
  fs.rmSync(root, { recursive: true, force: true });
}

export default function setup(project: TestProject): () => void {
  const original = (key: string) => process.env[key] ?? null;
  project.provide("enkiOriginalEnvironment", {
    HOME: original("HOME"), USERPROFILE: original("USERPROFILE"), PI_CODING_AGENT_DIR: original("PI_CODING_AGENT_DIR"),
    PI_OFFLINE: original("PI_OFFLINE"), GOOGLE_APPLICATION_CREDENTIALS: original("GOOGLE_APPLICATION_CREDENTIALS"),
  });
  const explicit = process.env.ENKI_TEST_SDK_PROFILE;
  if (explicit) {
    project.provide("enkiSdkProfile", verifyExplicit(explicit));
    project.provide("enkiSdkProfileOrigin", "explicit");
    return () => undefined;
  }
  const { root, profile } = generate();
  project.provide("enkiSdkProfile", profile);
  project.provide("enkiSdkProfileOrigin", "generated");
  return () => release(root);
}
