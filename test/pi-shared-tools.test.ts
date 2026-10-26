import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { attachShared, type SharedPool } from "../src-tauri/resources/shared/pi-extension";
import { readRegistry } from "../src-tauri/resources/shared/registry.mjs";
import { needsApproval } from "../src-tauri/resources/pi/tool-gate";

let root: string;
const server = { id: "demo", name: "Demo", enabled: true, kind: "stdio", command: "/usr/bin/node", args: [], url: "", envKeys: [], bearer: false };

async function fixture(reserved: string[] = []) {
  root = await mkdtemp(path.join(os.tmpdir(), "pi-shared-"));
  await writeFile(path.join(root, "global.json"), JSON.stringify({ version: 1, sources: [], servers: [server] }));
  const events: any = {}, tools = new Map<string, any>();
  const pi = { on: (n: string, h: any) => { events[n] = h; }, registerTool: (t: any) => tools.set(t.name, t) };
  const ctx = { cwd: root, ui: { notify: vi.fn() }, sessionManager: { getSessionId: () => "pi_session" } };
  const connection = {
    tools: vi.fn(async () => [{ name: "read_project", inputSchema: { type: "object", properties: {}, additionalProperties: false } }]),
    call: vi.fn(async () => ({ content: [{ type: "text", text: "OK" }] })),
  };
  const release = vi.fn();
  const pool: SharedPool = { acquire: vi.fn(async () => ({ connection, release })) };
  const report = vi.fn();
  attachShared(pi as never, { registry: () => readRegistry(root, "global"), scope: { registryKey: "global", command: "/Applications/Enki.app/Contents/MacOS/enki" }, pool, report, reserved: () => reserved });
  return { events, tools, ctx, connection, pool, release, report };
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true });
});

it("loading the factory starts no connection; session start registers namespaced tools that still need approval", async () => {
  const f = await fixture();
  expect(f.pool.acquire).not.toHaveBeenCalled();
  await f.events.session_start({}, f.ctx);
  const tool = f.tools.get("mesh_demo_read_project");
  expect(tool).toBeTruthy();
  expect(needsApproval(tool.name)).toBe(true);
  expect(await tool.execute("test", {}, new AbortController().signal)).toMatchObject({ content: [{ type: "text", text: "OK" }] });
  expect(f.report.mock.calls.at(-1)?.[0]).toEqual([expect.objectContaining({ id: "demo", state: "connected", tools: ["mesh_demo_read_project"] })]);
  await f.events.session_shutdown();
  expect(f.release).toHaveBeenCalledOnce();
});

it("disabled/reconfigured services fail closed for already registered tools", async () => {
  const f = await fixture();
  await f.events.session_start({}, f.ctx);
  await writeFile(path.join(root, "global.json"), JSON.stringify({ version: 1, sources: [], servers: [{ ...server, enabled: false }] }));
  await expect(f.tools.get("mesh_demo_read_project").execute("test", {}, new AbortController().signal)).rejects.toThrow(/Переоткройте/);
  expect(f.connection.call).not.toHaveBeenCalled();
  await f.events.session_shutdown();
});

it("connection failure does not advertise tools or expose upstream error text", async () => {
  const f = await fixture();
  vi.mocked(f.pool.acquire).mockRejectedValue(Error("private-secret"));
  await f.events.session_start({}, f.ctx);
  expect(f.tools.size).toBe(0);
  expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).not.toContain("private-secret");
  expect(f.pool.acquire).toHaveBeenCalledTimes(2);
  expect(f.report.mock.calls.at(-1)?.[0][0].state).toBe("error");
  await f.events.session_shutdown();
});

// Ported from capabilities-registry (former OpenCode configureShared): one
// unavailable optional MCP is reported and never blocks the others; a new
// session can try again after the single bounded read-only recovery.
it("an unavailable optional server is reported while the others still attach, and gets one read-only recovery before a new session", async () => {
  const f = await fixture();
  await writeFile(path.join(root, "global.json"), JSON.stringify({ version: 1, sources: [], servers: [{ ...server, id: "failing", name: "Unavailable" }, { ...server, id: "working", name: "Working" }] }));
  vi.mocked(f.pool.acquire).mockImplementation(async (spec: any) => {
    if (spec.id === "failing") throw Error("private-secret");
    return { connection: f.connection, release: f.release };
  });
  await f.events.session_start({}, f.ctx);
  expect([...f.tools.keys()]).toEqual(["mesh_working_read_project"]);
  expect(f.report.mock.calls.at(-1)?.[0].map((s: any) => [s.id, s.state])).toEqual([["failing", "error"], ["working", "connected"]]);
  expect(f.pool.acquire).toHaveBeenCalledTimes(3);
  expect(vi.mocked(f.pool.acquire).mock.calls.map(([spec]) => spec.id)).toEqual(["failing", "working", "failing"]);
  expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).not.toContain("private-secret");
  await f.events.session_shutdown();
  expect(f.pool.acquire).toHaveBeenCalledTimes(3);
  await f.events.session_start({}, f.ctx);
  expect(f.pool.acquire).toHaveBeenCalledTimes(6);
  await f.events.session_shutdown();
});

it("a namespace collision with an existing tool refuses the whole server instead of shadowing", async () => {
  const f = await fixture(["mesh_demo_read_project"]);
  await f.events.session_start({}, f.ctx);
  expect(f.tools.size).toBe(0);
  expect(f.pool.acquire).toHaveBeenCalledOnce();
  await f.events.session_shutdown();
});

it("shutdown during discovery does not register late tools", async () => {
  const f = await fixture();
  let finish!: () => void;
  f.connection.tools.mockImplementation(() => new Promise((resolve) => { finish = () => resolve([{ name: "read_project", inputSchema: { type: "object" } }]); }));
  const pending = f.events.session_start({}, f.ctx);
  await vi.waitFor(() => expect(f.connection.tools).toHaveBeenCalled());
  await f.events.session_shutdown();
  finish();
  await pending;
  expect(f.tools.size).toBe(0);
});

it("binds image calls to the SDK session identity and replaces forged model context", async () => {
  const f = await fixture();
  await writeFile(path.join(root, "global.json"), JSON.stringify({ version: 1, sources: [], servers: [{ ...server, id: "enki-images" }] }));
  await f.events.session_start({}, f.ctx);
  const tool = f.tools.get("mesh_enki_images_read_project");
  const signal = new AbortController().signal;
  await tool.execute("test", { __enkiImageContext: { engine: "opencode", sessionID: "forged" }, prompt: "keep" }, signal, undefined,
    { ...f.ctx, sessionManager: { getSessionId: () => "pi_actual" } });
  expect(f.connection.call).toHaveBeenCalledWith("read_project", { prompt: "keep", __enkiImageContext: { engine: "pi", sessionID: "pi_actual" } }, signal);
  await f.events.session_shutdown();
});

// Re-homed from image-context.test.ts case 4 (dead OpenCode access-policy hook):
// the trusted identity is now bound by the sole SDK bridge for EVERY image tool,
// even with no browser tools present, and other arguments pass unchanged.
it("every image tool receives the SDK session identity, overriding a forged one, with other arguments intact", async () => {
  const f = await fixture();
  await writeFile(path.join(root, "global.json"), JSON.stringify({ version: 1, sources: [], servers: [{ ...server, id: "enki-images" }] }));
  const names = ["image_inputs", "edit_image", "get_images"];
  f.connection.tools.mockResolvedValue(names.map((name) => ({ name, inputSchema: { type: "object", properties: {}, additionalProperties: false } })));
  await f.events.session_start({}, f.ctx);
  expect([...f.tools.keys()]).toEqual(names.map((name) => `mesh_enki_images_${name}`));
  const signal = new AbortController().signal;
  for (const name of names) {
    await f.tools.get(`mesh_enki_images_${name}`).execute("test", { __enkiImageContext: { engine: "pi", sessionID: "forged" }, input: "current" }, signal, undefined,
      { ...f.ctx, sessionManager: { getSessionId: () => "ses_real" } });
    expect(f.connection.call).toHaveBeenLastCalledWith(name, { input: "current", __enkiImageContext: { engine: "pi", sessionID: "ses_real" } }, signal);
  }
  await f.events.session_shutdown();
});

// Stronger than the OpenCode premise ("other tools keep it"): a model-written
// identity is never forwarded to an unrelated MCP server at all.
it("a model-supplied image identity never reaches another server", async () => {
  const f = await fixture();
  await f.events.session_start({}, f.ctx);
  const signal = new AbortController().signal;
  await f.tools.get("mesh_demo_read_project").execute("test", { __enkiImageContext: { engine: "pi", sessionID: "keep" }, path: "a" }, signal);
  expect(f.connection.call).toHaveBeenCalledWith("read_project", { path: "a" }, signal);
  await f.events.session_shutdown();
});

it("an invalid SDK session identity is refused before any image call", async () => {
  const f = await fixture();
  await writeFile(path.join(root, "global.json"), JSON.stringify({ version: 1, sources: [], servers: [{ ...server, id: "enki-images" }] }));
  await f.events.session_start({}, f.ctx);
  const tool = f.tools.get("mesh_enki_images_read_project");
  for (const bad of ["../escape", "", "x".repeat(201)])
    await expect(tool.execute("test", { prompt: "x" }, new AbortController().signal, undefined,
      { ...f.ctx, sessionManager: { getSessionId: () => bad } })).rejects.toThrow("Общий MCP недоступен");
  expect(f.connection.call).not.toHaveBeenCalled();
  await f.events.session_shutdown();
});
