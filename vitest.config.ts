import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep the full release suite bounded on developer laptops alongside agents.
    maxWorkers: 2,
    // An accidentally recursive test must fail inside its own process before
    // it consumes several GiB and exhausts the host's swap space.
    execArgv: ["--max-old-space-size=1024"],
    // Heavy DOM mounts legitimately take several seconds on a laptop that is also
    // running agents; the assertions stay the same, only the wall-clock budget grows.
    testTimeout: 20000,
    hookTimeout: 20000,
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
  },
});
