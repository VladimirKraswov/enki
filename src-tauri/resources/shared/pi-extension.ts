/** Shared MCP tools for SDK-hosted Pi sessions. A bridge, not an agent loop.
 *
 * Connections come from one runtime-wide pool keyed by server signature, so
 * several sessions share one MCP connection per server instead of starting a
 * duplicate process per chat. Every registered tool still passes the Enki tool
 * gate; failures are reported, never retried, because the call may already
 * have had side effects. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { toolName, signature, type SharedRegistry, type SharedServerSpec } from "./registry.mjs";

export const SAFE_ERROR = "Общий MCP недоступен. Проверьте каталог инструментов; действие не повторялось.";

export interface McpTool { name: string; description?: string; inputSchema?: { type?: string; [key: string]: unknown } }
export interface McpResult { content: Array<{ type: string; [key: string]: unknown }>; isError?: boolean; structuredContent?: unknown }

/** One live MCP connection, shared between sessions by the pool. */
export interface SharedConnection {
  tools(signal: AbortSignal): Promise<McpTool[]>;
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpResult>;
}

/** Registry scope ("global" or "project-<fnv>") and the native proxy executable. */
export interface SharedScope { registryKey: string; command: string }

export interface SharedPool {
  /** Ref-counted; `release` closes the connection when the last user leaves. */
  acquire(spec: SharedServerSpec, scope: SharedScope, cwd: string, signal: AbortSignal): Promise<{ connection: SharedConnection; release(): void }>;
}

export interface ServerStatus { id: string; signature: string; state: "checking" | "connected" | "error"; tools: string[] }

export const MCP_ERROR_CHARS = 4000;
/** Tool error text for an MCP `isError` result: the server's own text blocks
 * (bounded, untrusted data) plus the no-blind-retry rule. */
export function mcpErrorText(result: McpResult): string {
  const text = result.content.flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n").trim();
  const reason = text.length > MCP_ERROR_CHARS ? `${text.slice(0, MCP_ERROR_CHARS)}…` : text;
  return `MCP сообщил об ошибке${reason ? `: ${reason}` : "."} Не повторяйте действие вслепую.`;
}

/** Largest structuredContent kept in a tool result's persisted details. */
export const MCP_DETAILS_CHARS = 64 * 1024;
/** `details` is persisted in the SDK transcript next to `content`. Keep a
 * bounded summary: image/text payloads already travel in `content` (storing
 * the raw result duplicated every screenshot), and an oversized structured
 * payload is recorded by size only. */
export function mcpDetails(result: McpResult): { isError: boolean; blocks: string[]; structuredContent?: unknown; structuredTruncated?: { chars: number } } {
  const blocks = result.content.map((block) => String(block.type)).slice(0, 256);
  const base = { isError: result.isError === true, blocks };
  if (result.structuredContent === undefined) return base;
  let text: string | undefined;
  try { text = JSON.stringify(result.structuredContent); } catch { text = undefined; }
  if (text === undefined) return base;
  return text.length <= MCP_DETAILS_CHARS ? { ...base, structuredContent: JSON.parse(text) as unknown } : { ...base, structuredTruncated: { chars: text.length } };
}

export interface SharedOptions {
  registry(): Promise<SharedRegistry>;
  scope: SharedScope;
  pool: SharedPool;
  report(servers: ServerStatus[]): void;
  /** Tool names already claimed by built-ins and other extensions in this session. */
  reserved(): readonly string[];
}

export function attachShared(pi: ExtensionAPI, options: SharedOptions): void {
  let epoch = 0;
  let abort: AbortController | undefined;
  let held: Array<() => void> = [];
  const stop = () => {
    epoch++;
    abort?.abort();
    for (const release of held) release();
    held = [];
  };
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    stop();
    const generation = epoch;
    const cancel = new AbortController();
    abort = cancel;
    const timer = setTimeout(() => cancel.abort(), 35_000);
    // Every await below can outlive this session (shutdown/restart bump the
    // epoch; the discovery deadline aborts): nothing registers unless live, and
    // a replaced session reports/notifies nothing over its successor.
    const current = () => generation === epoch;
    const live = () => current() && !cancel.signal.aborted;
    let statuses: ServerStatus[] = [];
    try {
      const specs = (await options.registry()).servers.filter((s) => s.enabled);
      if (!current()) return;
      statuses = specs.map((s) => ({ id: s.id, signature: signature(s), state: "checking", tools: [] }));
      options.report(statuses);
      // Sequential discovery keeps startup process/memory pressure bounded.
      for (const spec of specs) {
        if (!live()) return;
        const status = statuses.find((s) => s.id === spec.id);
        try {
          const lease = await options.pool.acquire(spec, options.scope, ctx.cwd, cancel.signal);
          if (generation !== epoch) { lease.release(); return; }
          // Held from here: stop() releases it even while discovery is pending.
          held.push(lease.release);
          const tools = await lease.connection.tools(cancel.signal);
          if (!current()) return;
          if (cancel.signal.aborted || tools.length > 128) throw new Error(SAFE_ERROR);
          const taken = new Set(options.reserved());
          const names = new Set<string>();
          for (const tool of tools) {
            const name = toolName(spec.id, tool.name);
            if (names.has(name) || taken.has(name) || tool.inputSchema?.type !== "object") throw new Error(SAFE_ERROR);
            names.add(name);
          }
          for (const tool of tools)
            pi.registerTool({
              name: toolName(spec.id, tool.name),
              label: `${spec.name} · ${tool.name}`,
              description: tool.description || "Shared MCP tool",
              parameters: tool.inputSchema as TSchema,
              async execute(_id, params, signal, _update, executionContext) {
                if (generation !== epoch || signal?.aborted) throw new Error(SAFE_ERROR);
                const active = (await options.registry()).servers.find((s) => s.id === spec.id && s.enabled);
                // The lease may have been released while the registry was read.
                if (generation !== epoch || signal?.aborted) throw new Error(SAFE_ERROR);
                if (JSON.stringify(active) !== JSON.stringify(spec)) throw new Error("Подключение изменилось. Переоткройте чат, чтобы обновить инструменты.");
                const args = { ...(params as Record<string, unknown>) };
                delete args.__enkiImageContext;
                if (spec.id === "enki-images") {
                  // The session manager is authoritative even for background chats;
                  // never accept a session identity supplied by the model.
                  const sessionID = (executionContext ?? ctx).sessionManager.getSessionId();
                  if (!/^[A-Za-z0-9_-]{1,200}$/.test(sessionID)) throw new Error(SAFE_ERROR);
                  args.__enkiImageContext = { engine: "pi", sessionID };
                }
                let result: McpResult;
                try { result = await lease.connection.call(tool.name, args, signal); }
                catch { throw new Error(signal?.aborted ? "Действие MCP отменено." : SAFE_ERROR); }
                // The server's own explanation (attempt limits, missing Vision,
                // provider failures with retryAt) is what the model must act on.
                if (result.isError) throw new Error(mcpErrorText(result));
                const content = result.content.flatMap<TextContent | ImageContent>((block) =>
                  block.type === "text" && typeof block.text === "string" ? [{ type: "text" as const, text: block.text }]
                  : block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string" ? [{ type: "image" as const, data: block.data, mimeType: block.mimeType }]
                  : []);
                return { content, details: { mcp: mcpDetails(result) } };
              },
            });
          if (status) Object.assign(status, { state: "connected", tools: [...names] });
          options.report(statuses);
        } catch {
          if (!current()) return;
          if (status) status.state = "error";
          options.report(statuses);
          ctx.ui.notify(`${spec.name}: ${SAFE_ERROR}`, "warning");
        }
      }
    } catch {
      if (current()) ctx.ui.notify(SAFE_ERROR, "warning");
    } finally {
      clearTimeout(timer);
      if (generation === epoch && statuses.some((s) => s.state === "checking")) {
        for (const status of statuses) if (status.state === "checking") status.state = "error";
        options.report(statuses);
      }
    }
  });
  pi.on("session_shutdown", () => stop());
}
export default attachShared;
