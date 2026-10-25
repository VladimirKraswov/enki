// Remainder review: a browser tool result keeps the screenshot in `content`
// (what the model sees) and persists only a bounded summary in `details`
// (it previously stored the whole raw MCP result: every screenshot twice).
// Injected loader; no browser, process or network. Written, NOT RUN.
import { expect, it } from "vitest";
import { attachBrowser, BROWSER_DETAILS_CHARS, browserDetails, type BrowserConnection } from "../../browser/pi-extension.ts";
import { evictableSession, sessionKey } from "../../browser/session.mjs";

type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; data?: string; text?: string }>; details: { mcp: Record<string, unknown> } }> };

it("browser results persist a bounded summary; the screenshot stays only in content", async () => {
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {}, tools = new Map<string, Tool>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers[name] = handler; }, registerTool: (tool: Tool) => { tools.set(tool.name, tool); } };
  const screenshot = "P".repeat(300_000);
  const connection: BrowserConnection = {
    connect: async () => undefined,
    listTools: async () => ({ tools: [{ name: "browser_observe", inputSchema: { type: "object", properties: {} } }] }),
    callTool: async () => ({ content: [{ type: "text", text: "page" }, { type: "image", data: screenshot, mimeType: "image/png" }], structuredContent: { completed: 1 } }),
    close: async () => undefined,
  };
  attachBrowser(pi as never, { command: () => "/abs/enki", access: () => "project" }, async () => connection);
  const ctx = { cwd: "/abs/project", ui: { notify: () => undefined }, sessionManager: { getSessionId: () => "s1" } };
  handlers.session_start!({}, ctx);
  for (let i = 0; i < 100 && !tools.size; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const tool = tools.get("desktop_browser_browser_observe")!;
  const result = await tool.execute("id", {}, new AbortController().signal, undefined, ctx);
  expect(result.content.find((block) => block.type === "image")?.data).toBe(screenshot);
  expect(result.details.mcp).toEqual({ isError: false, blocks: ["text", "image"], structuredContent: { completed: 1 } });
  expect(JSON.stringify(result.details).length).toBeLessThan(1_000);
  const big = browserDetails({ content: [], structuredContent: { snapshot: "x".repeat(BROWSER_DETAILS_CHARS + 1) } });
  expect(big.structuredContent).toBeUndefined();
  expect(big.structuredTruncated!.chars).toBeGreaterThan(BROWSER_DETAILS_CHARS);
  await handlers.session_shutdown!({}, ctx);
});

// Remainder review: the daemon's 32-session bound used to be permanent until a
// manual restart; now only a provably idle session is released, oldest first.
it("the browser daemon releases only an idle, unselected session when its session bound is reached", () => {
  const key = (id: string) => sessionKey("/abs/project", { engine: "pi", sessionID: id });
  const sessions = [
    { key: key("selected"), lastUsed: 1 },
    { key: key("open-browser"), lastUsed: 2, context: {} },
    { key: key("running"), lastUsed: 3, busy: 1 },
    { key: key("composing"), lastUsed: 4, composition: {} },
    { key: key("idle-new"), lastUsed: 9 },
    { key: key("idle-old"), lastUsed: 5 },
  ];
  expect(evictableSession(sessions, key("selected"))?.key).toBe(key("idle-old"));
  // Nothing idle: the daemon keeps refusing explicitly instead of closing a live session.
  expect(evictableSession(sessions.slice(0, 4), key("selected"))).toBeUndefined();
  // Session identity stays per chat: other chats never share a key.
  expect(key("a")).not.toBe(key("b"));
  expect(() => sessionKey("/abs/project", { engine: "pi", sessionID: "../x" })).toThrow();
});
