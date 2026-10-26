// Regression (final runtime review): shared/pi-extension.ts awaited
// lease.connection.tools() and then registered tools without re-checking the
// session generation, so discovery finishing after session_shutdown (or after a
// restart) still registered tools bound to a released lease. Also covers the
// execute-time registry await and stale status reports over a successor.
import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachShared, MCP_DETAILS_CHARS, MCP_ERROR_CHARS, mcpDetails, mcpErrorText, SAFE_ERROR, type SharedPool } from "../../shared/pi-extension.ts";
import { readRegistry } from "../../shared/registry.mjs";

const server = { id: "demo", name: "Demo", enabled: true, kind: "stdio", command: "/usr/bin/node", args: [], url: "", envKeys: [], bearer: false };
let root = "";
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

type Handler = (event: unknown, ctx?: unknown) => Promise<void> | void;
function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "enki-shared-life-"));
  fs.writeFileSync(path.join(root, "global.json"), JSON.stringify({ version: 1, sources: [], servers: [server] }));
  const events: Record<string, Handler> = {}, tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  const pi = { on: (name: string, handler: Handler) => { events[name] = handler; }, registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool) };
  const ctx = { cwd: root, ui: { notify: vi.fn() }, sessionManager: { getSessionId: () => "pi_session" } };
  const pending: Array<(value: unknown) => void> = [];
  const connection = {
    tools: vi.fn((_signal: AbortSignal) => new Promise<Array<{ name: string; inputSchema: { type: string } }>>(resolve => { pending.push(resolve as (value: unknown) => void); })),
    call: vi.fn(async () => ({ content: [{ type: "text", text: "OK" }] })),
  };
  const release = vi.fn(), report = vi.fn();
  const pool: SharedPool = { acquire: vi.fn(async () => ({ connection, release })) };
  let registry = () => readRegistry(root, "global");
  attachShared(pi as never, { registry: () => registry(), scope: { registryKey: "global", command: "/abs/enki" }, pool, report, reserved: () => [] });
  const discovered = (index: number) => pending[index]!([{ name: "read_project", inputSchema: { type: "object" } }]);
  return { events, tools, ctx, connection, release, report, pool, discovered, pending, setRegistry: (next: typeof registry) => { registry = next; } };
}

it("discovery finishing after shutdown registers nothing, reports nothing and releases the lease once", async () => {
  const f = fixture();
  const start = f.events.session_start!({}, f.ctx);
  await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  const reportsBefore = f.report.mock.calls.length;
  await f.events.session_shutdown!({});
  expect(f.release).toHaveBeenCalledOnce();
  f.discovered(0); await start;
  expect(f.tools.size).toBe(0);
  expect(f.report.mock.calls.length).toBe(reportsBefore);
  expect(f.ctx.ui.notify).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledOnce();
});

it("a restart during discovery binds only the new generation's tools", async () => {
  const f = fixture();
  const first = f.events.session_start!({}, f.ctx);
  await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  const second = f.events.session_start!({}, f.ctx);
  await vi.waitFor(() => expect(f.pending).toHaveLength(2));
  f.discovered(0); await first;
  expect(f.tools.size).toBe(0);
  f.discovered(1); await second;
  expect([...f.tools.keys()]).toEqual(["mesh_demo_read_project"]);
  expect(f.report.mock.calls.at(-1)?.[0]).toEqual([expect.objectContaining({ id: "demo", state: "connected" })]);
  await f.events.session_shutdown!({});
  expect(f.release).toHaveBeenCalledTimes(2);
});

// Remainder review: `details` is persisted in the transcript next to `content`.
it("a tool result keeps images/text in content only; persisted details are a bounded summary", async () => {
  const f = fixture();
  const start = f.events.session_start!({}, f.ctx);
  await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  f.discovered(0); await start;
  const tool = f.tools.get("mesh_demo_read_project")!;
  const pixels = "A".repeat(200_000);
  f.connection.call.mockResolvedValueOnce({ content: [{ type: "text", text: "shot" }, { type: "image", data: pixels, mimeType: "image/png" }],
    structuredContent: { page: "ok", completed: 1 } } as never);
  const small = await tool.execute("id", {}, new AbortController().signal) as { content: Array<{ type: string; data?: string }>; details: { mcp: unknown } };
  expect(small.content.find((block) => block.type === "image")?.data).toBe(pixels);
  expect(small.details.mcp).toEqual({ isError: false, blocks: ["text", "image"], structuredContent: { page: "ok", completed: 1 } });
  expect(JSON.stringify(small.details).length).toBeLessThan(1_000);
  f.connection.call.mockResolvedValueOnce({ content: [{ type: "text", text: "big" }], structuredContent: { snapshot: "x".repeat(MCP_DETAILS_CHARS + 10) } } as never);
  const big = await tool.execute("id", {}, new AbortController().signal) as { details: { mcp: { structuredContent?: unknown; structuredTruncated?: { chars: number } } } };
  expect(big.details.mcp.structuredContent).toBeUndefined();
  expect(big.details.mcp.structuredTruncated!.chars).toBeGreaterThan(MCP_DETAILS_CHARS);
  expect(mcpDetails({ content: [] })).toEqual({ isError: false, blocks: [] });
});

// Remainder review: an MCP refusal's own text reaches the model (it was dropped).
it("an MCP isError result surfaces the server's explanation, bounded, with the no-blind-retry rule", async () => {
  const f = fixture();
  const start = f.events.session_start!({}, f.ctx);
  await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  f.discovered(0); await start;
  const tool = f.tools.get("mesh_demo_read_project")!;
  const limit = "Достигнут предел: две попытки генерации на одну просьбу.";
  f.connection.call.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: limit }] } as never);
  await expect(tool.execute("id", {}, new AbortController().signal)).rejects.toThrow(`MCP сообщил об ошибке: ${limit} Не повторяйте действие вслепую.`);
  f.connection.call.mockResolvedValueOnce({ isError: true, content: [{ type: "image", data: "x", mimeType: "image/png" }] } as never);
  await expect(tool.execute("id", {}, new AbortController().signal)).rejects.toThrow("MCP сообщил об ошибке. Не повторяйте действие вслепую.");
  const long = mcpErrorText({ isError: true, content: [{ type: "text", text: "y".repeat(10_000) }] });
  expect(long.length).toBeLessThan(MCP_ERROR_CHARS + 100);
  // One send per invocation: an error is never retried by the bridge.
  expect(f.connection.call).toHaveBeenCalledTimes(2);
});

it("shutdown while a call reads the registry never reaches the released connection", async () => {
  const f = fixture();
  const start = f.events.session_start!({}, f.ctx);
  await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  f.discovered(0); await start;
  const tool = f.tools.get("mesh_demo_read_project")!;
  let readRegistryNow!: () => void;
  const gate = new Promise<void>(resolve => { readRegistryNow = resolve; });
  f.setRegistry(async () => { await gate; return readRegistry(root, "global"); });
  const call = tool.execute("id", {}, new AbortController().signal);
  await f.events.session_shutdown!({});
  readRegistryNow();
  await expect(call).rejects.toThrow(SAFE_ERROR);
  expect(f.connection.call).not.toHaveBeenCalled();
  await expect(tool.execute("id", {}, new AbortController().signal)).rejects.toThrow(SAFE_ERROR);
});


it("a transient startup handshake recovers once without executing any tool or asking the owner to resend", async () => {
  const f = fixture();
  vi.mocked(f.pool.acquire).mockRejectedValueOnce(Error("transport closed private-secret"));
  const start = f.events.session_start!({}, f.ctx);
  await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  f.discovered(0); await start;
  expect(f.pool.acquire).toHaveBeenCalledTimes(2);
  expect([...f.tools.keys()]).toEqual(["mesh_demo_read_project"]);
  expect(f.connection.call).not.toHaveBeenCalled();
  expect(f.ctx.ui.notify).not.toHaveBeenCalled();
  expect(f.report.mock.calls.at(-1)?.[0][0].state).toBe("connected");
  await f.events.session_shutdown!({});
  expect(f.release).toHaveBeenCalledOnce();
});

it("discovery failure releases the failed lease before the single recovery attempt", async () => {
  const f = fixture();
  f.connection.tools.mockRejectedValueOnce(Error("catalog connection closed"));
  const start = f.events.session_start!({}, f.ctx);
  await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  expect(f.release).toHaveBeenCalledOnce();
  f.discovered(0); await start;
  expect(f.pool.acquire).toHaveBeenCalledTimes(2);
  expect(f.connection.call).not.toHaveBeenCalled();
  await f.events.session_shutdown!({});
  expect(f.release).toHaveBeenCalledTimes(2);
});


it("shutdown while recovery checks the registry cannot reconnect or notify over the next generation", async () => {
  const f = fixture();
  let reads = 0, finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  f.setRegistry(async () => { if (++reads > 1) await gate; return readRegistry(root, "global"); });
  vi.mocked(f.pool.acquire).mockRejectedValueOnce(Error("closed"));
  const start = f.events.session_start!({}, f.ctx);
  await vi.waitFor(() => expect(reads).toBe(2));
  await f.events.session_shutdown!({});
  finish(); await start;
  expect(f.pool.acquire).toHaveBeenCalledOnce();
  expect(f.tools.size).toBe(0);
  expect(f.ctx.ui.notify).not.toHaveBeenCalled();
  expect(f.connection.call).not.toHaveBeenCalled();
});


it("an uncertain tool-call failure is still sent once and never enters startup recovery", async () => {
  const f = fixture();
  const start = f.events.session_start!({}, f.ctx);
  await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  f.discovered(0); await start;
  f.connection.call.mockRejectedValueOnce(Error("private upstream failure"));
  await expect(f.tools.get("mesh_demo_read_project")!.execute("call", {}, new AbortController().signal)).rejects.toThrow(SAFE_ERROR);
  expect(f.connection.call).toHaveBeenCalledOnce();
  expect(f.pool.acquire).toHaveBeenCalledOnce();
  await f.events.session_shutdown!({});
});

it("a changed registry blocks startup recovery before another connection can open", async () => {
  const f = fixture();
  let reads = 0;
  f.setRegistry(async () => { const value = await readRegistry(root, "global"); return ++reads === 1 ? value : {...value, servers: [{...server, enabled:false}]}; });
  vi.mocked(f.pool.acquire).mockRejectedValueOnce(Error("closed"));
  await f.events.session_start!({}, f.ctx);
  expect(f.pool.acquire).toHaveBeenCalledOnce();
  expect(f.tools.size).toBe(0);
  expect(f.connection.call).not.toHaveBeenCalled();
  expect(f.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("настройки подключения изменились"), "warning");
  await f.events.session_shutdown!({});
});
