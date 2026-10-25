import fs from "node:fs";
import path from "node:path";
import { createEventBus, createExtensionRuntime, createSyntheticSourceInfo, loadSkills,
  parseFrontmatter, type Extension, type ResourceLoader, type LoadExtensionsResult,
  type PromptTemplate, type ResourceDiagnostic } from "@earendil-works/pi-coding-agent";
import type { ResourceSpec, SdkExtension } from "../sdk/adapter.ts";
import { resourceCompat } from "./resource-compat.ts";
import { loadSdkUiCompat, type SdkUiCompat } from "./sdk-ui-compat.ts";

/** Explicit configured resources + explicitly trusted project extensions.
 * No DefaultPackageManager, package fetch, ~/.agents or ambient owner profile. */
export class ScopedResources implements ResourceLoader {
  private extensions: LoadExtensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  private skills: ReturnType<ResourceLoader["getSkills"]> = { skills: [], diagnostics: [] };
  private prompts: ReturnType<ResourceLoader["getPrompts"]> = { prompts: [], diagnostics: [] };
  private agents: ReturnType<ResourceLoader["getAgentsFiles"]> = { agentsFiles: [] };
  private extraSkills: string[] = [];
  private extraPrompts: string[] = [];
  private extraThemes: string[] = [];
  private themes: ReturnType<ResourceLoader["getThemes"]> = { themes: [], diagnostics: [] };
  private themeLoader?: SdkUiCompat;
  private hostTools: { fallbacks: string[]; shadowed: string[] } = { fallbacks: [], shadowed: [] };
  constructor(private readonly cwd: string, private readonly agentDir: string, private readonly spec: ResourceSpec,
    private readonly beforeExtensions: SdkExtension[] = []) {}
  getExtensions() { return this.extensions; }
  /** Host prelude tool names still active as fallbacks vs. yielded to explicit extensions. */
  hostToolResolution(): { fallbacks: string[]; shadowed: string[] } { return { fallbacks: [...this.hostTools.fallbacks], shadowed: [...this.hostTools.shadowed] }; }
  getSkills() { return this.skills; }
  getPrompts() { return this.prompts; }
  getThemes(): ReturnType<ResourceLoader["getThemes"]> { return this.themes; }
  getAgentsFiles() { return this.agents; }
  getSystemPrompt(): undefined { return undefined; }
  getSystemPromptSource(): undefined { return undefined; }
  getAppendSystemPrompt(): string[] { return []; }
  getAppendSystemPromptSources(): [] { return []; }
  extendResources(paths: Parameters<ResourceLoader["extendResources"]>[0]): void {
    // Resource-discovery hooks are trusted extension code; paths remain explicit.
    const valid = (values: { path: string }[] | undefined) => (values ?? []).map(value => {
      if (!path.isAbsolute(value.path)) throw new Error("Расширение вернуло относительный путь ресурса.");
      return value.path;
    });
    this.extraThemes = [...new Set([...this.extraThemes, ...valid(paths.themePaths)])];
    this.extraSkills = [...new Set([...this.extraSkills, ...valid(paths.skillPaths)])];
    this.extraPrompts = [...new Set([...this.extraPrompts, ...valid(paths.promptPaths)])];
    this.loadTextResources();
    this.loadThemes();
  }
  async reload(): Promise<void> {
    this.themeLoader = await loadSdkUiCompat(new URL(import.meta.resolve("@earendil-works/pi-coding-agent")), { agentDir: this.agentDir });
    this.extraSkills = []; this.extraPrompts = []; this.extraThemes = [];
    const compat = await resourceCompat(), runtime = createExtensionRuntime(), bus = createEventBus();
    const paths = [...this.spec.extensionPaths];
    if (!this.spec.noDiscoveredExtensions && await this.spec.projectTrusted(this.cwd)) {
      const directory = path.join(this.cwd, ".pi", "extensions");
      if (fs.existsSync(directory)) for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name)) paths.push(file);
        else if (entry.isDirectory()) {
          const index = ["index.ts", "index.js"].map(name => path.join(file, name)).find(fs.existsSync);
          if (index) paths.push(index);
        }
      }
    }
    if (paths.some(file => !path.isAbsolute(file))) throw new Error("Пути ресурсов Enki должны быть абсолютными.");
    const prelude: Extension[] = [];
    for (const [index, input] of this.beforeExtensions.entries()) {
      const name = typeof input === "function" ? `<enki-host:${index}>` : input.name ?? `<enki-host:${index}>`;
      // Host prerequisites fail closed; optional plugin diagnostics stay intact.
      prelude.push(await compat.inline(typeof input === "function" ? input : input.factory, this.cwd, bus, runtime, name));
    }
    this.extensions = await compat.load([...new Set(paths)], this.cwd, bus, runtime);
    this.extensions.extensions.unshift(...prelude);
    // Inline security/policy extensions use the SAME real SDK runtime/event bus.
    for (const [index, input] of this.spec.extensions.entries()) {
      const name = typeof input === "function" ? `<enki:${index}>` : input.name ?? `<enki:${index}>`;
      try { this.extensions.extensions.push(await compat.inline(typeof input === "function" ? input : input.factory, this.cwd, bus, runtime, name)); }
      catch (error) {
        // Inline Enki gate/policy factories are mandatory trusted host code.
        // Treating their failed initialization like an optional user plugin
        // would leave a live session without its security boundary.
        throw new Error(`Не удалось подключить обязательное расширение Enki ${name}.`, { cause: error });
      }
    }
    // The SDK ExtensionRunner resolves the FIRST registration of a tool name.
    // Host prelude stays first so its event/security setup runs earliest, but
    // its tool definitions are fallbacks only: any name an explicitly
    // configured, trusted-project or inline extension supplies is removed from
    // the host prelude, never from the plugin. Recomputed on every reload.
    const supplied = new Set(this.extensions.extensions.filter(extension => !prelude.includes(extension))
      .flatMap(extension => [...extension.tools.keys()]));
    const shadowed: string[] = [], fallbacks: string[] = [];
    for (const host of prelude) for (const name of [...host.tools.keys()]) {
      if (supplied.has(name)) { host.tools.delete(name); shadowed.push(name); }
      else fallbacks.push(name);
    }
    this.hostTools = { fallbacks, shadowed };
    this.loadTextResources();
    this.loadThemes();
    // A host may explicitly supply inherited workspace instructions. Do not
    // walk arbitrary ancestors or the owner's home from this loader.
    this.agents = { agentsFiles: [...new Set([path.join(this.agentDir, "AGENTS.md"), path.join(this.cwd, "AGENTS.md"), ...(this.spec.contextPaths ?? [])])]
      .filter(file => fs.existsSync(file)).map(file => {
        if (!path.isAbsolute(file) || !fs.statSync(file).isFile() || fs.statSync(file).size > 2 * 1024 * 1024) throw new Error("Файл контекста имеет неверный тип или размер.");
        return { path: file, content: fs.readFileSync(file, "utf8") };
      }) };
  }
  private loadThemes(): void {
    if (!this.themeLoader) throw new Error("Загрузчик тем SDK ещё не готов.");
    const themes: ReturnType<ResourceLoader["getThemes"]>["themes"] = [], diagnostics: ResourceDiagnostic[] = [];
    for (const file of resourceFiles([...(this.spec.themePaths ?? []), ...this.extraThemes], ".json", "темы", diagnostics)) {
      try { themes.push(this.themeLoader.loadTheme(file)); }
      catch (error) { diagnostics.push({ type: "warning", message: error instanceof Error ? error.message : "Ошибка темы", path: file }); }
    }
    this.themes = { themes, diagnostics };
  }
  /**
   * Skills: the pinned SDK loader (first configured path wins a name collision).
   * Prompts: the pinned SDK's loadPromptTemplates rules (not exported by the
   * package index): direct `.md` children of a folder, explicit `.md` files;
   * missing/non-file entries and unreadable/malformed files are diagnostics,
   * never a failed session. A later template of the same name loses (as the
   * SDK's dedupePrompts / expandPromptTemplate first match).
   */
  private loadTextResources(): void {
    this.skills = loadSkills({ cwd: this.cwd, agentDir: this.agentDir,
      skillPaths: [...this.spec.skillPaths, ...this.extraSkills], includeDefaults: false });
    const prompts: PromptTemplate[] = [], diagnostics: ResourceDiagnostic[] = [];
    for (const file of resourceFiles([...this.spec.promptPaths, ...this.extraPrompts], ".md", "шаблона", diagnostics)) {
      let parsed: { frontmatter: Record<string, unknown>; body: string };
      try { parsed = parseFrontmatter(fs.readFileSync(file, "utf8")); }
      catch (error) { diagnostics.push({ type: "warning", message: error instanceof Error ? error.message : "Шаблон не прочитан", path: file }); continue; }
      const { frontmatter, body } = parsed;
      const name = path.basename(file).replace(/\.md$/, "");
      const winner = prompts.find(prompt => prompt.name === name);
      if (winner) {
        diagnostics.push({ type: "collision", message: `name "/${name}" collision`, path: file,
          collision: { resourceType: "prompt", name, winnerPath: winner.filePath, loserPath: file } });
        continue;
      }
      const firstLine = body.split("\n").find(line => line.trim()) ?? "";
      const description = typeof frontmatter.description === "string" && frontmatter.description ? frontmatter.description
        : firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
      prompts.push({ name, description, content: body, filePath: file,
        sourceInfo: createSyntheticSourceInfo(file, { source: "enki-explicit", baseDir: path.dirname(file) }),
        ...(typeof frontmatter["argument-hint"] === "string" ? { argumentHint: frontmatter["argument-hint"] } : {}) });
    }
    this.prompts = { prompts, diagnostics };
  }
}

/** Files of explicit resource roots: a file itself, or a folder's direct
 * children with `suffix`. Bounded (2 MiB per file); everything else is a
 * diagnostic, so one bad entry never prevents the chat from opening. */
function resourceFiles(roots: readonly string[], suffix: string, kind: string, diagnostics: ResourceDiagnostic[]): string[] {
  const out: string[] = [];
  const stat = (file: string) => { try { return fs.statSync(file); } catch { return null; } };
  for (const root of roots) {
    if (!path.isAbsolute(root)) { diagnostics.push({ type: "warning", message: `Путь ${kind} должен быть абсолютным.`, path: root }); continue; }
    const info = stat(root);
    if (!info) { diagnostics.push({ type: "warning", message: `Путь ${kind} не найден.`, path: root }); continue; }
    let candidates: string[];
    if (info.isDirectory()) {
      try { candidates = fs.readdirSync(root).filter(name => name.endsWith(suffix)).sort().map(name => path.join(root, name)); }
      catch (error) { diagnostics.push({ type: "warning", message: error instanceof Error ? error.message : `Папка ${kind} не прочитана.`, path: root }); continue; }
    } else candidates = info.isFile() && root.endsWith(suffix) ? [root] : [];
    for (const file of candidates) {
      const entry = stat(file);
      if (!entry?.isFile()) continue; // a folder named *.md, a broken link: skipped like the SDK
      if (entry.size > 2 * 1024 * 1024) { diagnostics.push({ type: "warning", message: `Файл ${kind} больше 2 МБ; не загружен.`, path: file }); continue; }
      out.push(file);
    }
  }
  return out;
}
