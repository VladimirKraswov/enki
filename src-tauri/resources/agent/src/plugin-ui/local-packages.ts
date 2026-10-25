// Explicitly configured LOCAL Pi packages (directories already on this host).
//
// Layout rules follow the pinned SDK 0.85.1 package manager for a local package
// (core/package-manager.js collectPackageResources, core/pi-manifest.js):
//   - package.json `pi` object: string arrays `extensions|skills|prompts|themes`,
//     each entry a path relative to the package root; a manifest replaces the
//     conventional folders for ALL types (SDK: manifest fields as one group);
//   - otherwise the conventional `extensions/ skills/ prompts/ themes/` folders;
//   - skills: SKILL.md short-circuits its folder, top-level .md files of the
//     skills root, recursion otherwise (collectSkillEntries "pi"); prompts and
//     themes: recursive .md / .json (collectFiles); extensions: a folder's own
//     manifest/index, else its top-level .ts/.js files and subpackages.
// Enki enforces a STRICTER subset than the SDK, which follows links without a
// boundary or a work bound:
//   - every resource and every walked directory must PHYSICALLY lie inside the
//     package (links are resolved; an escaping link is a diagnostic);
//   - each physical directory is walked once per resource query (aliases/cycles), and the walk is
//     bounded in directories, examined entries and returned files; exceeding a
//     bound drops the affected entry with a diagnostic instead of loading part;
//   - glob/override patterns (also inside nested extension manifests), entries
//     escaping the package, npm:/git: sources and installation are refused;
//   - ignore files (.gitignore/.ignore/.fdignore) are NOT interpreted: an entry
//     whose walk meets one is not loaded (its exclusions cannot be honoured), and
//     the diagnostic says so. Exact file entries are unaffected, as in the SDK.
// Skill folders are expanded HERE into files, so the SDK's own unbounded skill
// walker never sees a package directory. Nothing is discovered: a package is
// trusted only because the owner configured its absolute path in Enki.

import fs from "node:fs";
import path from "node:path";

export interface LocalPackageResources {
  root: string;
  extensions: string[];
  skills: string[];
  prompts: string[];
  themes: string[];
  diagnostics: string[];
}

const TYPES = ["extensions", "skills", "prompts", "themes"] as const;
type ResourceType = typeof TYPES[number];
const PATTERN = /[*?[\]{}]|^[!+-]/;
const IGNORE_FILES = new Set([".gitignore", ".ignore", ".fdignore"]);
/** Per package: matching resources returned, directory visits across queries,
 * directory entries examined, diagnostics kept. */
export const PACKAGE_LIMITS = { files: 512, directories: 256, entries: 8192, diagnostics: 40 } as const;

type Kind = "file" | "directory";

function kind(file: string): Kind | null {
  try { const stat = fs.statSync(file); return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : null; }
  catch { return null; }
}

function physical(file: string): string | null {
  try { return fs.realpathSync(file); } catch { return null; }
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Shared work bound and physical boundary of ONE package resolution. */
class Walk {
  directories = 0;
  entries = 0;
  files = 0;
  exhausted = false;
  /** Ignore files met since the current entry started (relative paths). */
  ignored: string[] = [];
  private readonly visited = new Set<string>();

  constructor(readonly root: string, readonly real: string, private readonly diagnostics: string[]) {}

  /** Different manifest entries/types may intentionally read the same folder.
   * Cycle detection belongs to that query; actual work remains package-bounded. */
  beginEntry(): void { this.visited.clear(); this.ignored = []; }

  note(message: string): void {
    if (this.diagnostics.length < PACKAGE_LIMITS.diagnostics && !this.diagnostics.includes(message)) this.diagnostics.push(message);
  }

  relative(file: string): string { return path.relative(this.root, file) || "."; }

  /** Physical path of an existing path inside the package, else null (diagnosed). */
  inside(file: string): string | null {
    const real = physical(file);
    if (!real) return null;
    if (within(this.real, real)) return real;
    this.note(`Ссылка выходит за пределы пакета (${this.relative(file)}); не загружено.`);
    return null;
  }

  /** Visible entries of one physical directory, once in the current query. */
  list(dir: string): Array<{ name: string; full: string; type: Kind }> {
    const real = this.inside(dir);
    if (!real || this.visited.has(real) || this.exhausted) return [];
    if (this.directories >= PACKAGE_LIMITS.directories) { this.exhausted = true; return []; }
    this.visited.add(real); this.directories++;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const out: Array<{ name: string; full: string; type: Kind }> = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (this.entries >= PACKAGE_LIMITS.entries) { this.exhausted = true; break; }
      this.entries++;
      if (IGNORE_FILES.has(entry.name)) this.ignored.push(this.relative(path.join(dir, entry.name)));
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      let type: Kind | null = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : null;
      if (entry.isSymbolicLink()) {
        // A broken link is skipped (SDK); an escaping one is a diagnostic.
        if (!physical(full)) continue;
        if (!this.inside(full)) continue;
        type = kind(full);
      }
      if (type) out.push({ name: entry.name, full, type });
    }
    return out;
  }

  take(file: string, out: string[]): void {
    if (this.files >= PACKAGE_LIMITS.files) { this.exhausted = true; return; }
    this.files++; out.push(file);
  }
}

/** Recursive files by suffix; dot entries and node_modules skipped (SDK collectFiles). */
function files(walk: Walk, dir: string, suffix: RegExp, out: string[] = []): string[] {
  for (const entry of walk.list(dir)) {
    if (walk.exhausted) break;
    if (entry.type === "directory") files(walk, entry.full, suffix, out);
    else if (suffix.test(entry.name)) walk.take(entry.full, out);
  }
  return out;
}

/** SDK collectSkillEntries(dir, "pi"): a folder's SKILL.md ends it; top-level .md
 * files only at the skills root; otherwise recurse. */
function skills(walk: Walk, dir: string, top: string, out: string[] = []): string[] {
  const listed = walk.list(dir);
  const declared = listed.find((entry) => entry.name === "SKILL.md" && entry.type === "file");
  if (declared) { walk.take(declared.full, out); return out; }
  for (const entry of listed) {
    if (walk.exhausted) break;
    if (entry.type === "file" && entry.name.endsWith(".md") && dir === top) walk.take(entry.full, out);
    else if (entry.type === "directory") skills(walk, entry.full, top, out);
  }
  return out;
}

/** SDK resolveExtensionEntries: `pi.extensions` of a nested package.json, else
 * index.ts/index.js. Nested entries obey the same path/pattern policy. */
function extensionEntries(walk: Walk, dir: string): string[] | null {
  const manifest = readManifest(path.join(dir, "package.json"));
  const declared: string[] = [];
  for (const entry of manifest?.extensions ?? []) {
    if (PATTERN.test(entry)) { walk.note(`Шаблоны путей в пакете не поддерживаются (${walk.relative(dir)}/package.json extensions: ${entry}); запись не загружена.`); continue; }
    const file = path.resolve(dir, entry);
    if (!within(walk.root, file)) { walk.note(`Путь выходит за пределы пакета (${walk.relative(dir)}/package.json extensions: ${entry}); запись не загружена.`); continue; }
    if (kind(file) !== null && walk.inside(file)) walk.take(file, declared);
  }
  if (declared.length) return declared;
  for (const name of ["index.ts", "index.js"]) {
    const file = path.join(dir, name);
    if (kind(file) === "file" && walk.inside(file)) { const out: string[] = []; walk.take(file, out); return out; }
  }
  return null;
}

/** SDK collectAutoExtensionEntries: the folder itself, or its top-level files/subpackages. */
function autoExtensions(walk: Walk, dir: string): string[] {
  const own = extensionEntries(walk, dir);
  if (own) return own;
  const out: string[] = [];
  for (const entry of walk.list(dir)) {
    if (walk.exhausted) break;
    if (entry.type === "file" && /\.(ts|js)$/.test(entry.name)) walk.take(entry.full, out);
    else if (entry.type === "directory") out.push(...(extensionEntries(walk, entry.full) ?? []));
  }
  return out;
}

const BOM = String.fromCharCode(0xfeff);

function readManifest(file: string): Partial<Record<ResourceType, string[]>> | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw.startsWith(BOM) ? raw.slice(1) : raw);
    const pi = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { pi?: unknown }).pi : undefined;
    if (!pi || typeof pi !== "object" || Array.isArray(pi)) return null;
    const manifest: Partial<Record<ResourceType, string[]>> = {};
    for (const type of TYPES) {
      const entries = (pi as Record<string, unknown>)[type];
      if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) manifest[type] = entries as string[];
    }
    return manifest;
  } catch { return null; }
}

function expand(walk: Walk, type: ResourceType, target: string): string[] {
  const what = kind(target);
  if (what === "file") { const out: string[] = []; walk.take(target, out); return out; }
  if (what !== "directory") return [];
  if (type === "extensions") return autoExtensions(walk, target);
  if (type === "skills") return skills(walk, target, target);
  return files(walk, target, type === "prompts" ? /\.md$/ : /\.json$/);
}

/** Resolve one explicitly configured local package. Never throws for package
 * content; problems are diagnostics and the affected entry is not loaded. */
export function resolveLocalPackage(root: string): LocalPackageResources {
  const result: LocalPackageResources = { root, extensions: [], skills: [], prompts: [], themes: [], diagnostics: [] };
  if (!path.isAbsolute(root)) { result.diagnostics.push(`Путь пакета должен быть абсолютным: ${root}`); return result; }
  const real = kind(root) === "directory" ? physical(root) : null;
  if (!real) { result.diagnostics.push(`Пакет Pi не найден или не является папкой: ${root}`); return result; }
  const walk = new Walk(root, real, result.diagnostics);
  const manifest = readManifest(path.join(root, "package.json"));
  for (const type of TYPES) {
    const entries = manifest ? manifest[type] : (kind(path.join(root, type)) === "directory" ? [type] : undefined);
    for (const entry of entries ?? []) {
      if (PATTERN.test(entry)) { walk.note(`Шаблоны путей в пакете не поддерживаются (${type}: ${entry}); запись не загружена.`); continue; }
      const target = path.resolve(root, entry);
      if (!within(root, target)) { walk.note(`Путь выходит за пределы пакета (${type}: ${entry}); запись не загружена.`); continue; }
      if (kind(target) !== null && !walk.inside(target)) continue;
      if (walk.exhausted) { walk.note(`Обход пакета остановлен на пределе (${PACKAGE_LIMITS.directories} папок, ${PACKAGE_LIMITS.entries} записей, ${PACKAGE_LIMITS.files} файлов); ${type}: ${entry} не загружено.`); continue; }
      walk.beginEntry();
      const found = expand(walk, type, target);
      if (walk.exhausted) {
        walk.note(`Обход пакета остановлен на пределе (${PACKAGE_LIMITS.directories} папок, ${PACKAGE_LIMITS.entries} записей, ${PACKAGE_LIMITS.files} файлов); ${type}: ${entry} не загружено.`);
        continue;
      }
      if (walk.ignored.length) {
        walk.note(`Файл исключений ${walk.ignored[0]} не поддерживается Enki: его правила не применяются, поэтому ${type}: ${entry} не загружено. Перечислите нужные файлы в package.json (pi.${type}).`);
        continue;
      }
      if (!found.length) walk.note(`В пакете не найдено ресурсов (${type}: ${entry}).`);
      result[type].push(...found);
    }
  }
  for (const type of TYPES) result[type] = [...new Set(result[type])];
  return result;
}
