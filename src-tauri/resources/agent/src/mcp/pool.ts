// One MCP connection per (registry scope, server signature), shared by every
// session that uses the server.
//
// The connection goes through Enki's native `--shared-mcp` stdio proxy, which
// resolves vault credentials, remote URLs and environment itself; this runtime
// never sees an MCP secret. Lifecycle: created on first acquire, reused while
// referenced, closed shortly after the last session releases it, recreated on
// the next acquire if the transport died. Calls are never retried here.

import path from "node:path";
import { canonicalJson } from "../protocol.ts";
import { profileEnvironment, signature, type SharedServerSpec } from "../../../shared/registry.mjs";
import type { McpResult, McpTool, SharedConnection, SharedPool, SharedScope } from "../../../shared/pi-extension.ts";

export interface McpClientLike {
  connect(signal: AbortSignal): Promise<void>;
  listTools(signal: AbortSignal, cursor?: string): Promise<{ tools: McpTool[]; nextCursor?: string }>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpResult>;
  close(): Promise<void>;
  onClose(handler: () => void): void;
}

export type McpClientFactory = (command: string, args: string[], cwd: string) => Promise<McpClientLike>;

type Block = { type: string; [key: string]: unknown };
const isBlock = (value: unknown): value is Block =>
  !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";

/** Production factory: the official MCP SDK over the native stdio proxy. The
 * SDK's default child environment drops ENKI_PROFILE_DIR; the native proxy
 * gets exactly this installation's profile identity on top of it, nothing else. */
export const officialClient: McpClientFactory = async (command, args, cwd) => {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);
  const client = new Client({ name: "enki-runtime-shared", version: "1.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command, args, cwd, env: profileEnvironment(), stderr: "ignore" });
  let closed: (() => void) | undefined;
  client.onclose = () => closed?.();
  return {
    connect: (signal) => client.connect(transport, { signal, timeout: 10_000 }),
    listTools: async (signal, cursor) => {
      const listed = await client.listTools(cursor !== undefined ? { cursor } : {}, { signal, timeout: 10_000 });
      return {
        tools: listed.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        nextCursor: listed.nextCursor,
      };
    },
    callTool: async (name, args, signal) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 90_000 });
      const content = "content" in result && Array.isArray(result.content) ? result.content.filter(isBlock) : [];
      return {
        content,
        isError: "isError" in result && result.isError === true,
        structuredContent: "structuredContent" in result ? result.structuredContent : undefined,
      };
    },
    close: () => client.close(),
    onClose: (handler) => { closed = handler; },
  };
};

export interface PoolStatus { key: string; server: string; refs: number; state: "connecting" | "connected" | "closed" }

interface Ready { client: McpClientLike; tools: McpTool[] }
function cancelled(): Error { return new Error("Подключение MCP отменено."); }
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(cancelled()); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}
async function closeClient(client: McpClientLike): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([client.close(), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]); }
  catch { /* Only our proxy is closed. Never retry a tool or kill a foreign process. */ }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
function shape(tools: McpTool[]): string {
  return canonicalJson(tools.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema ?? null })).sort((a, b) => a.name.localeCompare(b.name)));
}
class PooledConnection {
  refs = 0;
  inFlight = 0;
  dead = false;
  state: PoolStatus["state"] = "connecting";
  idle?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
  closeFinished = false;
  readonly abort = new AbortController();
  readonly ready: Promise<Ready>;
  constructor(readonly key: string, readonly server: string, open: (self: PooledConnection) => Promise<Ready>) { this.ready = open(this); }
}

export class McpPool implements SharedPool {
  private entries = new Map<string, PooledConnection>();
  private closed = false;
  private admission = true;
  private closing = 0;
  private live = new Set<PooledConnection>();
  constructor(private readonly factory: McpClientFactory = officialClient, private readonly idleMs = 30_000,
    private readonly discoveryMs = 30_000) {}

  private async open(self: PooledConnection, command: string, registryKey: string, spec: SharedServerSpec, cwd: string): Promise<Ready> {
    let client: McpClientLike | undefined;
    const signal = self.abort.signal;
    const deadline = setTimeout(() => self.abort.abort(), Math.max(1, Math.min(this.discoveryMs, 30_000)));
    try {
      const opening = this.factory(command, ["--shared-mcp", registryKey, spec.id], cwd);
      // A factory resolving after cancellation still relinquishes its own proxy.
      void opening.then(value => { if (signal.aborted) void this.closeOpeningProxy(value); }, () => {});
      client = await waitFor(opening, signal);
      client.onClose(() => { self.dead = true; self.state = "closed"; self.abort.abort(); });
      await waitFor(client.connect(signal), signal);
      const tools: McpTool[] = [], names = new Set<string>(), cursors = new Set<string>();
      let cursor: string | undefined, bytes = 0;
      for (let page = 0; page < 4; page++) {
        const listed = await waitFor(client.listTools(signal, cursor), signal);
        if (!Array.isArray(listed.tools) || tools.length + listed.tools.length > 128) throw new Error("MCP вернул слишком много инструментов.");
        for (const tool of listed.tools) {
          if (typeof tool.name !== "string" || !tool.name || tool.name.length > 256 || names.has(tool.name)) throw new Error("MCP вернул повторяющееся или неверное имя инструмента.");
          bytes += Buffer.byteLength(canonicalJson(tool), "utf8");
          if (bytes > 1024 * 1024) throw new Error("Описания инструментов MCP превышают допустимый размер.");
          names.add(tool.name); tools.push(tool);
        }
        cursor = listed.nextCursor;
        if (cursor === undefined) break;
        if (typeof cursor !== "string" || cursor.length > 4096 || cursors.has(cursor)) throw new Error("MCP повторил указатель страницы инструментов.");
        cursors.add(cursor);
      }
      if (cursor !== undefined) throw new Error("MCP вернул слишком длинный список инструментов.");
      if (self.dead || signal.aborted) throw cancelled();
      self.state = "connected";
      return { client, tools };
    } catch (error) {
      self.dead = true; self.state = "closed";
      if (client) await this.closeOpeningProxy(client);
      throw error;
    } finally { clearTimeout(deadline); }
  }
  private async closeOpeningProxy(client: McpClientLike): Promise<void> {
    this.closing++;
    try { await closeClient(client); } finally { this.closing--; }
  }
  private entry(key: string, command: string, scope: SharedScope, spec: SharedServerSpec, cwd: string): PooledConnection {
    let entry = this.entries.get(key);
    if (!entry || entry.dead) {
      entry = new PooledConnection(key, spec.id, self => this.open(self, command, scope.registryKey, spec, cwd));
      this.entries.set(key, entry); this.live.add(entry);
      // A caller aborts independently of shared discovery; avoid an unhandled
      // ready rejection if the last lease leaves before opening completes.
      void entry.ready.catch(() => {});
    }
    return entry;
  }
  private retain(entry: PooledConnection): void {
    entry.refs++;
    if (entry.idle !== undefined) { clearTimeout(entry.idle); entry.idle = undefined; }
  }
  private release(entry: PooledConnection): void { entry.refs = Math.max(0, entry.refs - 1); this.idle(entry); }
  private idle(entry: PooledConnection): void {
    if (entry.refs || entry.inFlight || entry.idle !== undefined || entry.closing) return;
    if (entry.state === "connecting") { entry.abort.abort(); void this.close(entry); return; }
    entry.idle = setTimeout(() => { entry.idle = undefined; void this.close(entry); }, Math.max(0, this.idleMs));
    entry.idle.unref?.();
  }
  async acquire(spec: SharedServerSpec, scope: SharedScope, cwd: string, signal: AbortSignal): Promise<{ connection: SharedConnection; release(): void }> {
    const { command, registryKey } = scope;
    if (!this.admission || this.closed || signal.aborted) throw cancelled();
    if (!command || !path.isAbsolute(command)) throw new Error("Общие инструменты MCP недоступны: нет пути к Enki.");
    if (registryKey !== "global" && !/^project-[0-9a-f]{16}$/.test(registryKey)) throw new Error("Некорректная область общих инструментов.");
    const key = canonicalJson([command, registryKey, spec.id, signature(spec)]);
    let current = this.entry(key, command, scope, spec, cwd), released = false;
    this.retain(current);
    const release = () => { if (!released) { released = true; this.release(current); } };
    try {
      const initial = await waitFor(current.ready, signal), expectedShape = shape(initial.tools);
      const ensure = async (callSignal?: AbortSignal): Promise<{ entry: PooledConnection; ready: Ready }> => {
        if (released || !this.admission || this.closed || callSignal?.aborted) throw cancelled();
        if (current.dead) {
          this.release(current);
          current = this.entry(key, command, scope, spec, cwd); this.retain(current);
        }
        const owned = current, ready = await waitFor(owned.ready, callSignal);
        if (released || !this.admission || this.closed || owned.dead || callSignal?.aborted) throw cancelled();
        if (shape(ready.tools) !== expectedShape) throw new Error("Список инструментов MCP изменился. Обновите инструменты чата перед новым действием.");
        return { entry: owned, ready };
      };
      return { connection: {
        tools: async toolSignal => (await ensure(toolSignal)).ready.tools,
        call: async (name, args, callSignal) => {
          const { entry, ready } = await ensure(callSignal);
          if (released || !this.admission || this.closed || entry.dead || callSignal?.aborted) throw cancelled();
          if (!ready.tools.some(tool => tool.name === name)) throw new Error("Инструмент MCP не найден в проверенном списке.");
          entry.inFlight++;
          try {
            // Exactly ONE send. A rejected/uncertain call is never replayed.
            // Only a later, distinct invocation may reconnect a dead transport.
            return await ready.client.callTool(name, args, callSignal);
          } finally { entry.inFlight--; if (entry.closeFinished && !entry.inFlight) this.live.delete(entry); this.idle(entry); }
        },
      }, release };
    } catch (error) { release(); throw error; }
  }
  private close(entry: PooledConnection, force = false): Promise<void> {
    if (!force && (entry.refs || entry.inFlight)) return Promise.resolve();
    if (entry.closing) return entry.closing;
    if (entry.idle !== undefined) { clearTimeout(entry.idle); entry.idle = undefined; }
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    entry.dead = true; entry.state = "closed"; entry.abort.abort(); this.closing++;
    entry.closing = (async () => {
      const ready = await entry.ready.catch(() => null);
      if (ready) await closeClient(ready.client);
    })().finally(() => {
      this.closing--; entry.closeFinished = true;
      if (!entry.inFlight) this.live.delete(entry);
    });
    return entry.closing;
  }
  /** Fence new work before an authoritative maintenance-idle check. */
  setAdmission(open: boolean): void { this.admission = open; }
  activity(): { connecting: number; calls: number; closing: number } {
    return {
      connecting: [...this.live].filter(entry => entry.state === "connecting").length,
      calls: [...this.live].reduce((sum, entry) => sum + entry.inFlight, 0),
      closing: this.closing,
    };
  }
  status(): PoolStatus[] { return [...this.entries.values()].map(entry => ({ key: entry.key, server: entry.server, refs: entry.refs, state: entry.state })); }
  async closeAll(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.live].map(entry => { entry.refs = 0; return this.close(entry, true); }));
  }
}
