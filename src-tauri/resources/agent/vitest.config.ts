import { defineConfig } from "vitest/config";

// Runtime tests run against the installed, pinned SDK in ./node_modules with a
// deterministic scripted provider. No network, GPU or real model is used.
// globalSetup owns a private immutable SDK profile for the run; setupFiles
// installs it through the production installer inside each worker's Vite graph
// before any test imports SDK value modules. HOME/USERPROFILE stay unchanged.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globalSetup: ["test/setup/sdk-profile.global.ts"],
    setupFiles: ["test/setup/sdk-environment.ts"],
    testTimeout: 30_000,
    pool: "forks",
    maxWorkers: 1,
  },
});
