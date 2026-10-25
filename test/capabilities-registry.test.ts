// Shared capability registry as the single runtime reads it.
//
// The window no longer writes any agent configuration: the former OpenCode
// JSONC writers (sharedOpenCodeConfig/configureShared/synchronizeSources:
// comment/foreign-MCP/plugin preservation, reserved-name adoption, CAS writes,
// /instance/dispose refresh of idle scopes) were deleted with that engine. The
// runtime receives skills/servers through the native `capabilities.prepare`
// broker and registers tools per session in resources/shared/pi-extension.ts
// (test/pi-shared-tools.test.ts: namespace collision refuses the server,
// failure isolation, fail-closed reconfiguration) over the MCP pool
// (resources/agent/test/mcp-pool.test.ts, mcp-hardening.test.ts).
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyRegistry, runtimeServerState, serverName, signature, validateServer, type SharedServer } from "../src/capabilities/registry";
import { invalidateCapabilities, onCapabilitiesChanged } from "../src/capabilities/integration";
import { readRegistry, remoteUrl, toolName, signature as runtimeSignature } from "../src-tauri/resources/shared/registry.mjs";

const server: SharedServer = { id: "project-search", name: "Search", enabled: true, kind: "stdio", command: "/usr/bin/node", args: ["/tmp/server.mjs"], url: "", envKeys: [], bearer: false };
afterEach(() => { vi.restoreAllMocks(); });

it("schema, environment names, absolute executables and secret URL policy match", () => {
  expect(validateServer(server)).toBeNull();
  expect(validateServer({ ...server, command: "node" })).toBeTruthy();
  expect(validateServer({ ...server, command: "C:\\npm.cmd" })).toBeTruthy();
  expect(validateServer({ ...server, envKeys: ["KEY=secret"] })).toBeTruthy();
  expect(validateServer({ ...server, id: "Bad_ID" })).toBeTruthy();
  expect(validateServer({ ...server, args: ["a\0b"] })).toBeTruthy();
  expect(validateServer({ ...server, kind: "http", url: "https://host/mcp?token=secret" })).toBeTruthy();
  for (const url of ["http://remote/mcp", "https://user:secret@host/mcp", "https://host/mcp?token=secret"])
    expect(() => remoteUrl(url)).toThrow();
  expect(remoteUrl("http://127.0.0.1:18901/mcp").hostname).toBe("127.0.0.1");
  expect(toolName("project-search", "find_symbol")).toBe("mesh_project_search_find_symbol");
  expect(serverName("project-search")).toBe("mesh_project_search");
});

it("registry reads are bounded and reject traversal/symlinks; project merges preserve globals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mesh-registry-"));
  try {
    await writeFile(path.join(root, "global.json"), JSON.stringify({ ...emptyRegistry(), servers: [server] }));
    await writeFile(path.join(root, "project-0123456789abcdef.json"), JSON.stringify({ ...emptyRegistry(), sources: [{ id: "extra", path: "/extra", enabled: true }] }));
    expect((await readRegistry(root, "project-0123456789abcdef")).servers).toHaveLength(1);
    await expect(readRegistry(root, "../other")).rejects.toThrow();
    await writeFile(path.join(root, "global.json"), "x".repeat(262145));
    await expect(readRegistry(root, "global")).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true });
  }
});

it("UI and runtime share the exact revision token; stale registrations are reported honestly", () => {
  expect(signature(server)).toBe(runtimeSignature(server));
  expect(runtimeServerState(server, [], false)).toMatch(/Откройте/);
  expect(runtimeServerState({ ...server, enabled: false }, [], true)).toBe("Выключено");
  expect(runtimeServerState(server, [{ id: server.id, signature: "old", state: "connected", tools: ["x"] }], true)).toMatch(/Переоткройте/);
  expect(runtimeServerState(server, [{ id: server.id, signature: signature(server), state: "connected", tools: ["x"] }], true)).toMatch(/Подключено · 1/);
  expect(runtimeServerState(server, [{ id: server.id, signature: signature(server), state: "checking", tools: [] }], true)).toBe("Подключается");
  // An error is never shown as connected.
  expect(runtimeServerState(server, [{ id: server.id, signature: signature(server), state: "error", tools: [] }], true)).toBe("Ошибка подключения");
});

it("the revision ignores presentation metadata and property order", () => {
  const spec = { id: "revision", name: "Revision", enabled: true, kind: "stdio" as const, command: "/usr/bin/node", args: [], url: "", envKeys: [], bearer: false };
  const displayed = { inherited: true, ...spec };
  expect(runtimeServerState(displayed, [{ id: spec.id, signature: signature(spec), state: "connected", tools: ["mesh_revision_echo"] }], true)).toContain("Подключено");
  expect(signature({ bearer: false, ...spec })).toBe(signature(spec));
  expect(signature({ ...spec, args: ["changed"] })).not.toBe(signature(spec));
});

it("rotating authentication invalidates a loaded service without exposing its token", () => {
  const s = { ...server, authRevision: "old-public-revision" };
  const state = runtimeServerState({ ...s, authRevision: "new-public-revision" }, [{ id: s.id, signature: signature(s), state: "connected", tools: [] }], true);
  expect(state).toContain("Переоткройте");
  expect(signature({ ...s, token: "secret-a" } as SharedServer)).toBe(signature({ ...s, token: "secret-b" } as SharedServer));
});

it("registry edits notify listeners so newly opened sessions read them; unsubscribed listeners stay quiet", () => {
  const a = vi.fn(), b = vi.fn();
  const offA = onCapabilitiesChanged(a);
  const offB = onCapabilitiesChanged(b);
  invalidateCapabilities();
  offA();
  invalidateCapabilities();
  offB();
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledTimes(2);
});
