// Regression (final runtime review, PROFILE isolation): the official MCP SDK
// stdio transport only inherits a HOME/PATH-like default environment, so the
// native `--shared-mcp`/`--browser-mcp` children and the image service's native
// lock child lost ENKI_PROFILE_DIR and resolved the owner's default roots and
// vault names. A harmless owned MCP stdio child reports what it really received
// through the REAL SDK transport. Also: launch defaults under an explicit profile.
import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { officialClient } from "../src/mcp/pool.ts";
import { browserTransportParameters } from "../../browser/pi-extension.ts";
import { profileEnvironment, stdioEnvironment } from "../../shared/registry.mjs";
import { parseArgs } from "../src/launch-args.ts";
import { daemonArguments } from "../src/daemon-control.ts";

const KEYS = ["ENKI_PROFILE_DIR", "ENKI_TEST_SECRET_CANARY", "MESH_CAPABILITIES_COMMAND"] as const;
let saved: Record<string, string | undefined> = {}, root = "";
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "enki-profile-env-")));
  process.env.ENKI_TEST_SECRET_CANARY = "must-never-reach-an-mcp-child";
});
afterEach(() => {
  for (const key of KEYS) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  fs.rmSync(root, { recursive: true, force: true });
});

/** Minimal newline-delimited JSON-RPC MCP server: one tool whose description is
 * the child's observed environment. Reads nothing else, writes only stdout. */
function fixture(): string {
  const file = path.join(root, "env-child.mjs");
  fs.writeFileSync(file, `import readline from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  const seen = { present: Object.hasOwn(process.env, "ENKI_PROFILE_DIR"), value: process.env.ENKI_PROFILE_DIR ?? null,
    canary: Object.hasOwn(process.env, "ENKI_TEST_SECRET_CANARY"), lock: process.env.MESH_CAPABILITIES_COMMAND ?? null };
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "env-child", version: "1.0.0" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "env", description: JSON.stringify(seen), inputSchema: { type: "object" } }] } });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unsupported" } });
});
`);
  return file;
}
type Seen = { present: boolean; value: string | null; canary: boolean; lock: string | null };
async function observe(env?: Record<string, string>): Promise<Seen> {
  // Same official SDK transport and env object production builds.
  const [{ Client }, { StdioClientTransport }] = await Promise.all([import("@modelcontextprotocol/sdk/client/index.js"), import("@modelcontextprotocol/sdk/client/stdio.js")]);
  const client = new Client({ name: "profile-env-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fixture()], cwd: root, stderr: "ignore", ...(env ? { env } : {}) }), { timeout: 10_000 });
  try { return JSON.parse((await client.listTools({}, { timeout: 10_000 })).tools[0]!.description!) as Seen; }
  finally { await client.close(); }
}
async function viaPool(): Promise<Seen> {
  const client = await officialClient(process.execPath, [fixture()], root), signal = new AbortController().signal;
  await client.connect(signal);
  try { return JSON.parse((await client.listTools(signal)).tools[0]!.description!) as Seen; }
  finally { await client.close(); }
}

it("the SDK default really drops the profile, which is why it must be forwarded explicitly", async () => {
  process.env.ENKI_PROFILE_DIR = path.join(root, "profile-a");
  expect(await observe()).toMatchObject({ present: false, canary: false });
});

it("shared pool, browser gateway and image child keep exact profile presence (A, B, empty) and absence, never other secrets", async () => {
  for (const value of [path.join(root, "profile-a"), path.join(root, "profile-b"), ""]) {
    process.env.ENKI_PROFILE_DIR = value;
    const expected = { present: true, value, canary: false };
    expect(await viaPool()).toMatchObject(expected);
    expect(await observe(browserTransportParameters(process.execPath, root).env)).toMatchObject(expected);
    process.env.MESH_CAPABILITIES_COMMAND = process.execPath;
    expect(await observe(stdioEnvironment({ id: "enki-images", envKeys: [] }))).toEqual({ ...expected, lock: process.execPath });
    // A user-configured server gets neither the profile nor the lock command.
    expect(await observe(stdioEnvironment({ id: "custom", envKeys: [] }))).toEqual({ present: false, value: null, canary: false, lock: null });
    delete process.env.MESH_CAPABILITIES_COMMAND;
  }
  delete process.env.ENKI_PROFILE_DIR;
  expect(profileEnvironment()).toEqual({});
  expect(await viaPool()).toMatchObject({ present: false, value: null, canary: false });
  expect(browserTransportParameters("/abs/enki", root)).toMatchObject({ args: ["--browser-mcp"], env: {} });
});

it("an explicit profile makes owner-home launch defaults inert; ordinary launches keep them", () => {
  const home = () => "/home/owner";
  expect(parseArgs([], {}, home)).toMatchObject({ data: "/home/owner/.local/share/enki/runtime", userPiAgentDir: "/home/owner/.pi/agent" });
  const refuseHome = () => { throw new Error("owner home consulted"); };
  for (const value of ["/profiles/a", ""]) {
    const profiled = { ENKI_PROFILE_DIR: value };
    expect(parseArgs(["--data", "/profiles/a/runtime"], profiled, refuseHome).userPiAgentDir).toBeUndefined();
    expect(parseArgs(["--data", "/profiles/a/runtime", "--user-pi-agent-dir", "/explicit/pi"], profiled, refuseHome).userPiAgentDir).toBe("/explicit/pi");
    expect(() => parseArgs([], profiled, refuseHome)).toThrow(/--data is required/);
  }
  expect(daemonArguments("/entry.js", { data: "/d" })).not.toContain("--user-pi-agent-dir");
  expect(daemonArguments("/entry.js", { data: "/d", userPiAgentDir: "/p" })).toEqual(expect.arrayContaining(["--user-pi-agent-dir", "/p"]));
});
