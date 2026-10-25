// Vitest setupFiles entry: runs inside the worker's Vite module graph before
// the test file's own imports. Vite transforms src/platform/environment.ts into
// a DIFFERENT module instance than a native `node --import` preload would load,
// so the production installer must be called here, in the same graph that
// runtime/adapter/plugin-ui import. Same call main.ts makes; nothing is mocked.
// This file must import no SDK value module.
import { inject } from "vitest";
import { installSdkEnvironment, sdkProfileDirectory } from "../../src/platform/environment.ts";

const profile = inject("enkiSdkProfile");
if (!profile) throw new Error("Vitest globalSetup did not provide the private SDK profile");
installSdkEnvironment(profile);
if (sdkProfileDirectory() !== profile) throw new Error("SDK environment was not installed in the Vite module graph");
