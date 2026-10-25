// Enki's own MCP servers (desktop control, computer use) as reserved entries
// of the global shared registry. The runtime's shared MCP pool loads them for
// agent sessions; nothing is written into any external agent configuration.
import { isAbsoluteLocalPath } from "../util/paths";
import { capabilityNative } from "./integration";
import type { Catalog, SharedServer } from "./registry";

export interface ReservedServer {
  id: string;
  name: string;
  /** The single argument Enki's executable accepts for this server. */
  flag: "--agent-mcp" | "--computer-mcp";
}

export const AGENT_CONTROL_SERVER: ReservedServer = { id: "enki-control", name: "Enki: управление приложением", flag: "--agent-mcp" };
export const COMPUTER_SERVER: ReservedServer = { id: "cua-desktop", name: "Enki: управление компьютером", flag: "--computer-mcp" };

/** An entry is ours only when it runs Enki's executable with exactly our flag. */
export function ownsEntry(entry: SharedServer | undefined, reserved: ReservedServer): boolean {
  return !entry || (entry.kind === "stdio" && entry.args.length === 1 && entry.args[0] === reserved.flag && isAbsoluteLocalPath(entry.command));
}

export function reservedEntry(reserved: ReservedServer, command: string, enabled: boolean): SharedServer {
  if (!isAbsoluteLocalPath(command)) throw new Error("Enki не сообщил абсолютный путь своей программы.");
  return { id: reserved.id, name: reserved.name, enabled, kind: "stdio", command, args: [reserved.flag], url: "", envKeys: [], bearer: false };
}

/** Compare-and-swap update of the global registry; foreign entries are never replaced. */
export async function setReservedServer(reserved: ReservedServer, enabled: boolean, invoke = capabilityNative): Promise<Catalog> {
  const catalog = await invoke<Catalog>("shared_catalog", { scope: "global", directory: null });
  const existing = catalog.registry.servers.find(s => s.id === reserved.id);
  if (!ownsEntry(existing, reserved))
    throw new Error(`Идентификатор ${reserved.id} уже занят другой MCP-интеграцией. Она сохранена.`);
  if (!enabled && !existing) return catalog;
  const entry = reservedEntry(reserved, catalog.command, enabled);
  const servers = existing ? catalog.registry.servers.map(s => s.id === reserved.id ? entry : s) : [...catalog.registry.servers, entry];
  return invoke<Catalog>("shared_save", { scope: "global", directory: null, expected: catalog.content, registry: { ...catalog.registry, servers } });
}

export async function reservedServerEnabled(reserved: ReservedServer, invoke = capabilityNative): Promise<boolean> {
  const catalog = await invoke<Catalog>("shared_catalog", { scope: "global", directory: null });
  return !!catalog.registry.servers.find(s => s.id === reserved.id && s.enabled);
}
