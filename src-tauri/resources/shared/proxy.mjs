// Agent permissions remain with the caller. This proxy never retries a call or
// invokes upstream tools during discovery. No arguments/results are logged.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { connectServer } from "./client.mjs";
import { readRegistry, validId } from "./registry.mjs";
const [root, key, id, mode] = process.argv.slice(2);
const registryKeys = (process.env.ENKI_MCP_REGISTRY_KEYS || "")
  .split(",")
  .filter(Boolean);
const current = async () =>
  (await readRegistry(root, key, registryKeys)).servers.find((s) => s.id === id && s.enabled);
let connection;
try {
  if (!validId(id)) throw new Error("Invalid service");
  const spec = await current();
  if (!spec) throw new Error("Service is disabled");
  const fingerprint = JSON.stringify(spec);
  connection = await connectServer(
    spec,
    process.cwd(),
    spec.bearer ? process.env.MESH_MCP_BEARER : undefined,
  );
  const aliases = new Map(
    connection.tools.map((t) => [t.name.replaceAll("-", "_"), t.name]),
  );
  const tools = connection.tools.map((t) => ({
    ...t,
    name: t.name.replaceAll("-", "_"),
  }));
  if (mode === "inspect") {
    process.stdout.write(
      JSON.stringify({
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description || "",
        })),
      }),
    );
    await connection.close();
  } else {
    const server = new Server(
      { name: `mesh_${id.replaceAll("-", "_")}`, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    const check = async () => {
      if (JSON.stringify(await current()) !== fingerprint)
        throw new Error("Shared service changed; reconnect before using it");
    };
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      await check();
      return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      await check();
      const original = aliases.get(request.params.name);
      if (!original) throw new Error("Unknown shared MCP tool");
      return connection.client.callTool(
        { ...request.params, name: original },
        undefined,
        {
          signal: extra.signal,
          timeout: 90000,
        },
      );
    });
    server.onclose = () => void connection.close();
    process.stdin.on("end", () => void server.close());
    await server.connect(new StdioServerTransport());
  }
} catch {
  await connection?.close().catch(() => {});
  process.stderr.write(
    "Shared MCP unavailable. Check settings, dependencies and authentication; no action was replayed.\n",
  );
  process.exitCode = 1;
}
