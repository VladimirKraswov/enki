import { afterEach, expect, it, vi } from "vitest";
import { McpPool, type McpClientLike } from "../src/mcp/pool.ts";

const spec = { id: "fixture", name: "Fixture", enabled: true, kind: "stdio", command: "/fixture/nonexecuted", args: [], url: "", envKeys: [], bearer: false };
const scope = { registryKey: "global", command: "/fixture/nonexecuted/enki" };
const pools: McpPool[] = [];
afterEach(async () => { for (const pool of pools.splice(0)) await pool.closeAll(); vi.restoreAllMocks(); });
function fake() {
  let closed: (() => void) | undefined;
  const client: McpClientLike & { kill(): void } = {
    connect: vi.fn(async () => {}),
    listTools: vi.fn(async (_signal: AbortSignal, cursor?: string) => cursor
      ? { tools: [{ name: "second", inputSchema: { type: "object" } }] }
      : { tools: [{ name: "first", inputSchema: { type: "object" } }], nextCursor: "next" }),
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "fixture" }] })),
    close: vi.fn(async () => {}), onClose: handler => { closed = handler; }, kill: () => closed?.(),
  };
  return client;
}
it("discovery forwards the exact page cursor and returns the complete tool set", async () => {
  const client = fake(), pool = new McpPool(async () => client, 10); pools.push(pool);
  const lease = await pool.acquire(spec, scope, "/fixture/project", new AbortController().signal);
  expect((await lease.connection.tools(new AbortController().signal)).map(tool => tool.name)).toEqual(["first", "second"]);
  expect(client.listTools).toHaveBeenCalledTimes(2); lease.release();
});
it("a later new invocation reconnects an existing lease but never retries an uncertain mutation", async () => {
  const clients: ReturnType<typeof fake>[] = [];
  const pool = new McpPool(async () => { const client = fake(); client.listTools = vi.fn(async () => ({ tools: [{ name: "mutate", inputSchema: { type: "object" } }] })); clients.push(client); return client; }, 10); pools.push(pool);
  const lease = await pool.acquire(spec, scope, "/fixture/project", new AbortController().signal);
  clients[0].callTool = vi.fn(async () => { clients[0].kill(); throw new Error("ACK lost after side effect"); });
  await expect(lease.connection.call("mutate", { id: "first" })).rejects.toThrow("ACK lost");
  expect(clients[0].callTool).toHaveBeenCalledTimes(1);
  expect(await lease.connection.call("mutate", { id: "second" })).toMatchObject({ content: [{ text: "fixture" }] });
  expect(clients).toHaveLength(2); expect(clients[0].callTool).toHaveBeenCalledTimes(1); expect(clients[1].callTool).toHaveBeenCalledTimes(1);
  lease.release();
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
it.each(["cycle", "pages", "duplicate", "count", "bytes", "invalidcursor"] as const)("bounded discovery rejects %s and closes only its own proxy", async kind => {
  const client = fake();
  client.listTools = vi.fn(async (_signal, cursor) => {
    if (kind === "count") return { tools: Array.from({ length: 129 }, (_, n) => ({ name: `t${n}`, inputSchema: {} })) };
    if (kind === "bytes") return { tools: [{ name: "large", description: "x".repeat(1024 * 1024), inputSchema: {} }] };
    if (kind === "invalidcursor") return { tools: [], nextCursor: 0 as unknown as string };
    return { tools: [{ name: kind === "duplicate" ? "same" : `tool${cursor ?? "first"}`, inputSchema: {} }], nextCursor: kind === "cycle" ? "same" : String(Number(cursor ?? 0) + 1) };
  });
  const pool = new McpPool(async () => client, 10); pools.push(pool);
  await expect(pool.acquire(spec, scope, "/fixture/project", new AbortController().signal)).rejects.toThrow();
  expect(client.callTool).not.toHaveBeenCalled(); expect(client.close).toHaveBeenCalledOnce();
  expect(vi.mocked(client.listTools).mock.calls.length).toBeLessThanOrEqual(4);
});
it("empty page cursor is forwarded exactly rather than repeating the first page", async () => {
  const client = fake();
  client.listTools = vi.fn(async (_signal, cursor) => cursor === undefined ? { tools: [], nextCursor: "" } : { tools: [{ name: "last", inputSchema: {} }] });
  const pool = new McpPool(async () => client, 10); pools.push(pool);
  const lease = await pool.acquire(spec, scope, "/fixture/project", new AbortController().signal);
  expect(client.listTools).toHaveBeenLastCalledWith(expect.any(AbortSignal), ""); lease.release();
});
it("one cancelled acquire does not cancel discovery for another session", async () => {
  const connecting = deferred<void>(), client = fake(); client.connect = vi.fn(() => connecting.promise);
  const factory = vi.fn(async () => client), pool = new McpPool(factory, 10); pools.push(pool);
  const controller = new AbortController();
  const first = pool.acquire(spec, scope, "/fixture/one", controller.signal).catch(error => error);
  const second = pool.acquire(spec, scope, "/fixture/two", new AbortController().signal);
  controller.abort(); expect(await first).toBeInstanceOf(Error);
  connecting.resolve(); const lease = await second;
  expect(factory).toHaveBeenCalledOnce(); expect(client.close).not.toHaveBeenCalled();
  expect(await lease.connection.tools(new AbortController().signal)).toHaveLength(2); lease.release();
});
it("late factory resolution after cancellation still closes the test-owned proxy", async () => {
  const opening = deferred<McpClientLike>(), client = fake(), pool = new McpPool(() => opening.promise, 10); pools.push(pool);
  const controller = new AbortController(), result = pool.acquire(spec, scope, "/fixture/project", controller.signal).catch(error => error);
  controller.abort(); expect(await result).toBeInstanceOf(Error);
  opening.resolve(client); await new Promise(resolve => setTimeout(resolve, 0));
  expect(client.close).toHaveBeenCalledOnce(); expect(client.connect).not.toHaveBeenCalled();
});
it("schema change after reconnect fences the existing tool definition without sending a mutation", async () => {
  const clients: ReturnType<typeof fake>[] = [];
  const pool = new McpPool(async () => { const client = fake(); client.listTools = vi.fn(async () => ({ tools: [{ name: "mutate", inputSchema: { type: "object", version: clients.length } }] })); clients.push(client); return client; }, 10); pools.push(pool);
  const lease = await pool.acquire(spec, scope, "/fixture/project", new AbortController().signal); clients[0].kill();
  await expect(lease.connection.call("mutate", { id: "new" })).rejects.toThrow("Список инструментов MCP изменился");
  expect(clients).toHaveLength(2); expect(clients[0].callTool).not.toHaveBeenCalled(); expect(clients[1].callTool).not.toHaveBeenCalled(); lease.release();
});
it("release during readiness cannot send a mutation after the lease was relinquished", async () => {
  const client = fake(), pool = new McpPool(async () => client, 10); pools.push(pool);
  const lease = await pool.acquire(spec, scope, "/fixture/project", new AbortController().signal);
  const pending = lease.connection.call("first", {}); lease.release();
  await expect(pending).rejects.toThrow("отменено"); expect(client.callTool).not.toHaveBeenCalled();
});
it("last release does not close a transport with an in-flight mutation", async () => {
  const completed = deferred<{ content: Array<{ type: "text"; text: string }> }>(), client = fake();
  client.callTool = vi.fn(() => completed.promise);
  const pool = new McpPool(async () => client, 0); pools.push(pool);
  const lease = await pool.acquire(spec, scope, "/fixture/project", new AbortController().signal);
  const pending = lease.connection.call("first", {});
  await new Promise(resolve => setTimeout(resolve, 0)); lease.release();
  await new Promise(resolve => setTimeout(resolve, 5)); expect(client.close).not.toHaveBeenCalled();
  completed.resolve({ content: [{ type: "text", text: "ok" }] }); await pending;
  await new Promise(resolve => setTimeout(resolve, 5)); expect(client.close).toHaveBeenCalledOnce();
});
it("discovery deadline is bounded and leaves no orphan readiness rejection", async () => {
  const client = fake(); client.listTools = vi.fn(() => new Promise<never>(() => {}));
  const pool = new McpPool(async () => client, 10, 10); pools.push(pool);
  await expect(pool.acquire(spec, scope, "/fixture/project", new AbortController().signal)).rejects.toThrow("отменено");
  expect(client.close).toHaveBeenCalledOnce();
});

it("maintenance admission fences new calls and acquisitions while retaining idle leases", async () => {
  const client = fake(), factory = vi.fn(async () => client), pool = new McpPool(factory, 10); pools.push(pool);
  const lease = await pool.acquire(spec, scope, "/fixture/project", new AbortController().signal);
  expect(pool.activity()).toEqual({ connecting: 0, calls: 0, closing: 0 }); pool.setAdmission(false);
  await expect(lease.connection.call("first", {})).rejects.toThrow("отменено");
  await expect(pool.acquire(spec, scope, "/fixture/project", new AbortController().signal)).rejects.toThrow("отменено");
  expect(client.callTool).not.toHaveBeenCalled(); expect(factory).toHaveBeenCalledOnce();
  pool.setAdmission(true); await lease.connection.call("first", {}); expect(client.callTool).toHaveBeenCalledOnce(); lease.release();
});
it("activity retains uncertain calls on retired transports until the caller actually settles", async () => {
  const done = deferred<{ content: [] }>(), clients: ReturnType<typeof fake>[] = [];
  const pool = new McpPool(async () => { const client = fake(); clients.push(client); return client; }, 0); pools.push(pool);
  const lease = await pool.acquire(spec, scope, "/fixture/project", new AbortController().signal);
  clients[0].callTool = vi.fn(() => done.promise);
  const uncertain = lease.connection.call("first", {}); await new Promise(resolve => setTimeout(resolve, 0));
  expect(pool.activity().calls).toBe(1); clients[0].kill(); await lease.connection.call("first", {});
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(clients).toHaveLength(2); expect(pool.activity().calls).toBe(1);
  done.resolve({ content: [] }); await uncertain;
  expect(pool.activity().calls).toBe(0); lease.release();
});
it("activity counts proxy close until it completes and closeAll is idempotent", async () => {
  const closed = deferred<void>(), client = fake(); client.close = vi.fn(() => closed.promise);
  const pool = new McpPool(async () => client, 0); pools.push(pool);
  const lease = await pool.acquire(spec, scope, "/fixture/project", new AbortController().signal); lease.release();
  await new Promise(resolve => setTimeout(resolve, 5)); expect(pool.activity()).toEqual({ connecting: 0, calls: 0, closing: 1 });
  const closing = pool.closeAll(); closed.resolve(); await closing;
  expect(pool.activity()).toEqual({ connecting: 0, calls: 0, closing: 0 }); expect(client.close).toHaveBeenCalledOnce();
});
