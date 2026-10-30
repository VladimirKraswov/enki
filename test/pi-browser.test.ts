import { afterEach, expect, it, vi } from "vitest";
import { attachBrowser, type BrowserConnection, type BrowserLoader } from "../src-tauri/resources/browser/pi-extension";
import { needsApproval } from "../src-tauri/resources/pi/tool-gate";

const schema = { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false };
const official = { name: "browser_navigate", description: "Navigate a browser tab", inputSchema: schema };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const COMMAND = "/Applications/Enki.app/Contents/MacOS/enki";
// Per-session options replace the former process-wide environment variables,
// so one runtime can host sessions with different access scopes.
let command: string | undefined = COMMAND;
let access: "full" | "project" = "project";
function setup(overrides: Partial<BrowserConnection> = {}, loadOverride?: BrowserLoader) {
  command = COMMAND;
  access = "project";
  const events: Record<string, (...args: any[]) => any> = {};
  const tools = new Map<string, any>();
  const pi = { on: vi.fn((event, handler) => { events[event] = handler; }), registerTool: vi.fn(tool => { tools.set(tool.name, tool); }) };
  const ctx = { cwd: "/tmp/pi-browser-test", ui: { notify: vi.fn() }, sessionManager: { getSessionId: () => "pi_test" } };
  const connection: BrowserConnection = {
    connect: vi.fn(async () => {}),
    listTools: vi.fn(async () => ({ tools: [official] })),
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "Loaded fixture" }] })),
    close: vi.fn(async () => {}), ...overrides,
  };
  const load = vi.fn(loadOverride ?? (async () => connection));
  attachBrowser(pi as any, { command: () => command, access: () => access }, load);
  const ready = async () => {
    events.session_start({ type: "session_start" }, ctx);
    await vi.waitFor(() => expect(pi.registerTool).toHaveBeenCalled());
    return tools.get("desktop_browser_browser_navigate");
  };
  return { events, pi, ctx, connection, load, tools, ready };
}
afterEach(() => { vi.restoreAllMocks(); });

it("factory discovery registers lifecycle callbacks without starting a transport", () => {
  const fixture = setup();
  expect(fixture.load).not.toHaveBeenCalled();
  expect(fixture.connection.connect).not.toHaveBeenCalled();
  expect(fixture.pi.registerTool).not.toHaveBeenCalled();
  expect(Object.keys(fixture.events)).toEqual(["session_start", "before_agent_start", "session_shutdown"]);
});

it("uses exact official schemas, safe names and existing approval policy", async () => {
  const fixture = setup({ listTools: vi.fn(async () => ({ tools: [official,
    { ...official, name: "../browser_admin" }, { ...official, name: "shell" },
    { ...official, name: "browser_invalid", inputSchema: { type: "array" } }, official] })) });
  const tool = await fixture.ready();
  expect(fixture.load).toHaveBeenCalledWith(COMMAND, fixture.ctx.cwd);
  expect([...fixture.tools.keys()]).toEqual(["desktop_browser_browser_navigate"]);
  expect(tool.parameters).toBe(schema);
  expect(tool.executionMode).toBe("sequential");
  expect(tool.promptGuidelines.join(" ")).toContain("normal Pi tool approvals");
  expect(tool.promptGuidelines.join(" ")).toContain("Never echo passwords");
  expect(needsApproval(tool.name)).toBe(true);
  expect(fixture.connection.connect).toHaveBeenCalledWith({ signal: expect.any(AbortSignal), timeout: 10000 });
  await fixture.events.session_shutdown();
});

it("preserves text, images and structured results and passes bounded abort options", async () => {
  const result = { content: [{ type: "text", text: "Fixture page" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], structuredContent: { page: "fixture", ok: true } };
  const fixture = setup({ callTool: vi.fn(async () => result) });
  const tool = await fixture.ready();
  const abort = new AbortController();
  const params = { url: "https://example.test" };
  const response = await tool.execute("call-1", params, abort.signal);
  expect(fixture.connection.callTool).toHaveBeenCalledWith({ name: official.name, arguments: params, _meta: { arvelaAccess: "project", arvelaSession: { engine: "pi", sessionID: "pi_test" } } }, { signal: abort.signal, timeout: 90000 });
  expect(response.content.slice(0, 2)).toEqual(result.content);
  expect(response.content[2].text).toContain('"page":"fixture"');
  // The screenshot reaches the model exactly once, through response.content;
  // persisted details are a bounded summary (no second copy of the image).
  expect(response.content[1]).toEqual({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" });
  expect(response.details.mcp).toEqual({ isError: false, blocks: ["text", "image"], structuredContent: result.structuredContent });
  expect(JSON.stringify(response.details)).not.toContain("aW1hZ2U=");
  await fixture.events.session_shutdown();
});

it("does not block session startup or register fake tools when the gateway is unavailable", async () => {
  const connect = deferred<void>();
  const fixture = setup({ connect: vi.fn(() => connect.promise) });
  expect(fixture.events.session_start({}, fixture.ctx)).toBeUndefined();
  await vi.waitFor(() => expect(fixture.connection.connect).toHaveBeenCalled());
  connect.reject(new Error("private diagnostic: password=fixture"));
  await vi.waitFor(() => expect(fixture.ctx.ui.notify).toHaveBeenCalledOnce());
  expect(fixture.ctx.ui.notify.mock.calls[0][0]).toContain("Настройки → Браузер");
  expect(fixture.ctx.ui.notify.mock.calls[0][0]).not.toContain("password");
  expect(fixture.pi.registerTool).not.toHaveBeenCalled();
  expect(fixture.load).toHaveBeenCalledOnce();
  await fixture.events.session_shutdown();
});

it("rejects missing/relative native commands before creating a transport", async () => {
  const fixture = setup();
  command = "enki";
  fixture.events.session_start({}, fixture.ctx);
  await vi.waitFor(() => expect(fixture.ctx.ui.notify).toHaveBeenCalledOnce());
  expect(fixture.load).not.toHaveBeenCalled();
  expect(fixture.pi.registerTool).not.toHaveBeenCalled();
});

it("shutdown during module loading closes only its late connection and registers nothing", async () => {
  const loaded = deferred<BrowserConnection>();
  const fixture = setup({}, () => loaded.promise);
  fixture.events.session_start({}, fixture.ctx);
  await vi.waitFor(() => expect(fixture.load).toHaveBeenCalled());
  await fixture.events.session_shutdown();
  loaded.resolve(fixture.connection);
  await vi.waitFor(() => expect(fixture.connection.close).toHaveBeenCalled());
  expect(fixture.connection.connect).not.toHaveBeenCalled();
  expect(fixture.pi.registerTool).not.toHaveBeenCalled();
  expect(fixture.ctx.ui.notify).not.toHaveBeenCalled();
});

it("shutdown cancels pending initialization and old tool executions cannot outlive the session", async () => {
  const fixture = setup();
  const tool = await fixture.ready();
  const init = vi.mocked(fixture.connection.connect).mock.calls[0][0].signal!;
  await fixture.events.session_shutdown();
  expect(init.aborted).toBe(true);
  expect(fixture.connection.close).toHaveBeenCalledOnce();
  await expect(tool.execute("closed", {})).rejects.toThrow("закрыт");
  expect(fixture.connection.callTool).not.toHaveBeenCalled();
});

it("shutdown during connection cancels initialization, closes once and never registers late tools", async () => {
  const connecting = deferred<void>();
  const fixture = setup({ connect: vi.fn(() => connecting.promise) });
  fixture.events.session_start({}, fixture.ctx);
  await vi.waitFor(() => expect(fixture.connection.connect).toHaveBeenCalled());
  const signal = vi.mocked(fixture.connection.connect).mock.calls[0][0].signal!;
  await fixture.events.session_shutdown();
  connecting.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(signal.aborted).toBe(true);
  expect(fixture.connection.close).toHaveBeenCalledOnce();
  expect(fixture.pi.registerTool).not.toHaveBeenCalled();
  expect(fixture.connection.listTools).not.toHaveBeenCalled();
});

it("session replacement refuses stale results and closes the old proxy, never the browser daemon", async () => {
  const request = deferred<any>();
  const first: BrowserConnection = { connect: vi.fn(async () => {}), listTools: vi.fn(async () => ({ tools: [official] })), callTool: vi.fn(() => request.promise), close: vi.fn(async () => {}) };
  const second: BrowserConnection = { ...first, callTool: vi.fn(async () => ({ content: [] })), close: vi.fn(async () => {}) };
  let count = 0;
  const fixture = setup({}, async () => count++ === 0 ? first : second);
  const oldTool = await fixture.ready();
  const pending = oldTool.execute("old", {});
  fixture.events.session_start({}, fixture.ctx);
  await vi.waitFor(() => expect(fixture.pi.registerTool).toHaveBeenCalledTimes(2));
  request.resolve({ content: [{ type: "text", text: "stale" }] });
  await expect(pending).rejects.toThrow("закрыт");
  expect(first.close).toHaveBeenCalledOnce();
  await fixture.events.session_shutdown();
  expect(second.close).toHaveBeenCalledOnce();
});

it("honors cancellation before and during tool calls instead of returning success", async () => {
  const request = deferred<any>();
  const fixture = setup({ callTool: vi.fn(() => request.promise) });
  const tool = await fixture.ready();
  const abort = new AbortController();
  abort.abort();
  await expect(tool.execute("pre-abort", {}, abort.signal)).rejects.toThrow("отменено");
  expect(fixture.connection.callTool).not.toHaveBeenCalled();
  const live = new AbortController();
  const pending = tool.execute("abort", {}, live.signal);
  live.abort(); request.resolve({ content: [{ type: "text", text: "late" }] });
  await expect(pending).rejects.toThrow("отменено");
  await fixture.events.session_shutdown();
});

it("MCP errors are Pi tool failures and do not expose private SDK diagnostics", async () => {
  const fixture = setup({ callTool: vi.fn(async () => ({ isError: true, content: [{ type: "text", text: "private form value" }] })) });
  const tool = await fixture.ready();
  await expect(tool.execute("mcp-error", {})).rejects.toThrow("сообщил об ошибке");
  vi.mocked(fixture.connection.callTool).mockRejectedValueOnce(new Error("private SDK password"));
  await expect(tool.execute("sdk-error", {})).rejects.toThrow("не подключён");
  await fixture.events.session_shutdown();
});

it("passes trusted recovery screenshot and mode guidance to Pi without replaying the action", async () => {
  const fixture = setup({ callTool: vi.fn(async () => ({ isError: true, structuredContent: { desktopBrowserRecovery: true, reason: "geometry", mode: "human" }, content: [{ type: "text", text: "No input was sent. Fresh screenshot." }, { type: "image", data: "test-pixels", mimeType: "image/png" }] })) });
  const tool = await fixture.ready(); const result = await tool.execute("recovery", {});
  expect(result.content).toContainEqual({ type: "image", data: "test-pixels", mimeType: "image/png" });
  expect(fixture.connection.callTool).toHaveBeenCalledOnce();
});

it("passes argument/preparation recovery details to Pi without hiding them behind a generic exception", async () => {
  for (const reason of ["arguments", "preparation"]) {
    const fixture=setup({callTool:vi.fn(async()=>({isError:true,structuredContent:{desktopBrowserRecovery:true,reason,completed:0,noReplay:true},content:[{type:"text",text:"No requested input sent. Correct arguments or reconnect."}]}))});
    const tool=await fixture.ready();const result=await tool.execute("recover",{});
    expect(result.content).toContainEqual({type:"text",text:"No requested input sent. Correct arguments or reconnect."});
    await fixture.events.session_shutdown();
  }
});
it('does not accept model-supplied browser ownership or full access', async () => {
  const f=setup(),tool=await f.ready();
  await tool.execute('forged',{url:'https://example.com',__arvelaAccess:'full',__arvelaSession:{engine:'pi',sessionID:'other'}});
  expect(f.connection.callTool).toHaveBeenCalledWith({name:official.name,arguments:{url:'https://example.com'},_meta:{arvelaAccess:'project',arvelaSession:{engine:'pi',sessionID:'pi_test'}}},expect.anything());
});
it('full access comes only from the session access mode, evaluated per call', async () => {
  const f=setup(),tool=await f.ready();
  access='full';
  await tool.execute('full',{url:'https://example.com'});
  expect(f.connection.callTool).toHaveBeenLastCalledWith({name:official.name,arguments:{url:'https://example.com'},_meta:{arvelaAccess:'full',arvelaSession:{engine:'pi',sessionID:'pi_test'}}},expect.anything());
  await f.events.session_shutdown();
});

it("a real turn waits for initial discovery and retries its failure only once", async () => {
  const f=setup(); f.load.mockRejectedValueOnce(Error("transient discovery"));
  f.events.session_start({},f.ctx);
  await vi.waitFor(()=>expect(f.ctx.ui.notify).toHaveBeenCalledOnce());
  await f.events.before_agent_start({},f.ctx);
  expect(f.load).toHaveBeenCalledTimes(2); expect(f.tools.has("desktop_browser_browser_navigate")).toBe(true);
  await f.events.before_agent_start({},f.ctx); expect(f.load).toHaveBeenCalledTimes(2);
  expect(f.connection.callTool).not.toHaveBeenCalled(); await f.events.session_shutdown();
});
it("repeated failed discovery does not create an unbounded retry or expose private errors", async () => {
  const f=setup(); f.load.mockRejectedValue(Error("private password=fixture"));
  f.events.session_start({},f.ctx); await f.events.before_agent_start({},f.ctx); await f.events.before_agent_start({},f.ctx);
  expect(f.load).toHaveBeenCalledTimes(2); expect(f.tools.size).toBe(0);
  expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).not.toContain("password"); await f.events.session_shutdown();
});
