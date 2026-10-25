// Public Vitest bootstrap coverage: the production installSdkEnvironment ran in
// THIS module graph before SDK imports, with a private physical immutable
// profile, offline SDK defaults, no ambient ADC and unchanged HOME/USERPROFILE.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, inject, it } from "vitest";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { installSdkEnvironment, projectToolEnvironment, sdkProfileDirectory } from "../src/platform/environment.ts";
import { FIXTURE_TOOL_EXIT, FIXTURE_TOOL_MARKER } from "./setup/sdk-profile.global.ts";

const profile = inject("enkiSdkProfile");
const origin = inject("enkiSdkProfileOrigin");
const original = inject("enkiOriginalEnvironment");
const exe = (name: string) => name + (process.platform === "win32" ? ".exe" : "");

describe("Vitest SDK environment bootstrap", () => {
  it("installed the provided physical profile in the Vite graph, seen by the native SDK", () => {
    expect(path.isAbsolute(profile)).toBe(true);
    expect(fs.realpathSync(profile)).toBe(profile);
    expect(sdkProfileDirectory()).toBe(profile);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(profile);
    expect(fs.realpathSync(getAgentDir())).toBe(profile);
    const ownerPi = path.join(os.homedir(), ".pi");
    expect(profile === ownerPi || profile.startsWith(ownerPi + path.sep)).toBe(false);
  });

  it("keeps the SDK offline without ambient Google ADC", () => {
    expect(process.env.PI_OFFLINE).toBe("1");
    expect(process.env.GOOGLE_APPLICATION_CREDENTIALS).toBe(path.join(profile, ".no-ambient-adc"));
    expect(fs.existsSync(path.join(profile, ".no-ambient-adc"))).toBe(false);
  });

  it("leaves HOME/USERPROFILE unchanged and restores host values for project tools", () => {
    expect(process.env.HOME ?? null).toBe(original.HOME);
    expect(process.env.USERPROFILE ?? null).toBe(original.USERPROFILE);
    const tools = projectToolEnvironment(process.env);
    for (const key of ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "GOOGLE_APPLICATION_CREDENTIALS"] as const) expect(tools[key] ?? null).toBe(original[key]);
  });

  it("refuses switching the installed profile inside the running worker", () => {
    const other = fs.realpathSync(os.tmpdir());
    expect(() => installSdkEnvironment(other)).toThrow(/Нельзя сменить профиль SDK/);
    expect(() => installSdkEnvironment("relative/profile")).toThrow();
    expect(sdkProfileDirectory()).toBe(profile);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(profile);
  });

  it("generated profile is immutable and its rg/fd placeholders refuse explicitly when executed", () => {
    for (const name of ["rg", "fd"]) {
      const file = path.join(profile, "bin", exe(name));
      const stat = fs.lstatSync(file);
      expect(stat.isFile() && !stat.isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(file)).toBe(file);
      if (origin !== "generated") continue;
      const text = fs.readFileSync(file, "utf8");
      // Exactly a refusal: shebang, diagnostic to stderr, distinct failure status. No search behaviour.
      expect(text.split("\n")).toEqual([
        "#!/bin/sh",
        expect.stringMatching(new RegExp(`^echo "${FIXTURE_TOOL_MARKER}: ${name} is an inert Vitest SDK-profile placeholder, not a qualified search binary;[^"]*" >&2$`)),
        `exit ${FIXTURE_TOOL_EXIT}`,
        "",
      ]);
      if (process.platform !== "win32") expect(stat.mode & 0o222).toBe(0);
    }
    if (origin === "generated" && process.platform !== "win32") {
      expect(fs.statSync(profile).mode & 0o222).toBe(0);
      expect(fs.statSync(path.join(profile, "bin")).mode & 0o222).toBe(0);
      expect(fs.readdirSync(profile).sort()).toEqual(["bin"]);
      expect(path.dirname(path.dirname(profile))).toBe(fs.realpathSync(os.tmpdir()));
    }
  });
});
