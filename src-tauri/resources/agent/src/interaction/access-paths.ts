// Same input normalization as pinned Pi 0.85.1 tools/path-utils + real target
// resolution. A tool_call hook may mutate event.input in place (public SDK API).
// The gate hands the actual tool the canonical path that was authorized.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE_TOOLS = new Set(["read", "write", "edit", "ls", "find", "grep"]);
const OPTIONAL_PATH = new Set(["ls", "find", "grep"]);
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
export function normalizeToolPath(input: string, options: { platform?: NodeJS.Platform; home?: string; unicodeSpaces?: boolean; stripAtPrefix?: boolean } = {}): string {
  const windows = (options.platform ?? process.platform) === "win32", paths = windows ? path.win32 : path;
  let value = options.unicodeSpaces === false ? input : input.replace(UNICODE_SPACES, " ");
  if (options.stripAtPrefix !== false) value = value.replace(/^@/, "");
  if (!value || value.includes("\0")) throw new Error("Некорректный путь инструмента.");
  if (windows && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) {
    const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(value);
    if (match) value = `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  const home = options.home ?? os.homedir();
  if (value === "~") return home;
  if (value.startsWith("~/") || windows && value.startsWith("~\\")) return paths.join(home, value.slice(2));
  if (value.startsWith("file://")) return fileURLToPath(value, { windows });
  return value;
}
function normalizedDirectory(cwd: string): string {
  // SDK resolves its base directory with normalizePath(cwd), without the
  // file-input Unicode-space and @ transformations.
  return path.resolve(normalizeToolPath(cwd, { unicodeSpaces: false, stripAtPrefix: false }));
}
function exists(file: string): boolean { try { fs.accessSync(file); return true; } catch { return false; } }
function readCandidate(file: string): string {
  const ampm = file.replace(/ (AM|PM)\./gi, "\u202F$1.");
  const nfd = file.normalize("NFD"), curly = file.replace(/'/g, "\u2019"), combined = nfd.replace(/'/g, "\u2019");
  return [file, ampm, nfd, curly, combined].find(exists) ?? file;
}
/** Includes the real parent for new files; never treats a dangling link as absent. */
function canonicalTarget(file: string): string {
  let current = file;
  const suffix: string[] = [];
  for (;;) {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw new Error("Родительский каталог инструмента недоступен.");
      suffix.unshift(path.basename(current)); current = parent; continue;
    }
    const real = fs.realpathSync(current);
    if (suffix.length && !(stat.isDirectory() || stat.isSymbolicLink() && fs.statSync(real).isDirectory()))
      throw new Error("Родительский путь инструмента не является каталогом.");
    return path.resolve(real, ...suffix);
  }
}
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export function resolvedToolPath(cwd: string, tool: string, input: Record<string, unknown>): string | null {
  if (!FILE_TOOLS.has(tool)) return null;
  const value = input.path;
  if (value === undefined && OPTIONAL_PATH.has(tool)) return canonicalTarget(normalizedDirectory(cwd));
  if (typeof value !== "string") throw new Error("Инструменту требуется строковый путь.");
  const root = normalizedDirectory(cwd);
  const normalized = normalizeToolPath(value);
  const resolved = path.resolve(root, normalized);
  return canonicalTarget(tool === "read" ? readCandidate(resolved) : resolved);
}
export function externalToolPath(cwd: string, tool: string, input: Record<string, unknown>): string | null {
  const target = resolvedToolPath(cwd, tool, input);
  return target && !isInside(canonicalTarget(normalizedDirectory(cwd)), target) ? target : null;
}
export function resolvedRulePath(cwd: string, pattern: string): string {
  return pattern === "*" ? "*" : canonicalTarget(path.resolve(normalizedDirectory(cwd), normalizeToolPath(pattern)));
}
export class ProjectPathError extends Error { override name = "ProjectPathError"; }
export interface ProjectPath { root: string; target: string; relative: string }
/**
 * Enki project tools (extensions/project-tools.ts) name a location under the
 * PHYSICAL session directory with the same normalization as the built-ins.
 * A symlink anywhere on the path (an alias) or a target outside is refused,
 * never followed; the gate and the tool both call this, so the classified
 * target and the executed target are the same location or the call fails.
 * Their input is never rewritten by prepareToolPaths.
 */
export function resolveProjectPath(cwd: string, value: unknown, optional = false): ProjectPath {
  const base = normalizedDirectory(cwd);
  let root: string;
  try { root = fs.realpathSync(base); } catch { throw new ProjectPathError("Папка проекта недоступна."); }
  if (value === undefined && optional) return { root, target: root, relative: "" };
  if (typeof value !== "string" || !value) throw new ProjectPathError("Инструменту требуется строковый путь.");
  let normalized: string;
  try { normalized = normalizeToolPath(value); } catch { throw new ProjectPathError("Некорректный путь инструмента."); }
  const lexical = path.resolve(base, normalized);
  const relative = isInside(base, lexical) ? path.relative(base, lexical) : isInside(root, lexical) ? path.relative(root, lexical) : null;
  if (relative === null) throw new ProjectPathError("Путь вне папки проекта: проектные инструменты работают только внутри неё.");
  const target = relative ? path.join(root, relative) : root;
  let canonical: string;
  try { canonical = canonicalTarget(target); } catch { throw new ProjectPathError("Путь содержит недоступный каталог или битую ссылку."); }
  if (canonical !== target)
    throw new ProjectPathError(isInside(root, canonical) ? "Путь проходит через символическую ссылку; укажите настоящий путь файла в проекте." : "Ссылка в пути ведёт за пределы папки проекта.");
  return { root, target, relative: relative.split(path.sep).join("/") };
}
/** Unknown plugin/MCP inputs belong to their own schemas and aren't rewritten. */
export function prepareToolPaths(tool: string, input: Record<string, unknown>, cwd: string): void {
  const target = resolvedToolPath(cwd, tool, input);
  if (!target) return;
  const root = normalizedDirectory(cwd);
  const resolvesToTarget = (value: string) => {
    const normalized = path.resolve(root, normalizeToolPath(value));
    return canonicalTarget(tool === "read" ? readCandidate(normalized) : normalized) === target;
  };
  if (resolvesToTarget(target)) { input.path = target; return; }
  // An absolute canonical path can contain Unicode spaces inherited from cwd.
  // Passing it back through the SDK would normalize them a second time and
  // change the target. A relative path keeps the trusted base intact.
  const relative = path.relative(root, target) || ".";
  if (!resolvesToTarget(relative))
    throw new Error("Не удалось безопасно передать путь инструменту без изменения имени. Используйте путь относительно папки чата.");
  input.path = relative;
}
