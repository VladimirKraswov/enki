// Detached daemon launch environment (fresh `ensure` and the verified remote
// updater share `daemonEnvironment`). Synthetic values only: no real HOME,
// SSH agent, proxy or key of the owner is read or used.
import { expect, it } from "vitest";
import { daemonEnvironment, NODE_INJECTION_KEYS } from "../src/daemon-control.ts";
// @ts-expect-error — plain .mjs installer module without declarations
import { stripInjection } from "../../../../scripts/runtime/install-remote.mjs";

const synthetic = {
  HOME: "/synthetic/home", USERPROFILE: "C:\\synthetic", SSH_AUTH_SOCK: "/synthetic/agent.sock", HTTPS_PROXY: "http://proxy.invalid:3128",
  NO_PROXY: "localhost", PROJECT_TOOL_TOKEN_NAME: "custom-value", PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/synthetic/pi",
  NODE_OPTIONS: "--require /tmp/evil.js", NODE_PATH: "/tmp/evil", NODE_REPL_EXTERNAL_MODULE: "/tmp/evil.js", NODE_EXTRA_CA_CERTS_OVERRIDE: "/tmp/ca.pem",
};

it("inherits the ambient environment unchanged except the four injection keys", () => {
  const env = daemonEnvironment(synthetic, "darwin");
  for (const key of NODE_INJECTION_KEYS) expect(env).not.toHaveProperty(key);
  // HOME and legitimate project-tool variables survive (no allowlist).
  expect(env).toMatchObject({ HOME: "/synthetic/home", USERPROFILE: "C:\\synthetic", SSH_AUTH_SOCK: "/synthetic/agent.sock", HTTPS_PROXY: "http://proxy.invalid:3128",
    NO_PROXY: "localhost", PROJECT_TOOL_TOKEN_NAME: "custom-value", PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/synthetic/pi" });
  expect(Object.keys(env)).toHaveLength(Object.keys(synthetic).length - 4);
});

it("matches injection keys case-insensitively on Windows only", () => {
  const source = { Node_Options: "--require x", node_path: "y", Path: "C:\\bin" };
  expect(daemonEnvironment(source, "win32")).toEqual({ Path: "C:\\bin" });
  expect(daemonEnvironment(source, "linux")).toEqual(source);
});

it("the updater's fallback policy is identical to the verified bundle's", () => {
  for (const platform of ["darwin", "linux", "win32"] as const)
    expect(stripInjection(synthetic, platform)).toEqual(daemonEnvironment(synthetic, platform));
});
