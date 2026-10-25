import fs from "node:fs/promises";
import path from "node:path";
export const validId = (id) =>
  typeof id === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(id);
export const validKey = (key) =>
  key === "global" || /^project-[0-9a-f]{16}$/.test(key);
export async function readRegistry(root, key) {
  if (!path.isAbsolute(root) || !validKey(key))
    throw new Error("Invalid shared registry");
  async function read(name) {
    const file = path.join(root, `${name}.json`);
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 262144)
        throw new Error("Invalid shared registry");
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      if (
        value.version !== 1 ||
        !Array.isArray(value.sources) ||
        !Array.isArray(value.servers)
      )
        throw new Error("Unsupported registry");
      return value;
    } catch (error) {
      if (error.code === "ENOENT")
        return { version: 1, sources: [], servers: [] };
      throw error;
    }
  }
  const global = await read("global"),
    project = key === "global" ? global : await read(key);
  const merge = (field) => [
    ...new Map(
      [...global[field], ...(key === "global" ? [] : project[field])].map(
        (v) => [v.id, v],
      ),
    ).values(),
  ];
  return {
    sources: merge("sources"),
    servers: merge("servers"),
    directory: project.directory,
  };
}
export function remoteUrl(raw) {
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error("Invalid MCP address");
  return url;
}
// Installation profile identity of THIS process for app-owned native children.
// The MCP SDK stdio transport only inherits HOME/PATH/USER-like variables, so
// it would otherwise drop the profile and let the child fall back to the
// owner's default roots and vault names. Presence is kept exactly, including
// an empty or invalid value the native child must refuse; absence stays
// absence. Nothing else from the environment is forwarded.
export const PROFILE_ENV = "ENKI_PROFILE_DIR";
export function profileEnvironment(env = process.env) {
  return Object.prototype.hasOwnProperty.call(env, PROFILE_ENV) &&
    typeof env[PROFILE_ENV] === "string"
    ? { [PROFILE_ENV]: env[PROFILE_ENV] }
    : {};
}
// Exact extra environment of a configured stdio MCP child (on top of the SDK's
// default HOME/PATH-like set): its declared envKeys, which must exist, and for
// the app-owned image service only its native state-lock command plus this
// installation's profile identity. Never the whole environment.
export function stdioEnvironment(spec, env = process.env) {
  const out = {};
  if (spec.id === "enki-images") {
    if (path.isAbsolute(env.MESH_CAPABILITIES_COMMAND ?? ""))
      out.MESH_CAPABILITIES_COMMAND = env.MESH_CAPABILITIES_COMMAND;
    Object.assign(out, profileEnvironment(env));
  }
  for (const name of spec.envKeys || []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || env[name] === undefined)
      throw new Error("Required environment variable is missing");
    out[name] = env[name];
  }
  return out;
}
export function toolName(server, tool) {
  if (!validId(server) || !/^[a-zA-Z0-9_-]{1,100}$/.test(tool))
    throw new Error("Invalid MCP tool name");
  return `mesh_${server.replaceAll("-", "_")}_${tool.replaceAll("-", "_")}`;
}
// Small stable revision token; never includes tool arguments or credentials.
export function signature(value) {
  let hash = 0xcbf29ce484222325n;
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
    hash = BigInt.asUintN(64, (hash ^ BigInt(b)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, "0");
}
