import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep the full release suite bounded on developer laptops alongside agents.
    maxWorkers: 2,
    // Heavy DOM mounts legitimately take several seconds on a laptop that is also
    // running agents; the assertions stay the same, only the wall-clock budget grows.
    testTimeout: 20000,
    hookTimeout: 20000,
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
  },
});
