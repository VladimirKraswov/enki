// One MCP connection per server signature shared by all sessions; cancellation
// reaches the call; a dead transport is recreated on the next acquire and an
// in-flight call is never retried.
import { expect, it, vi } from "vitest";
import { McpPool, type McpClientLike } from "../src/mcp/pool.ts";

const spec = { id: "demo", name: "Demo", enabled: true, kind: "stdio", command: "/bin/demo", args: [], url: "", envKeys: [], bearer: false };
const scope = { registryKey: "global", command: "/Applications/Enki.app/Contents/MacOS/enki" };

function fakeClient() {
  let onClose: (() => void) | undefined;
  const client: McpClientLike & { kill(): void } = {
    connect: vi.fn(async () => {}),
    listTools: vi.fn(async () => ({ tools: [{ name: "read_project", inputSchema: { type: "object" } }] })),
    callTool: vi.fn(async (_name: string, _args: Record<string, unknown>, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("aborted");
      return { content: [{ type: "text", text: "ok" }] };
    }),
    close: vi.fn(async () => {}),
    onClose: (handler) => { onClose = handler; },
    kill: () => onClose?.(),
  };
  return client;
}

it("shares one connection between two sessions and closes it after the last release", async () => {
  vi.useFakeTimers();
  const clients: ReturnType<typeof fakeClient>[] = [];
  const factory = vi.fn(async (command: string, args: string[]) => {
    expect(command).toBe(scope.command);
    expect(args).toEqual(["--shared-mcp", "global", "demo"]);
    const client = fakeClient(); clients.push(client); return client;
  });
  const pool = new McpPool(factory, 1000);
  const a = await pool.acquire(spec, scope, "/a", new AbortController().signal);
  const b = await pool.acquire(spec, scope, "/b", new AbortController().signal);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(await a.connection.tools(new AbortController().signal)).toHaveLength(1);
  a.release();
  await vi.advanceTimersByTimeAsync(2000);
  expect(clients[0].close).not.toHaveBeenCalled();
  b.release();
  b.release(); // double release is harmless
  await vi.advanceTimersByTimeAsync(2000);
  expect(clients[0].close).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

it("different project scopes never share a connection", async () => {
  const factory = vi.fn(async () => fakeClient());
  const pool = new McpPool(factory, 10);
  await pool.acquire(spec, scope, "/a", new AbortController().signal);
  await pool.acquire(spec, { ...scope, registryKey: "project-0123456789abcdef" }, "/b", new AbortController().signal);
  expect(factory).toHaveBeenCalledTimes(2);
  await expect(pool.acquire(spec, { ...scope, registryKey: "../escape" }, "/c", new AbortController().signal)).rejects.toThrow();
  await pool.closeAll();
});

it("passes cancellation to calls and reconnects the same lease only on a new call", async () => {
  const clients: ReturnType<typeof fakeClient>[] = [];
  const pool = new McpPool(async () => { const c = fakeClient(); clients.push(c); return c; }, 10);
  const lease = await pool.acquire(spec, scope, "/a", new AbortController().signal);
  const abort = new AbortController(); abort.abort();
  await expect(lease.connection.call("read_project", {}, abort.signal)).rejects.toThrow("отменено");
  clients[0].kill();
  expect(await lease.connection.call("read_project", {})).toMatchObject({ content: [{ text: "ok" }] });
  expect(clients[0].callTool).not.toHaveBeenCalled();
  expect(clients[1].callTool).toHaveBeenCalledTimes(1);
  const next = await pool.acquire(spec, scope, "/a", new AbortController().signal);
  expect(clients).toHaveLength(2);
  expect(await next.connection.call("read_project", {})).toMatchObject({ content: [{ text: "ok" }] });
  lease.release(); next.release(); await pool.closeAll();
});
