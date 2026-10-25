// Types for registry.mjs, consumed by the runtime's shared MCP bridge.
export interface SharedServerSpec {
  id: string;
  name: string;
  enabled: boolean;
  kind?: string;
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  bearer?: boolean;
  authRevision?: number;
}
export interface SharedRegistry {
  sources: Array<{ id: string; [key: string]: unknown }>;
  servers: SharedServerSpec[];
  directory?: string;
}
export function validId(id: unknown): id is string;
export function validKey(key: unknown): key is string;
export function readRegistry(root: string, key: string): Promise<SharedRegistry>;
export function remoteUrl(raw: string): URL;
export function toolName(server: string, tool: string): string;
export const PROFILE_ENV: "ENKI_PROFILE_DIR";
export function stdioEnvironment(spec: Pick<SharedServerSpec, "id" | "envKeys">, env?: Record<string, string | undefined>): Record<string, string>;
export function profileEnvironment(env?: Record<string, string | undefined>): Record<string, string>;
export function signature(value: unknown): string;
