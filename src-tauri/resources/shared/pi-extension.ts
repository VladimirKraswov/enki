/** Generic bridge, not an agent loop. Discovery starts on session_start only.
 * All registered tools still pass Desktop's Pi approval gate. */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { readRegistry, toolName, signature } from "./registry.mjs";
import { isAbsolute } from "node:path";
const safeError =
  "Общий MCP недоступен. Проверьте каталог инструментов; действие не повторялось.";
export async function loadConnection(
  command: string,
  key: string,
  id: string,
  cwd: string,
) {
  const clientModule = "@modelcontextprotocol/sdk/client/index.js",
    transportModule = "@modelcontextprotocol/sdk/client/stdio.js";
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(clientModule),
    import(transportModule),
  ]);
  const client = new Client(
    { name: "enki-pi-shared", version: "1.0.0" },
    { capabilities: {} },
  );
  return {
    connect: (signal: AbortSignal) =>
      client.connect(
        new StdioClientTransport({
          command,
          args: ["--shared-mcp", key, id],
          cwd,
          stderr: "ignore",
          maxBufferSize: 8 * 1024 * 1024,
        }),
        { signal, timeout: 10000 },
      ),
    list: (signal: AbortSignal) =>
      client.listTools({}, { signal, timeout: 10000 }),
    call: (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
      client.callTool({ name, arguments: args }, undefined, {
        signal,
        timeout: 90000,
      }),
    close: () => client.close(),
  };
}
export function attachShared(pi: ExtensionAPI, load = loadConnection) {
  let epoch = 0,
    abort: AbortController | undefined;
  const report = (servers: unknown[]) => {
    process.stdout.write(
      JSON.stringify({ type: "mesh_capability_status", servers }) + "\n",
    );
  };
  const owned = new Set<Awaited<ReturnType<typeof loadConnection>>>();
  const stop = async () => {
    epoch++;
    abort?.abort();
    await Promise.all([...owned].map((c) => c.close().catch(() => {})));
    owned.clear();
  };
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    await stop();
    const generation = epoch,
      cancel = new AbortController();
    abort = cancel;
    const timer = setTimeout(() => cancel.abort(), 35000);
    const root = process.env.MESH_CAPABILITIES_ROOT,
      key = process.env.MESH_CAPABILITIES_KEY,
      command = process.env.MESH_CAPABILITIES_COMMAND;
    if (!root || !key || !command || !isAbsolute(command)) {
      clearTimeout(timer);
      return;
    }
    let statuses: {
      id: string;
      signature: string;
      state: string;
      tools: string[];
    }[] = [];
    try {
      const specs = (await readRegistry(root, key)).servers.filter(
        (s) => s.enabled,
      );
      statuses = specs.map((s) => ({
        id: s.id,
        signature: signature(s),
        state: "checking",
        tools: [] as string[],
      }));
      report(statuses);
      // Bounded sequential discovery keeps startup memory/process pressure low.
      for (const spec of specs) {
        if (generation !== epoch || cancel.signal.aborted) return;
        const c = await load(command, key, spec.id, ctx.cwd);
        owned.add(c);
        try {
          await c.connect(cancel.signal);
          const listed = await c.list(cancel.signal);
          if (generation !== epoch || cancel.signal.aborted) {
            await c.close();
            owned.delete(c);
            return;
          }
          if (listed.nextCursor || listed.tools.length > 128)
            throw new Error(safeError);
          const names = new Set<string>();
          for (const tool of listed.tools) {
            const name = toolName(spec.id, tool.name);
            if (names.has(name) || tool.inputSchema?.type !== "object")
              throw new Error(safeError);
            names.add(name);
          }
          for (const tool of listed.tools)
            pi.registerTool({
              name: toolName(spec.id, tool.name),
              label: `${spec.name} · ${tool.name}`,
              description: tool.description || "Shared MCP tool",
              parameters: tool.inputSchema as TSchema,
              async execute(_id, params, signal, _update, executionContext) {
                if (generation !== epoch || signal?.aborted)
                  throw new Error(safeError);
                const active = (await readRegistry(root, key)).servers.find(
                  (s) => s.id === spec.id && s.enabled,
                );
                if (JSON.stringify(active) !== JSON.stringify(spec))
                  throw new Error(
                    "Подключение изменилось. Переоткройте сессию Pi.",
                  );
                let result;
                try {
                  const arguments_ = { ...params as Record<string, unknown> };
                  if (spec.id === 'enki-images') {
                    // SessionManager is authoritative even for background chats;
                    // never accept a session identity supplied by the model.
                    const sessionID = (executionContext ?? ctx).sessionManager.getSessionId();
                    if (!/^[A-Za-z0-9_-]{1,200}$/.test(sessionID)) throw new Error(safeError);
                    arguments_.__enkiImageContext = { engine: 'pi', sessionID };
                  }
                  result = await c.call(
                    tool.name,
                    arguments_,
                    signal,
                  );
                } catch {
                  throw new Error(safeError);
                }
                if (result.isError)
                  throw new Error(
                    "MCP сообщил об ошибке. Проверьте результат; не повторяйте действие вслепую.",
                  );
                return {
                  content: result.content.filter(
                    (b) => b.type === "text" || b.type === "image",
                  ) as any,
                  details: { mcp: result },
                };
              },
            });
          Object.assign(statuses.find((s) => s.id === spec.id)!, {
            state: "connected",
            tools: listed.tools.map((t) => toolName(spec.id, t.name)),
          });
          report(statuses);
        } catch {
          Object.assign(statuses.find((s) => s.id === spec.id)!, {
            state: "error",
          });
          report(statuses);
          await c.close().catch(() => {});
          owned.delete(c);
          ctx.ui.notify(`${spec.name}: ${safeError}`, "warning");
        }
      }
    } catch {
      ctx.ui.notify(safeError, "warning");
    } finally {
      clearTimeout(timer);
      if (
        generation === epoch &&
        statuses.some((s) => s.state === "checking")
      ) {
        for (const status of statuses)
          if (status.state === "checking") status.state = "error";
        report(statuses);
      }
    }
  });
  pi.on("session_shutdown", () => stop());
}
export default attachShared;
