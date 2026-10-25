// Node-suite preload (`--import`, after node-guard.mjs, BEFORE any suite):
// installs this run's owned immutable SDK profile through the PRODUCTION
// installer, exactly as main.ts does before its first SDK value import. The
// suites import the same environment.ts URL, so they share this one module
// instance (a fixture overwriting PI_CODING_AGENT_DIR afterwards is refused by
// the SDK UI compatibility check, as in production).
import fs from "node:fs";

const profile = process.env.ENKI_TEST_SDK_PROFILE;
if (!profile) throw new Error("ENKI_TEST_SDK_PROFILE is required; run Node suites through test/run-node-suites.mjs");
const { installSdkEnvironment, sdkProfileDirectory } = await import(new URL("../../src/platform/environment.ts", import.meta.url).href);
installSdkEnvironment(profile);
if (sdkProfileDirectory() !== fs.realpathSync(profile)) throw new Error("SDK environment was not installed before the suites");
