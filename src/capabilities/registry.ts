import { remoteMcpUrl } from "./mcpUrl";
import { isAbsoluteLocalPath } from "../util/paths";
export type Scope = "global" | "project";
export interface SkillSource {
  id: string;
  path: string;
  enabled: boolean;
}
export interface SharedServer {
  id: string;
  name: string;
  enabled: boolean;
  kind: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
  envKeys: string[];
  bearer: boolean;
  authRevision?: string;
}
export interface Registry {
  version: 1;
  directory: string | null;
  sources: SkillSource[];
  servers: SharedServer[];
  appliedPaths: string[];
}
export interface Skill {
  name: string;
  description: string;
  path: string;
  source: string;
  managed: boolean;
  enabled: boolean;
  engines: string[];
  error: string | null;
}
/** Native shared registry document (src-tauri/src/capabilities.rs `Document`). */
export interface Catalog {
  key: string;
  content: string;
  registry: Registry;
  inherited: Registry;
  skills: Skill[];
  runtimeReady: boolean;
  command: string;
  scopeDirectory: string | null;
  sourceHealth?: Record<string, boolean>;
  scanLimited?: boolean;
}
export const emptyRegistry = (): Registry => ({
  version: 1,
  directory: null,
  sources: [],
  servers: [],
  appliedPaths: [],
});
/** Tool namespace of a shared server inside agent sessions. */
export const serverName = (id: string) => `mesh_${id.replace(/-/g, "_")}`;
export function signature(value: unknown) {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(
    value && typeof value === "object" && "envKeys" in value
      ? JSON.stringify(value, [
          "id",
          "name",
          "enabled",
          "kind",
          "command",
          "args",
          "url",
          "envKeys",
          "bearer",
          "authRevision",
        ])
      : JSON.stringify(value),
  ))
    h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
  return h.toString(16).padStart(16, "0");
}
export function validateServer(s: SharedServer): string | null {
  if (
    !/^[a-z][a-z0-9-]{0,31}$/.test(s.id) ||
    !s.name.trim() ||
    s.name.length > 120
  )
    return "Задайте короткий идентификатор и название MCP.";
  if (
    s.args.length > 64 ||
    s.args.some(
      (a) => typeof a !== "string" || a.length > 4096 || a.includes("\0"),
    )
  )
    return "Аргументы должны быть JSON-массивом строк.";
  if (s.envKeys.some((n) => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(n)))
    return "Укажите только имена переменных окружения, без их значений.";
  if (
    s.kind === "stdio" &&
    (!isAbsoluteLocalPath(s.command) || /\.(cmd|bat)$/i.test(s.command))
  )
    return "Укажите абсолютный путь к программе; для npm-инструмента используйте Node и JS-файл в аргументах.";
  if (s.kind === "http") {
    try {
      const u = new URL(s.url);
      if (!remoteMcpUrl(s.url) || u.search)
        return "Нужен HTTPS или loopback HTTP без секретов в URL.";
    } catch {
      return "Проверьте URL MCP.";
    }
  }
  return null;
}
/** Live status of one shared server as reported by the runtime's MCP pool. */
export interface RuntimeServerStatus {
  id: string;
  signature: string;
  state: string;
  tools: string[];
}
export function runtimeServerState(
  server: SharedServer,
  statuses: RuntimeServerStatus[],
  running: boolean,
) {
  if (!server.enabled) return "Выключено";
  if (!running) return "Откройте чат с агентом";
  const status = statuses.find((s) => s.id === server.id);
  if (!status || status.signature !== signature(server))
    return "Переоткройте чат: подключение изменилось";
  return status.state === "connected"
    ? `Подключено · ${status.tools.length} инструментов`
    : status.state === "checking"
      ? "Подключается"
      : "Ошибка подключения";
}
