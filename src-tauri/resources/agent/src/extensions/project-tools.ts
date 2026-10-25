// Enki-owned project helpers registered as real Pi SDK tools: `repo_inspect`
// (bounded read-only navigation + SHA-256 snapshot) and `safe_edit` (one
// hash-guarded literal replacement). Successors of the retired
// integrations/opencode-agent helpers; see docs/PROJECT-TOOLS.md.
//
// Pure Node: no Python, no rg/git subprocess, no OpenCode import. Both tools act
// only inside the PHYSICAL session directory (interaction/access-paths.ts
// resolveProjectPath). The Enki gate classifies them (interaction/access.ts)
// only while this extension's registration is the effective one.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import { resolveProjectPath, type ProjectPath } from "../interaction/access-paths.ts";
import type { SdkExtension, SdkExtensionApi } from "../sdk/adapter.ts";

export const REPO_INSPECT_TOOL = "repo_inspect";
export const SAFE_EDIT_TOOL = "safe_edit";
export const PROJECT_TOOLS_EXTENSION = "enki-project-tools";

export const PROJECT_TOOL_LIMITS = Object.freeze({
  /** Snapshot, search candidate, safe_edit file and its result. */
  fileBytes: 2_000_000,
  queryMin: 2,
  queryMax: 120,
  locations: 24,
  tests: 12,
  topLevel: 60,
  scripts: 80,
  /** Per walk (search and test hints walk separately under one deadline). */
  entries: 50_000,
  filesRead: 10_000,
  bytesRead: 64 * 1024 * 1024,
  depth: 32,
  /** One deadline for the whole repo_inspect call. */
  timeMs: 10_000,
  ignoreFileBytes: 64 * 1024,
  ignoreRules: 1_000,
  ignoreOperations: 16_000_000,
  manifestBytes: 1_000_000,
  pathChars: 1_024,
  outputChars: 64 * 1024,
});
export type ProjectToolLimits = { readonly [K in keyof typeof PROJECT_TOOL_LIMITS]: number };

/** A refused request (bad input, out-of-scope path). A stale/ambiguous edit is a conflict instead. */
export class ProjectToolError extends Error { override name = "ProjectToolError"; }

// Version-control internals and dependency/build trees are never walked; private
// directories may hold credentials or receipts. TOP_LEVEL_HIDDEN keeps the legacy
// map's extra omissions (dist/build/.next/.venv) for the overview only.
const WALK_SKIP = new Set([".git", ".hg", ".svn", "node_modules", "target"]);
const PRIVATE_DIRS = new Set([".local", ".opencode-migration", ".ssh", ".gnupg", ".aws"]);
const TOP_LEVEL_HIDDEN = new Set([...WALK_SKIP, ...PRIVATE_DIRS, "dist", "build", ".next", ".venv"]);
const SENSITIVE_NAMES = new Set([".npmrc", ".pypirc", ".netrc", ".git-credentials", ".htpasswd", "auth.json", "credentials", "credentials.json", "secrets.json"]);
const SENSITIVE_PATTERN = /^(?:\.env.*|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc))$/i;
const MANIFESTS = ["package.json", "pnpm-lock.yaml", "package-lock.json", "pyproject.toml", "pytest.ini", "Cargo.toml", "go.mod", "Makefile", "justfile", "CMakeLists.txt"];
const INSTRUCTIONS = ["AGENTS.md", "CLAUDE.md", ".pi/TASK.md", ".opencode/TASK.md"];
const NAVIGATION_NOTE = "Navigation hints only: paths/lines/hashes are not evidence that code is correct. Read the file with `read` and run project checks before relying on it.";

/** Credential-like file names: never searched, snapshotted or edited by these tools. */
export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAMES.has(name.toLowerCase()) || SENSITIVE_PATTERN.test(name);
}

// --- .gitignore subset ------------------------------------------------------
// Blank/comment lines, `!` negation, trailing `/` (directories), leading or
// inner `/` (anchored), `*`, `?`, `[...]`, `**`. Nested files apply to their
// subtree; last match wins. `.git/info/exclude` and global excludes are not read.

type GlobToken = { kind: "literal"; value: string } | { kind: "any" } | { kind: "star"; slash: boolean }
  | { kind: "directories" | "directoryBody" } | { kind: "class"; pattern: RegExp };
export interface IgnoreRule { base: string; pattern: GlobToken[]; anchored: boolean; negate: boolean; directoryOnly: boolean }

/** Compact NFA instructions. Only character classes use RegExp, against ONE
 * character; wildcard matching never invokes a backtracking whole-path regex. */
function compileGlob(glob: string): GlobToken[] {
  const out: GlobToken[] = [];
  for (let i = 0; i < glob.length;) {
    if (glob.startsWith("**/", i)) { out.push({ kind: "directories" }, { kind: "directoryBody" }); i += 3; while (glob.startsWith("**/", i)) i += 3; continue; }
    if (glob.startsWith("**", i)) { out.push({ kind: "star", slash: true }); i += 2; continue; }
    const c = glob[i];
    if (c === "*") { out.push({ kind: "star", slash: false }); i++; continue; }
    if (c === "?") { out.push({ kind: "any" }); i++; continue; }
    if (c === "\\" && i + 1 < glob.length) { out.push({ kind: "literal", value: glob[i + 1] }); i += 2; continue; }
    if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end > 0) {
        const body = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
        out.push({ kind: "class", pattern: new RegExp(`^[${body.startsWith("!") ? `^${body.slice(1)}` : body}]$`, "s") });
        i = end + 1; continue;
      }
    }
    out.push({ kind: "literal", value: c }); i++;
  }
  return out;
}

export function parseIgnore(text: string, base: string, maxRules: number = PROJECT_TOOL_LIMITS.ignoreRules, strict = false): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    let line = raw.endsWith("\\ ") ? raw : raw.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    if (rules.length >= maxRules || line.length > 1_024) {
      if (strict) throw new ProjectToolError("Правила .gitignore превышают предел: область исключений не подтверждена.");
      if (rules.length >= maxRules) break;
      continue;
    }
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    else if (line.startsWith("\\!") || line.startsWith("\\#")) line = line.slice(1);
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.slice(0, -1);
    if (!line) continue;
    if ((line.match(/[*?[]/g)?.length ?? 0) > 16) {
      if (strict) throw new ProjectToolError("Слишком сложное правило .gitignore: область исключений не подтверждена.");
      continue;
    }
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    try {
      rules.push({ base, negate, directoryOnly, anchored, pattern: compileGlob(line) });
    } catch { /* an unparseable line ignores nothing, like git */ }
  }
  return rules;
}

interface IgnoreWork { operations: number; maximum: number; deadline: number; signal?: AbortSignal }
function ignoreWork(limits: ProjectToolLimits, deadline: number, signal?: AbortSignal): IgnoreWork {
  return { operations: 0, maximum: limits.ignoreOperations, deadline, signal };
}
function ignoreStep(work: IgnoreWork): void {
  if (++work.operations > work.maximum) throw new ProjectToolError("Предел работы с .gitignore превышен; область исключений не подтверждена.");
  if ((work.operations & 63) === 0) {
    work.signal?.throwIfAborted();
    if (Date.now() > work.deadline) throw new ProjectToolError("Истёк срок проверки .gitignore; область исключений не подтверждена.");
  }
}
function matchesGlob(rule: IgnoreRule, value: string, work: IgnoreWork): boolean {
  const tokens = rule.pattern;
  let active = new Set<number>([0]);
  const closure = (states: Set<number>) => {
    for (const state of states) {
      ignoreStep(work);
      const token = tokens[state];
      if (token?.kind === "star") states.add(state + 1);
      else if (token?.kind === "directories") states.add(state + 2);
    }
  };
  for (let at = 0; at < value.length; at++) {
    ignoreStep(work);
    if (!rule.anchored && at > 0 && value[at - 1] === "/") active.add(0);
    closure(active);
    const next = new Set<number>(), c = value[at];
    for (const state of active) {
      ignoreStep(work);
      const token = tokens[state];
      if (!token) continue;
      if (token.kind === "literal" && token.value === c || token.kind === "any" && c !== "/" || token.kind === "class" && c !== "/" && token.pattern.test(c)) next.add(state + 1);
      else if (token.kind === "star" && (token.slash || c !== "/")) next.add(state);
      else if (token.kind === "directories" || token.kind === "directoryBody") {
        const body = token.kind === "directories" ? state + 1 : state;
        next.add(body);
        if (c === "/") next.add(body + 1);
      }
    }
    active = next;
    if (!active.size && rule.anchored) return false;
  }
  closure(active);
  return active.has(tokens.length);
}

export function ignoredBy(rules: readonly IgnoreRule[], relative: string, directory: boolean,
  work = ignoreWork(PROJECT_TOOL_LIMITS, Date.now() + PROJECT_TOOL_LIMITS.timeMs)): boolean {
  let ignored = false;
  for (const rule of rules) {
    ignoreStep(work);
    if (rule.directoryOnly && !directory) continue;
    const local = !rule.base ? relative : relative.startsWith(`${rule.base}/`) ? relative.slice(rule.base.length + 1) : null;
    if (local !== null && matchesGlob(rule, local, work)) ignored = !rule.negate;
  }
  return ignored;
}

// --- bounded file access ----------------------------------------------------

const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
type ReadResult = { data: Buffer; stat: fs.BigIntStats } | { refused: "oversize" | "special" | "changed" | "budget" };

/** Never follows a final symlink, never blocks on a FIFO, never reads past `maxBytes`. */
async function readRegular(file: string, maxBytes: number, signal?: AbortSignal, admit?: (size: number) => boolean): Promise<ReadResult> {
  const handle = await fs.promises.open(file, READ_FLAGS);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) return { refused: "special" };
    if (stat.size > BigInt(maxBytes)) return { refused: "oversize" };
    const size = Number(stat.size);
    if (admit && !admit(size)) return { refused: "budget" };
    const data = Buffer.alloc(size + 1); // one spare byte detects growth while reading
    let offset = 0;
    while (offset < data.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset === size ? { data: data.subarray(0, size), stat } : { refused: "changed" };
  } finally { await handle.close(); }
}

type TextKind = "text" | "binary" | "invalid_utf8";
function textKind(data: Buffer): TextKind {
  if (data.includes(0)) return "binary";
  try { new TextDecoder("utf-8", { fatal: true }).decode(data); return "text"; } catch { return "invalid_utf8"; }
}
function decode(data: Buffer): string { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); }
function sha256(data: Buffer): string { return createHash("sha256").update(data).digest("hex"); }

async function lstatOrNull(file: string): Promise<fs.Stats | null> {
  try { return await fs.promises.lstat(file); } catch { return null; }
}

/** Regular file reached through real directories only (no symlink component). */
async function regularFile(root: string, relative: string): Promise<boolean> {
  let current = root;
  const parts = relative.split("/");
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await lstatOrNull(current);
    if (!stat || stat.isSymbolicLink()) return false;
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) return false;
  }
  return true;
}

async function ignoreFile(directory: string, relative: string, limits: ProjectToolLimits, signal?: AbortSignal): Promise<IgnoreRule[]> {
  const file = path.join(directory, ".gitignore");
  let stat: fs.Stats;
  try { stat = await fs.promises.lstat(file); }
  catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ProjectToolError("Не удалось проверить .gitignore; чтение и правка проектным инструментом отменены.");
  }
  if (!stat.isFile()) throw new ProjectToolError(".gitignore не является обычным файлом; область исключений не подтверждена.");
  try {
    const read = await readRegular(file, limits.ignoreFileBytes, signal);
    if (!("data" in read) || textKind(read.data) !== "text")
      throw new ProjectToolError(".gitignore слишком большой, изменён или не является UTF-8; область исключений не подтверждена.");
    return parseIgnore(decode(read.data), relative, limits.ignoreRules, true);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ProjectToolError) throw error;
    throw new ProjectToolError("Не удалось прочитать .gitignore; чтение и правка проектным инструментом отменены.");
  }
}

// --- scope ------------------------------------------------------------------

/** Why a project file is outside the tools' declared scope, or null. Reads only .gitignore files. */
async function scopeRefusal(root: string, relative: string, limits: ProjectToolLimits, signal?: AbortSignal, deadline = Date.now() + limits.timeMs): Promise<string | null> {
  const matching = ignoreWork(limits, deadline, signal);
  const parts = relative.split("/");
  for (const part of parts.slice(0, -1)) {
    if (WALK_SKIP.has(part)) return `каталог ${part} (служебные/зависимые файлы) не входит в область проектных инструментов`;
    if (PRIVATE_DIRS.has(part)) return `каталог ${part} может содержать секреты и не входит в область проектных инструментов`;
  }
  if (isSensitiveName(parts[parts.length - 1])) return "файл похож на ключ или секрет; проектные инструменты его не читают и не меняют";
  let rules: IgnoreRule[] = [];
  let directory = root, directoryRelative = "";
  for (const part of parts.slice(0, -1)) {
    rules = rules.concat(await ignoreFile(directory, directoryRelative, limits, signal));
    directory = path.join(directory, part);
    directoryRelative = directoryRelative ? `${directoryRelative}/${part}` : part;
    if (ignoredBy(rules, directoryRelative, true, matching)) return `путь ${directoryRelative} исключён .gitignore`;
  }
  rules = rules.concat(await ignoreFile(directory, directoryRelative, limits, signal));
  return ignoredBy(rules, relative, false, matching) ? "файл исключён .gitignore" : null;
}

// --- bounded walk -----------------------------------------------------------

interface Budget { limits: ProjectToolLimits; deadline: number; signal?: AbortSignal; entries: number; files: number; bytes: number; exhausted: string | null; ignore: IgnoreWork }
export interface WalkSkips { symlinks: number; ignored: number; generated: number; sensitive: number; special: number }

function budget(limits: ProjectToolLimits, deadline: number, signal?: AbortSignal): Budget {
  return { limits, deadline, signal, entries: 0, files: 0, bytes: 0, exhausted: null, ignore: ignoreWork(limits, deadline, signal) };
}
function alive(work: Budget): boolean {
  work.signal?.throwIfAborted();
  if (work.exhausted === null && Date.now() > work.deadline) work.exhausted = "time";
  return work.exhausted === null;
}
/** Content read allowance: counts files and bytes against the walk's budget. */
function admit(work: Budget): (size: number) => boolean {
  return (size) => {
    if (work.files >= work.limits.filesRead) { work.exhausted ??= "files"; return false; }
    if (work.bytes + size > work.limits.bytesRead) { work.exhausted ??= "bytes"; return false; }
    work.files++; work.bytes += size; return true;
  };
}

type Entry = { name: string; kind: "file" | "directory" | "symlink" | "other" };
async function directoryEntries(directory: string, work: Budget): Promise<Entry[]> {
  const out: Entry[] = [];
  let handle: fs.Dir;
  try { handle = await fs.promises.opendir(directory); } catch { return out; }
  try {
    for await (const dirent of handle) {
      if (++work.entries > work.limits.entries) { work.exhausted ??= "entries"; break; }
      out.push({ name: dirent.name, kind: dirent.isSymbolicLink() ? "symlink" : dirent.isDirectory() ? "directory" : dirent.isFile() ? "file" : "other" });
      if ((work.entries & 255) === 0 && !alive(work)) break;
    }
  } finally { await handle.close().catch(() => undefined); }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Depth-first, name-ordered walk of the physical project. Symlinks are never
 * followed (no cycles, no outside reads); FIFOs/devices are skipped; generated,
 * private, sensitive and .gitignored entries are not visited. `visit` returns
 * false to stop early.
 */
async function walk(root: string, work: Budget, skips: WalkSkips, visit: (relative: string, absolute: string) => Promise<boolean>): Promise<void> {
  const stack: Array<{ absolute: string; relative: string; depth: number; rules: IgnoreRule[] }> = [{ absolute: root, relative: "", depth: 0, rules: [] }];
  while (stack.length && alive(work)) {
    const current = stack.pop()!;
    const rules = current.rules.concat(await ignoreFile(current.absolute, current.relative, work.limits, work.signal));
    const children: typeof stack = [];
    for (const entry of await directoryEntries(current.absolute, work)) {
      if (!alive(work)) return;
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      const absolute = path.join(current.absolute, entry.name);
      if (entry.kind === "symlink") skips.symlinks++;
      else if (entry.kind === "other") skips.special++;
      else if (entry.kind === "directory") {
        if (WALK_SKIP.has(entry.name)) skips.generated++;
        else if (PRIVATE_DIRS.has(entry.name)) skips.sensitive++;
        else if (ignoredBy(rules, relative, true, work.ignore)) skips.ignored++;
        else if (current.depth + 1 > work.limits.depth) work.exhausted ??= "depth";
        else children.push({ absolute, relative, depth: current.depth + 1, rules });
      } else if (isSensitiveName(entry.name)) skips.sensitive++;
      else if (ignoredBy(rules, relative, false, work.ignore)) skips.ignored++;
      else {
        if (!await visit(relative, absolute)) return;
        if (!alive(work)) return;
      }
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

// --- repo_inspect -----------------------------------------------------------

export interface RepoInspectParams { query?: string; path?: string }
export interface SearchReport {
  query: string;
  locations: Array<{ path: string; line: number }>;
  truncated: boolean;
  exhausted: string | null;
  files_searched: number;
  skipped: WalkSkips & { binary: number; invalid_utf8: number; oversize: number; unreadable: number; lockfiles: number };
}
export interface FileSnapshot {
  path: string;
  bytes: number;
  sha256: string;
  encoding: "utf-8" | "binary" | "invalid_utf8";
  /** Whether safe_edit can work on this exact version. */
  safe_edit: "ok" | "binary" | "invalid_utf8" | "hardlinked";
  matching_tests: string[];
  applicable_instructions: string[];
  applicable_manifests: string[];
  tests_exhausted: string | null;
}
export interface RepoInspectReport {
  root: string;
  note: string;
  git: { repository: boolean; head: string | null };
  manifests: string[];
  instructions: string[];
  top_level: string[];
  package_manager?: string;
  npm_script_names?: string[];
  manifest_error?: string;
  file?: FileSnapshot;
  search?: SearchReport;
  output_truncated?: boolean;
}

async function gitHead(root: string, signal?: AbortSignal): Promise<RepoInspectReport["git"]> {
  const marker = await lstatOrNull(path.join(root, ".git"));
  // A `.git` file (worktree/submodule pointer) may lead outside: not followed.
  if (!marker || !(marker.isDirectory() || marker.isFile())) return { repository: false, head: null };
  if (marker.isFile() || !await regularFile(root, ".git/HEAD")) return { repository: true, head: null };
  try {
    const read = await readRegular(path.join(root, ".git", "HEAD"), 4_096, signal);
    if (!("data" in read) || textKind(read.data) !== "text") return { repository: true, head: null };
    const value = decode(read.data).trim();
    const branch = /^ref: refs\/heads\/([^\0\r\n]{1,200})$/.exec(value)?.[1];
    return { repository: true, head: branch ?? (/^[0-9a-f]{40,64}$/.test(value) ? "(detached)" : null) };
  } catch { signal?.throwIfAborted(); return { repository: true, head: null }; }
}

async function packageInfo(root: string, limits: ProjectToolLimits, signal?: AbortSignal): Promise<Pick<RepoInspectReport, "package_manager" | "npm_script_names" | "manifest_error">> {
  if (!await regularFile(root, "package.json")) return {};
  try {
    const read = await readRegular(path.join(root, "package.json"), limits.manifestBytes, signal);
    if (!("data" in read)) return { manifest_error: "package.json is too large or changed while reading" };
    const data: unknown = JSON.parse(decode(read.data));
    if (!data || typeof data !== "object") return { manifest_error: "package.json is not an object" };
    const record = data as { packageManager?: unknown; scripts?: unknown };
    const scripts = record.scripts && typeof record.scripts === "object" ? Object.keys(record.scripts).filter(name => name.length <= 200).sort().slice(0, limits.scripts) : [];
    return { ...(typeof record.packageManager === "string" && record.packageManager.length <= 200 ? { package_manager: record.packageManager } : {}), npm_script_names: scripts };
  } catch { signal?.throwIfAborted(); return { manifest_error: "package.json could not be parsed" }; }
}

async function topLevel(root: string, work: Budget): Promise<string[]> {
  const rules = await ignoreFile(root, "", work.limits, work.signal);
  return (await directoryEntries(root, work))
    .filter(entry => entry.kind === "directory" && !TOP_LEVEL_HIDDEN.has(entry.name) && !ignoredBy(rules, entry.name, true, work.ignore))
    .map(entry => entry.name).slice(0, work.limits.topLevel);
}

/** Root-to-leaf guidance/manifest files that exist; their contents are not read. */
async function applicable(root: string, relative: string, names: readonly string[]): Promise<string[]> {
  const parts = relative.split("/").slice(0, -1);
  const found: string[] = [];
  for (let depth = 0; depth <= parts.length; depth++) {
    const directory = parts.slice(0, depth).join("/");
    for (const name of names) {
      const candidate = directory ? `${directory}/${name}` : name;
      if (await regularFile(root, candidate)) found.push(candidate);
    }
  }
  return found;
}

/** Legacy ranking: test-like names scored by stem tokens, then test files referencing the stem. */
async function likelyTests(root: string, stem: string, work: Budget): Promise<string[]> {
  const tokens = stem.split(/[-_. ]+/).map(token => token.toLowerCase()).filter(token => token.length >= 3);
  const candidates: string[] = [];
  const skips: WalkSkips = { symlinks: 0, ignored: 0, generated: 0, sensitive: 0, special: 0 };
  await walk(root, work, skips, async (relative) => {
    const lower = relative.toLowerCase(), name = lower.slice(lower.lastIndexOf("/") + 1);
    if ((name.includes("test") || name.includes("spec") || `/${lower}`.includes("/__tests__/")) && candidates.length < 5_000) candidates.push(relative);
    return true;
  });
  const result = candidates
    .map(name => ({ name, score: tokens.filter(token => name.toLowerCase().includes(token)).length }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, work.limits.tests).map(entry => entry.name);
  if (result.length < work.limits.tests && stem.length >= 4) {
    const needle = Buffer.from(stem, "utf8");
    for (const candidate of candidates) {
      if (result.length >= work.limits.tests || !alive(work)) break;
      if (result.includes(candidate)) continue;
      try {
        const read = await readRegular(path.join(root, ...candidate.split("/")), work.limits.fileBytes, work.signal, admit(work));
        if ("data" in read && textKind(read.data) === "text" && read.data.includes(needle)) result.push(candidate);
      } catch { work.signal?.throwIfAborted(); }
    }
  }
  return result;
}

async function snapshot(located: ProjectPath, work: Budget): Promise<FileSnapshot> {
  if (!located.relative) throw new ProjectToolError("path должен указывать на файл проекта, а не на папку проекта.");
  const refusal = await scopeRefusal(located.root, located.relative, work.limits, work.signal, work.deadline);
  if (refusal) throw new ProjectToolError(`repo_inspect не делает снимок: ${refusal}.`);
  const read = await openForTool(located.target, work.limits, work.signal);
  const kind = textKind(read.data);
  const stem = path.basename(located.relative, path.extname(located.relative));
  const tests = await likelyTests(located.root, stem, work);
  return {
    path: located.relative,
    bytes: read.data.length,
    sha256: sha256(read.data),
    encoding: kind === "text" ? "utf-8" : kind,
    safe_edit: kind !== "text" ? kind : read.stat.nlink !== 1n ? "hardlinked" : "ok",
    matching_tests: tests,
    applicable_instructions: await applicable(located.root, located.relative, INSTRUCTIONS),
    applicable_manifests: await applicable(located.root, located.relative, MANIFESTS),
    tests_exhausted: work.exhausted,
  };
}

async function search(root: string, query: string, work: Budget): Promise<SearchReport> {
  const needle = query.toLowerCase();
  const skips: WalkSkips = { symlinks: 0, ignored: 0, generated: 0, sensitive: 0, special: 0 };
  const skipped = { ...skips, binary: 0, invalid_utf8: 0, oversize: 0, unreadable: 0, lockfiles: 0 };
  const locations: SearchReport["locations"] = [];
  let searched = 0;
  await walk(root, work, skipped, async (relative, absolute) => {
    if (relative.endsWith(".lock")) { skipped.lockfiles++; return true; }
    let read: ReadResult;
    try { read = await readRegular(absolute, work.limits.fileBytes, work.signal, admit(work)); }
    catch { work.signal?.throwIfAborted(); skipped.unreadable++; return true; }
    if (!("data" in read)) {
      if (read.refused === "budget") return false;
      if (read.refused === "oversize") skipped.oversize++; else skipped.unreadable++;
      return true;
    }
    searched++;
    const kind = textKind(read.data);
    if (kind !== "text") { skipped[kind]++; return true; }
    const text = decode(read.data);
    if (!text.toLowerCase().includes(needle)) return true;
    const lines = text.split("\n");
    const line = lines.findIndex(value => value.toLowerCase().includes(needle));
    // Location only: the matching line itself may contain a secret and is never returned.
    if (line >= 0) locations.push({ path: relative, line: line + 1 });
    return locations.length < work.limits.locations;
  });
  return { query, locations, truncated: locations.length >= work.limits.locations || work.exhausted !== null, exhausted: work.exhausted, files_searched: searched, skipped };
}

async function openForTool(target: string, limits: ProjectToolLimits, signal?: AbortSignal): Promise<{ data: Buffer; stat: fs.BigIntStats }> {
  let read: ReadResult;
  try { read = await readRegular(target, limits.fileBytes, signal); }
  catch (error) {
    signal?.throwIfAborted();
    const code = (error as NodeJS.ErrnoException).code;
    throw new ProjectToolError(code === "ENOENT" ? "Файл не найден." : code === "ELOOP" ? "Символические ссылки не принимаются." : "Файл недоступен для чтения.");
  }
  if ("data" in read) return read;
  throw new ProjectToolError(read.refused === "oversize" ? `Файл больше ${limits.fileBytes} байт: используйте read по частям.`
    : read.refused === "changed" ? "Файл изменился во время чтения; повторите." : "Это не обычный файл.");
}

/** Keeps every list but shortens the longest ones until the JSON fits the output bound. */
function bounded(report: RepoInspectReport, limits: ProjectToolLimits): RepoInspectReport {
  const out: RepoInspectReport = structuredClone(report);
  const fit = (values: string[]) => {
    const kept = values.filter(value => value.length <= limits.pathChars);
    if (kept.length !== values.length) out.output_truncated = true;
    return kept;
  };
  out.top_level = fit(out.top_level);
  out.manifests = fit(out.manifests);
  out.instructions = fit(out.instructions);
  if (out.npm_script_names) out.npm_script_names = fit(out.npm_script_names);
  if (out.file) {
    out.file.matching_tests = fit(out.file.matching_tests);
    out.file.applicable_instructions = fit(out.file.applicable_instructions);
    out.file.applicable_manifests = fit(out.file.applicable_manifests);
  }
  if (out.search) {
    const kept = out.search.locations.filter(location => location.path.length <= limits.pathChars);
    if (kept.length !== out.search.locations.length) { out.search.truncated = true; out.output_truncated = true; }
    out.search.locations = kept;
  }
  for (let rounds = 0; JSON.stringify(out).length > limits.outputChars && rounds < 128; rounds++) {
    out.output_truncated = true;
    const lists: Array<{ length: number; cut(): void }> = [
      { length: out.top_level.length, cut: () => { out.top_level = out.top_level.slice(0, out.top_level.length >> 1); } },
      { length: out.manifests.length, cut: () => { out.manifests = out.manifests.slice(0, out.manifests.length >> 1); } },
      { length: out.instructions.length, cut: () => { out.instructions = out.instructions.slice(0, out.instructions.length >> 1); } },
      { length: out.npm_script_names?.length ?? 0, cut: () => { out.npm_script_names = out.npm_script_names!.slice(0, out.npm_script_names!.length >> 1); } },
      { length: out.file?.matching_tests.length ?? 0, cut: () => { out.file!.matching_tests = out.file!.matching_tests.slice(0, out.file!.matching_tests.length >> 1); } },
      { length: out.file?.applicable_instructions.length ?? 0, cut: () => { out.file!.applicable_instructions = out.file!.applicable_instructions.slice(0, out.file!.applicable_instructions.length >> 1); } },
      { length: out.file?.applicable_manifests.length ?? 0, cut: () => { out.file!.applicable_manifests = out.file!.applicable_manifests.slice(0, out.file!.applicable_manifests.length >> 1); } },
      { length: out.search?.locations.length ?? 0, cut: () => { out.search!.locations = out.search!.locations.slice(0, out.search!.locations.length >> 1); out.search!.truncated = true; } },
    ];
    const longest = lists.reduce((a, b) => (b.length > a.length ? b : a));
    if (!longest.length) break;
    longest.cut();
  }
  if (JSON.stringify(out).length > limits.outputChars)
    throw new ProjectToolError("Метаданные проекта превышают предел ответа; сократите путь или область запроса.");
  return out;
}

export async function inspectRepository(cwd: string, params: RepoInspectParams, signal?: AbortSignal, limits: ProjectToolLimits = PROJECT_TOOL_LIMITS): Promise<RepoInspectReport> {
  signal?.throwIfAborted();
  const query = params.query;
  if (query !== undefined && (query.length < limits.queryMin || query.length > limits.queryMax || /[\r\n\0]/.test(query)))
    throw new ProjectToolError(`query: от ${limits.queryMin} до ${limits.queryMax} символов в одной строке.`);
  const located = resolveProjectPath(cwd, params.path, true);
  const deadline = Date.now() + limits.timeMs;
  const overview = budget(limits, deadline, signal);
  const report: RepoInspectReport = {
    root: located.root,
    note: NAVIGATION_NOTE,
    git: await gitHead(located.root, signal),
    manifests: (await Promise.all(MANIFESTS.map(async name => (await regularFile(located.root, name)) ? name : null))).filter((name): name is string => name !== null),
    instructions: (await Promise.all(INSTRUCTIONS.map(async name => (await regularFile(located.root, name)) ? name : null))).filter((name): name is string => name !== null),
    top_level: await topLevel(located.root, overview),
    ...await packageInfo(located.root, limits, signal),
  };
  if (params.path !== undefined) report.file = await snapshot(located, budget(limits, deadline, signal));
  if (query !== undefined) report.search = await search(located.root, query, budget(limits, deadline, signal));
  return bounded(report, limits);
}

// --- safe_edit --------------------------------------------------------------

export interface SafeEditRequest { path: string; expected_sha256: string; old: string; new: string }
export type SafeEditResult =
  | { status: "applied"; path: string; before_sha256: string; after_sha256: string; bytes: number }
  | { status: "conflict"; path: string; reason: "stale" | "missing" | "ambiguous" | "changed"; message: string; sha256?: string; occurrences?: number;
      cleanup?: { state: "unknown"; temporary: string; message: string } };
/** Test seam: runs after staging, before the final recheck and publication. */
export interface SafeEditHooks { beforePublish?(): void | Promise<void> }

/** Same-process writers of one physical file run one at a time. Holds only in-flight
 * promises (deleted when settled), never file data or session state. */
const writers = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (writers.get(key) ?? Promise.resolve()).catch(() => undefined).then(task);
  const settled = run.catch(() => undefined);
  writers.set(key, settled);
  try { return await run; } finally { if (writers.get(key) === settled) writers.delete(key); }
}

function occurrences(haystack: Buffer, needle: Buffer, limit = 1_000): { count: number; first: number } {
  // Overlapping starts count too: "aa" occurs twice in "aaa", which is ambiguous.
  let count = 0, first = -1;
  for (let at = haystack.indexOf(needle); at >= 0 && count < limit; at = haystack.indexOf(needle, at + 1)) {
    if (first < 0) first = at;
    count++;
  }
  return { count, first };
}

async function removeOwned(file: string, owned: fs.BigIntStats): Promise<boolean> {
  try {
    // A replaced ancestor must not redirect cleanup to another directory.
    if (await fs.promises.realpath(path.dirname(file)) !== path.dirname(file)) return false;
    const now = await fs.promises.lstat(file, { bigint: true });
    if (now.ino !== owned.ino || now.dev !== owned.dev) return false;
    await fs.promises.unlink(file);
    return true;
  } catch { return false; /* A moved/missing pathname does not prove the owned inode was removed. */ }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  try { const handle = await fs.promises.open(directory, fs.constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } }
  catch { /* durability hint only */ }
}

function sameVersion(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && b.nlink === 1n;
}

/**
 * One literal replacement in a UTF-8 project file whose current SHA-256 equals
 * `expected_sha256`. Stale hash, missing/ambiguous text or a changed physical
 * identity is a conflict: nothing is written. The new bytes are staged in the
 * same directory, synced, rechecked and published by rename. Same-process
 * writers are serialized; another process can still change the file between the
 * final recheck and rename (rename is not compare-and-swap).
 */
export async function safeEdit(cwd: string, request: SafeEditRequest, signal?: AbortSignal, hooks: SafeEditHooks = {}, limits: ProjectToolLimits = PROJECT_TOOL_LIMITS): Promise<SafeEditResult> {
  signal?.throwIfAborted();
  if (typeof request.old !== "string" || typeof request.new !== "string" || !request.old || request.old === request.new)
    throw new ProjectToolError("old и new должны быть разными строками; old не может быть пустым.");
  if (typeof request.expected_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(request.expected_sha256))
    throw new ProjectToolError("Нужен expected_sha256 (64 строчных hex-символа): получите его через repo_inspect с path.");
  if (request.old.includes("\0") || request.new.includes("\0")) throw new ProjectToolError("Символ NUL не допускается в текстовой замене.");
  const before = Buffer.from(request.old, "utf8"), after = Buffer.from(request.new, "utf8");
  if (before.length > limits.fileBytes || after.length > limits.fileBytes) throw new ProjectToolError("Замена больше предела файла.");
  const located = resolveProjectPath(cwd, request.path);
  if (!located.relative) throw new ProjectToolError("path должен указывать на файл проекта.");
  const refusal = await scopeRefusal(located.root, located.relative, limits, signal);
  if (refusal) throw new ProjectToolError(`safe_edit отказано: ${refusal}.`);
  return serialized(located.target, () => replaceOnce(cwd, request, located, before, after, signal, hooks, limits));
}

async function replaceOnce(cwd: string, request: SafeEditRequest, located: ProjectPath, before: Buffer, after: Buffer,
  signal: AbortSignal | undefined, hooks: SafeEditHooks, limits: ProjectToolLimits): Promise<SafeEditResult> {
  signal?.throwIfAborted();
  const { target, relative } = located;
  const outcome: { conflict?: Extract<SafeEditResult, { status: "conflict" }> } = {};
  const conflict = (reason: Extract<SafeEditResult, { status: "conflict" }>["reason"], message: string, extra: { sha256?: string; occurrences?: number } = {}): SafeEditResult =>
    (outcome.conflict = { status: "conflict", path: relative, reason, message, ...extra });
  const original = await openForTool(target, limits, signal);
  const stat = original.stat;
  if (stat.nlink !== 1n) throw new ProjectToolError("У файла несколько жёстких ссылок: замена отсоединила бы их. Используйте edit.");
  const actual = sha256(original.data);
  if (actual !== request.expected_sha256)
    return conflict("stale", "Файл изменился после снимка: перечитайте его и получите новый SHA-256. Ничего не записано.", { sha256: actual });
  const kind = textKind(original.data);
  if (kind !== "text") throw new ProjectToolError(kind === "binary" ? "Файл двоичный (содержит NUL)." : "Файл не является корректным UTF-8.");
  const found = occurrences(original.data, before);
  if (found.count === 0) return conflict("missing", "Текст old не найден точно (байты и переводы строк учитываются). Ничего не записано.", { sha256: actual, occurrences: 0 });
  if (found.count > 1) return conflict("ambiguous", `Текст old встречается ${found.count} раз: расширьте его до уникального. Ничего не записано.`, { sha256: actual, occurrences: found.count });
  const replacement = Buffer.concat([original.data.subarray(0, found.first), after, original.data.subarray(found.first + before.length)]);
  if (replacement.length > limits.fileBytes) throw new ProjectToolError(`Результат больше ${limits.fileBytes} байт.`);
  if (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid()))
    throw new ProjectToolError("Файл принадлежит другому пользователю: замена сменила бы владельца. Используйте edit.");
  signal?.throwIfAborted();
  const directory = path.dirname(target);
  const staged = path.join(directory, `.enki-safe-edit-${randomBytes(8).toString("hex")}.tmp`);
  let handle: fs.promises.FileHandle | undefined, owned: fs.BigIntStats | undefined, created = false, published = false;
  try {
    handle = await fs.promises.open(staged, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    owned = await handle.stat({ bigint: true });
    if (process.platform !== "win32" && owned.gid !== stat.gid) {
      try { await handle.chown(Number(stat.uid), Number(stat.gid)); }
      catch { throw new ProjectToolError("Не удалось сохранить группу файла. Ничего не записано."); }
    }
    await handle.writeFile(replacement);
    await handle.chmod(Number(stat.mode & 0o7777n));
    await handle.sync();
    await handle.close(); handle = undefined;
    signal?.throwIfAborted();
    await hooks.beforePublish?.();
    signal?.throwIfAborted();
    // Recheck the physical path, identity and bytes right before publication.
    let again: ProjectPath;
    try { again = resolveProjectPath(cwd, request.path); } catch { return conflict("changed", "Путь к файлу изменился во время правки. Ничего не записано.", { sha256: actual }); }
    if (again.target !== target) return conflict("changed", "Путь к файлу изменился во время правки. Ничего не записано.", { sha256: actual });
    const now = await fs.promises.lstat(target, { bigint: true }).catch(() => null);
    if (!now?.isFile() || !sameVersion(stat, now)) return conflict("changed", "Файл заменили или изменили во время правки. Ничего не записано.", { sha256: actual });
    let current: ReadResult | null = null;
    try { current = await readRegular(target, limits.fileBytes, signal); } catch { signal?.throwIfAborted(); }
    if (!current || !("data" in current) || !sameVersion(stat, current.stat) || sha256(current.data) !== actual)
      return conflict("changed", "Содержимое файла изменилось во время правки. Ничего не записано.", { sha256: actual });
    signal?.throwIfAborted();
    await fs.promises.rename(staged, target);
    published = true;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (!published && created && (!owned || !await removeOwned(staged, owned))) {
      const cleanup = { state: "unknown" as const, temporary: path.basename(staged),
        message: `Удаление собственного временного файла ${path.basename(staged)} не подтверждено (возможно, папка перемещена). Автоматический поиск и удаление в других местах не выполнялись.` };
      if (outcome.conflict) {
        outcome.conflict.cleanup = cleanup;
        outcome.conflict.message += ` ${cleanup.message}`;
      } else throw new ProjectToolError(cleanup.message);
    }
  }
  await syncDirectory(directory);
  return { status: "applied", path: relative, before_sha256: actual, after_sha256: sha256(replacement), bytes: replacement.length };
}

// --- SDK tool definitions ---------------------------------------------------

const RepoInspectSchema = Type.Object({
  query: Type.Optional(Type.String({ minLength: PROJECT_TOOL_LIMITS.queryMin, maxLength: PROJECT_TOOL_LIMITS.queryMax,
    description: "Exact text or symbol to locate (case-insensitive). Returns paths and line numbers only, never the matching text." })),
  path: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096,
    description: "Project file for a SHA-256 snapshot (needed by safe_edit), likely tests and applicable AGENTS/manifest files. Relative to the project folder; no symlinks." })),
}, { additionalProperties: false });

const SafeEditSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 4_096, description: "Project file, relative to the project folder; no symlinks." }),
  expected_sha256: Type.String({ pattern: "^[0-9a-f]{64}$", description: "SHA-256 from repo_inspect(path) for the version you read." }),
  old: Type.String({ minLength: 1, description: "Exact, unique text to replace (bytes and line endings must match)." }),
  new: Type.String({ description: "Replacement text." }),
}, { additionalProperties: false });

export function repoInspectTool() {
  return {
    name: REPO_INSPECT_TOOL,
    label: "Обзор проекта",
    description: "Read-only map of the current project: manifests, instructions, top-level folders, npm script names and Git branch. "
      + "With query: bounded path/line search (no matching text). With path: the file's SHA-256 (for safe_edit), likely tests and applicable "
      + "AGENTS/manifest files. Never returns file contents and skips ignored, generated and secret-like files; hits are navigation hints, use read for the text.",
    promptSnippet: "Bounded project map, path/line search and file SHA-256 snapshot",
    parameters: RepoInspectSchema,
    async execute(_toolCallId: string, params: Static<typeof RepoInspectSchema>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
      const report = await inspectRepository(ctx.cwd, params, signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(report) }], details: report };
    },
  };
}

export function safeEditTool() {
  return {
    name: SAFE_EDIT_TOOL,
    label: "Точная правка",
    description: "Replace one exact, unique text in one project file, only if the file still has expected_sha256 (from repo_inspect with path). "
      + "A changed file or missing/ambiguous text is a conflict and nothing is written: re-read and re-inspect, never retry blindly or overwrite the whole file.",
    promptSnippet: "Hash-guarded single exact replacement in a project file",
    promptGuidelines: ["Before safe_edit, call repo_inspect with path to get the SHA-256 of the version you read; after a conflict, read the file again instead of repeating the same call."],
    parameters: SafeEditSchema,
    executionMode: "sequential" as const,
    async execute(_toolCallId: string, params: Static<typeof SafeEditSchema>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
      const result = await safeEdit(ctx.cwd, params, signal);
      if (result.status === "conflict")
        throw new Error(`Конфликт safe_edit (${result.reason}): ${result.message}${result.sha256 ? ` Текущий SHA-256: ${result.sha256}.` : ""}${result.occurrences !== undefined ? ` Совпадений: ${result.occurrences}.` : ""}`);
      return { content: [{ type: "text" as const, text: `Применено: ${result.path}. SHA-256 до ${result.before_sha256}, после ${result.after_sha256}.` }], details: result };
    },
  };
}

const OWN_SOURCES = new Set([PROJECT_TOOLS_EXTENSION, `<inline:${PROJECT_TOOLS_EXTENSION}>`]);

/**
 * True only if `toolName` is one of these tools AND its single effective
 * registration comes from this inline extension (SDK provenance `sourceInfo`).
 * A plugin may register the same name earlier and win; then the Enki gate must
 * treat it as an unknown tool. Any doubt fails closed.
 */
export function isEnkiProjectTool(pi: Pick<SdkExtensionApi, "getAllTools">, toolName: string): boolean {
  if (toolName !== REPO_INSPECT_TOOL && toolName !== SAFE_EDIT_TOOL) return false;
  try {
    const owners = pi.getAllTools().filter(tool => tool.name === toolName);
    return owners.length === 1 && OWN_SOURCES.has(owners[0].sourceInfo?.path);
  } catch { return false; }
}

/** One registration of each tool per session; no state shared between sessions. */
export function projectToolsExtension(): SdkExtension {
  return { name: PROJECT_TOOLS_EXTENSION, factory: (pi) => { pi.registerTool(repoInspectTool()); pi.registerTool(safeEditTool()); } };
}
