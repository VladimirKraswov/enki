import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { remoteUrl, toolName } from "./registry.mjs";
import { nodeScriptArgs } from "./stdio-command.mjs";
export async function connectServer(spec, cwd, token, signal) {
  if (!path.isAbsolute(cwd)) throw new Error("Absolute workspace required");
  const client = new Client(
    { name: "enki-shared-tools", version: "1.0.0" },
    { capabilities: { roots: { listChanged: true } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(cwd).href, name: "workspace" }],
  }));
  let transport;
  if (spec.kind === "stdio") {
    if (!path.isAbsolute(spec.command))
      throw new Error("Absolute executable required");
    const env = {};
    // Only the app-owned image service uses the native crash-safe state lock.
    if(spec.id==='enki-images'&&path.isAbsolute(process.env.MESH_CAPABILITIES_COMMAND??''))
      env.MESH_CAPABILITIES_COMMAND=process.env.MESH_CAPABILITIES_COMMAND;
    for (const name of spec.envKeys || []) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ||
        process.env[name] === undefined
      )
        throw new Error("Required environment variable is missing");
      env[name] = process.env[name];
    }
    transport = new StdioClientTransport({
      command: spec.command,
      args: await nodeScriptArgs(spec.command, spec.args || []),
      cwd,
      env,
      stderr: "ignore",
      maxBufferSize: 8 * 1024 * 1024,
    });
  } else {
    remoteUrl(spec.url);
    transport = new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: token
        ? { headers: { Authorization: `Bearer ${token}` } }
        : undefined,
    });
  }
  try {
    await client.connect(transport, { signal, timeout: 10000 });
    let tools = [],
      cursor;
    for (let i = 0; i < 4; i++) {
      const result = await client.listTools(cursor ? { cursor } : {}, {
        signal,
        timeout: 10000,
      });
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (tools.length > 128) throw new Error("Too many MCP tools");
      if (!cursor) break;
    }
    if (cursor) throw new Error("MCP tool pagination exceeded");
    const names = new Set();
    for (const t of tools) {
      const name = toolName(spec.id, t.name);
      if (names.has(name) || t.inputSchema?.type !== "object")
        throw new Error("Unsupported MCP schema or conflicting tool names");
      names.add(name);
    }
    return { client, tools, close: () => client.close() };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}
