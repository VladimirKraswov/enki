// Native-Node composition of the built-in extensions (final integration).
// Qualification found that public Node/crash children could not load
// resources/pi/lsp-extension.ts: it value-imported `typebox`, which only the
// agent package declares. The LSP extension now lives in agent/src; every
// sibling extension source may use bare packages for TYPES only (erased), so
// native Node never needs an ambient/relative node_modules fallback.
// Written, NOT RUN.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const resources = path.resolve(here, "../..");
const SIBLINGS = ["shared/pi-extension.ts", "browser/pi-extension.ts", "pi/tool-gate.ts"];

/** Import/export-from declarations whose specifier is a bare package (not relative, not node:). */
function bareValueImports(source: string): string[] {
  const found: string[] = [];
  const declaration = /^\s*(import|export)\s+([^;]*?)\s+from\s+["']([^"']+)["']/gm;
  for (const match of source.matchAll(declaration)) {
    const [, keyword, clause, specifier] = match;
    if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
    if (clause.startsWith("type ")) continue; // whole declaration erased by type stripping
    found.push(`${keyword} ${clause} from ${specifier}`);
  }
  for (const match of source.matchAll(/^\s*import\s+["']([^"'.][^"']*)["']/gm)) if (!match[1].startsWith("node:")) found.push(`import ${match[1]}`);
  return found;
}

test("sibling extension sources carry no runtime bare-package import", () => {
  for (const relative of SIBLINGS) {
    const file = path.join(resources, relative);
    assert.ok(fs.existsSync(file), relative);
    assert.deepEqual(bareValueImports(fs.readFileSync(file, "utf8")), [], relative);
  }
  // The scanner itself is not vacuous.
  assert.deepEqual(bareValueImports('import { Type } from "typebox";\nimport type { X } from "y";\n'), ["import { Type } from typebox"]);
});

test("the extension graph loads natively from the actual source topology", async () => {
  const enki = await import("../src/extensions/enki.ts");
  assert.equal(typeof enki.enkiExtensions, "function");
  const lsp = await import("../src/extensions/lsp.ts");
  const tools: string[] = [];
  lsp.attachLsp({ on: () => undefined, registerTool: (tool: { name: string }) => { tools.push(tool.name); } } as never, { servers: [] });
  assert.deepEqual(tools, ["lsp_diagnostics", "lsp_hover", "lsp_definition"]);
  if (process.platform !== "win32") assert.equal(lsp.locationPath("file:///tmp/a%20b.ts"), "/tmp/a b.ts");
  else assert.equal(lsp.locationPath("file:///C:/a%20b.ts"), "C:\\a b.ts");
  assert.equal(lsp.locationPath("untitled:x"), "untitled:x");
});

// Fake stdio language server: answers initialize; on didOpen/didChange first
// publishes a STALE result for the previous version, then the current one.
const FAKE_SERVER = String.raw`
let buffer = Buffer.alloc(0);
const send = (m) => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write("Content-Length: " + b.length + "\r\n\r\n"); process.stdout.write(b); };
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const sep = buffer.indexOf("\r\n\r\n"); if (sep < 0) return;
    const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, sep).toString())[1]);
    if (buffer.length < sep + 4 + length) return;
    const msg = JSON.parse(buffer.subarray(sep + 4, sep + 4 + length).toString()); buffer = buffer.subarray(sep + 4 + length);
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
    const doc = msg.params && msg.params.textDocument;
    const text = msg.method === "textDocument/didOpen" ? doc.text : msg.method === "textDocument/didChange" ? msg.params.contentChanges[0].text : null;
    if (text !== null) {
      if (doc.version > 1) send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: doc.uri, version: doc.version - 1, diagnostics: [{ message: "stale", severity: 1 }] } });
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: doc.uri, version: doc.version, diagnostics: [{ message: msg.method + ":" + doc.version + ":" + text.trim(), severity: 1 }] } });
    }
  }
});
`;

test("diagnostics after an edit report the edited text, never the cached pre-edit result", async (t) => {
  const harness = process.env.ENKI_SDK_HARNESS_ROOT; assert.ok(harness);
  const root = fs.mkdtempSync(path.join(harness, "tmp/lsp-"));
  const server = path.join(root, "fake-lsp.mjs"); fs.writeFileSync(server, FAKE_SERVER);
  const project = path.join(root, "project"); fs.mkdirSync(project); fs.writeFileSync(path.join(project, "a.ts"), "first");
  const { attachLsp } = await import("../src/extensions/lsp.ts");
  const handlers = new Map<string, () => Promise<void>>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>();
  attachLsp({ on: (name: string, handler: () => Promise<void>) => { handlers.set(name, handler); },
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }) => { tools.set(tool.name, tool); } } as never,
  { servers: [{ id: "fake", command: process.execPath, args: [server], extensions: [".ts"], languageId: "typescript" }] });
  t.after(async () => { await handlers.get("session_shutdown")?.(); });
  const check = async () => (await tools.get("lsp_diagnostics")!.execute("c", { path: "a.ts" }, undefined, undefined, { cwd: project })).content[0].text;
  assert.match(await check(), /textDocument\/didOpen:1:first/);
  fs.writeFileSync(path.join(project, "a.ts"), "second");
  const edited = await check();
  assert.match(edited, /textDocument\/didChange:2:second/);
  assert.doesNotMatch(edited, /stale|first/);
});

// Final seam review: a language server that dies is reported truthfully (never
// "no issues"), its dead pipe raises no unhandled stream error, and the next
// call starts it again instead of timing out on the old process forever.
const CRASHING_SERVER = FAKE_SERVER.replace("if (text !== null) {", "if (text !== null && text.trim() === \"CRASH\") process.exit(3);\n    if (text !== null) {");

test("a server that exits is reported as ended and the next call starts a fresh one", async (t) => {
  const harness = process.env.ENKI_SDK_HARNESS_ROOT; assert.ok(harness);
  assert.notEqual(CRASHING_SERVER, FAKE_SERVER);
  const root = fs.mkdtempSync(path.join(harness, "tmp/lsp-crash-"));
  const server = path.join(root, "fake-lsp.mjs"); fs.writeFileSync(server, CRASHING_SERVER);
  const project = path.join(root, "project"); fs.mkdirSync(project); fs.writeFileSync(path.join(project, "a.ts"), "CRASH");
  const { attachLsp } = await import("../src/extensions/lsp.ts");
  const handlers = new Map<string, () => Promise<void>>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>();
  attachLsp({ on: (name: string, handler: () => Promise<void>) => { handlers.set(name, handler); },
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }) => { tools.set(tool.name, tool); } } as never,
  { servers: [{ id: "fake", command: process.execPath, args: [server], extensions: [".ts"], languageId: "typescript" }] });
  t.after(async () => { await handlers.get("session_shutdown")?.(); });
  const check = async () => (await tools.get("lsp_diagnostics")!.execute("c", { path: "a.ts" }, undefined, undefined, { cwd: project })).content[0].text;
  const started = Date.now();
  await assert.rejects(check(), /fake: сервер завершился \(код 3\)/);
  assert.ok(Date.now() - started < 8_000, "reported at the exit, not after the diagnostics wait");
  fs.writeFileSync(path.join(project, "a.ts"), "fine");
  // A fresh process: the document is opened again as version 1.
  assert.match(await check(), /textDocument\/didOpen:1:fine/);
});

interface RpcFrame {
  id?: number;
  method?: string;
  params?: { textDocument?: { uri?: string; version?: number } };
}

/** In-process stdio only: kill records a signal; it never touches an OS PID. */
class ControlledLspChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 2_147_483_647; // synthetic; the fake kill implementation never signals it
  exitCode: number | null = null;
  readonly signalCode = null;
  readonly signals: NodeJS.Signals[] = [];
  readonly messages: RpcFrame[] = [];
  private buffer: Buffer = Buffer.alloc(0);
  private waiting: Array<{ method: string; count: number; resolve: (message: RpcFrame) => void }> = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const separator = this.buffer.indexOf("\r\n\r\n");
        if (separator < 0) return;
        const match = /content-length:\s*(\d+)/i.exec(this.buffer.subarray(0, separator).toString("ascii"));
        assert.ok(match, "client sent Content-Length framing");
        const length = Number(match[1]);
        const start = separator + 4;
        if (this.buffer.length < start + length) return;
        const frame = JSON.parse(this.buffer.subarray(start, start + length).toString("utf8")) as RpcFrame;
        this.buffer = this.buffer.subarray(start + length);
        this.messages.push(frame);
        const waiting = this.waiting;
        this.waiting = [];
        for (const entry of waiting) {
          const message = this.received(entry.method)[entry.count - 1];
          if (message) entry.resolve(message);
          else this.waiting.push(entry);
        }
      }
    });
  }

  received(method: string): RpcFrame[] { return this.messages.filter((message) => message.method === method); }

  waitForMessage(method: string, count = 1): Promise<RpcFrame> {
    const message = this.received(method)[count - 1];
    return message ? Promise.resolve(message) : new Promise((resolve) => this.waiting.push({ method, count, resolve }));
  }

  send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message));
    this.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }

  reply(id: number, result: unknown): void { this.send({ jsonrpc: "2.0", id, result }); }

  publish(uri: string, message: string): void {
    this.send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: {
      uri, version: 1, diagnostics: [{ message, severity: 1 }],
    } });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean { this.signals.push(signal); return true; }

  finish(code = 0): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

type LspTool = { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> };

async function controlledLsp(t: TestContext, synchronousSpawnFailures = 0) {
  const harness = process.env.ENKI_SDK_HARNESS_ROOT; assert.ok(harness);
  const project = fs.mkdtempSync(path.join(harness, "tmp/lsp-controlled-"));
  fs.writeFileSync(path.join(project, "a.ts"), "fixture");
  const children: ControlledLspChild[] = [];
  const handlers = new Map<string, () => Promise<void>>();
  const tools = new Map<string, LspTool>();
  const { attachLsp } = await import("../src/extensions/lsp.ts");
  // The cast is solely the injected ChildProcess transport boundary. The
  // fixture has real streams/events, and cannot spawn or signal any process.
  const spawnServer = (() => {
    if (synchronousSpawnFailures-- > 0) throw new Error("synchronous fixture spawn failure");
    const child = new ControlledLspChild(); children.push(child);
    return child as unknown as ChildProcess;
  }) as typeof spawn;
  attachLsp({
    on: (name: string, handler: () => Promise<void>) => { handlers.set(name, handler); },
    registerTool: (tool: LspTool & { name: string }) => { tools.set(tool.name, tool); },
  } as never, {
    servers: [{ id: "controlled", command: process.execPath, extensions: [".ts"], languageId: "typescript" }],
  }, spawnServer);
  const shutdown = async () => { await handlers.get("session_shutdown")?.(); };
  t.after(async () => {
    await shutdown();
    for (const child of children) {
      child.finish(); // clears the production escalation timer without an OS signal
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    }
    fs.rmSync(project, { recursive: true, force: true });
  });
  const call = (name: string, params: { path: string; line?: number; character?: number } = { path: "a.ts" }) => {
    const tool = tools.get(name); assert.ok(tool);
    return tool.execute("fixture-call", params, undefined, undefined, { cwd: project });
  };
  return { children, call, shutdown, uri: pathToFileURL(path.join(project, "a.ts")).href };
}

function requestId(message: RpcFrame): number { assert.equal(typeof message.id, "number"); return message.id!; }
const eventTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("late events from a stopped initializing LSP cannot settle or stop its successor", { timeout: 2_000 }, async (t) => {
  const h = await controlledLsp(t);
  const first = h.call("lsp_diagnostics");
  const predecessor = h.children[0]; assert.ok(predecessor);
  await predecessor.waitForMessage("initialize");
  // A predecessor's unfinished frame must not prefix the successor's stream.
  predecessor.stdout.write('Content-Length: 90\r\n\r\n{"unfinished":');
  const rejected = assert.rejects(first, /first initialization ended/);
  predecessor.emit("error", new Error("first initialization ended"));
  await rejected;

  const second = h.call("lsp_diagnostics");
  const successor = h.children[1]; assert.ok(successor);
  const initialize = await successor.waitForMessage("initialize");
  let settlement = "pending";
  void second.then(() => { settlement = "fulfilled"; }, () => { settlement = "rejected"; });
  // Deliberately use the SUCCESSOR's request ID: transport identity, not the
  // JSON-RPC number alone, must protect the pending initialization.
  predecessor.reply(requestId(initialize), { capabilities: {} });
  predecessor.publish(h.uri, "stale predecessor diagnostics");
  predecessor.emit("error", new Error("late predecessor error"));
  predecessor.finish(7);
  await eventTurn();
  assert.equal(settlement, "pending");
  assert.equal(successor.received("initialized").length, 0);
  assert.equal(successor.received("textDocument/didOpen").length, 0);
  assert.deepEqual(successor.signals, []);

  successor.reply(requestId(initialize), { capabilities: {} });
  const opened = await successor.waitForMessage("textDocument/didOpen");
  assert.equal(opened.params?.textDocument?.version, 1);
  predecessor.publish(h.uri, "stale after successor open");
  await eventTurn();
  assert.equal(settlement, "pending", "old diagnostics cannot satisfy the successor's waiter");
  successor.publish(h.uri, "successor-only diagnostics");
  const result = await second;
  assert.match(result.content[0].text, /successor-only diagnostics/);
  assert.doesNotMatch(result.content[0].text, /stale/);
  assert.equal(h.children.length, 2);
  assert.equal(successor.received("initialized").length, 1);
  assert.equal(successor.received("textDocument/didOpen").length, 1);
  assert.equal(successor.received("textDocument/didChange").length, 0);
  assert.deepEqual(successor.signals, []);
});

test("LSP failure rejects both an initialized pending request and a diagnostics waiter", { timeout: 2_000 }, async (t) => {
  const h = await controlledLsp(t);
  const hover = h.call("lsp_hover", { path: "a.ts", line: 1, character: 1 });
  const child = h.children[0]; assert.ok(child);
  child.reply(requestId(await child.waitForMessage("initialize")), { capabilities: {} });
  await child.waitForMessage("textDocument/hover");
  const diagnostics = h.call("lsp_diagnostics");
  await child.waitForMessage("textDocument/didChange");
  await eventTurn();
  const hoverRejected = assert.rejects(hover, /initialized fixture failed/);
  const diagnosticsRejected = assert.rejects(diagnostics, /initialized fixture failed/);
  child.emit("error", new Error("initialized fixture failed"));
  await Promise.all([hoverRejected, diagnosticsRejected]);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  child.finish(9);
});

test("session shutdown rejects pending LSP initialization and initialized requests", { timeout: 2_000 }, async (t) => {
  const h = await controlledLsp(t);
  const starting = h.call("lsp_diagnostics");
  const first = h.children[0]; assert.ok(first);
  await first.waitForMessage("initialize");
  const startingRejected = assert.rejects(starting, /controlled: сервер остановлен/);
  await h.shutdown();
  await startingRejected;
  first.finish();

  const hover = h.call("lsp_hover", { path: "a.ts", line: 1, character: 1 });
  const next = h.children[1]; assert.ok(next);
  next.reply(requestId(await next.waitForMessage("initialize")), { capabilities: {} });
  await next.waitForMessage("textDocument/hover");
  const hoverRejected = assert.rejects(hover, /controlled: сервер остановлен/);
  await h.shutdown();
  await hoverRejected;
  next.finish();
});

test("a synchronous LSP spawn failure permits a fresh bounded initialization", { timeout: 2_000 }, async (t) => {
  const h = await controlledLsp(t, 1);
  await assert.rejects(h.call("lsp_diagnostics"), /synchronous fixture spawn failure/);
  const next = h.call("lsp_diagnostics");
  assert.equal(h.children.length, 1);
  const child = h.children[0];
  child.reply(requestId(await child.waitForMessage("initialize")), { capabilities: {} });
  await child.waitForMessage("textDocument/didOpen");
  child.publish(h.uri, "recovered after spawn failure");
  assert.match((await next).content[0].text, /recovered after spawn failure/);
});
