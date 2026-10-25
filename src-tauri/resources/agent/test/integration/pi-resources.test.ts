// Remainder review: explicit trusted Pi resources reach the REAL pinned SDK.
// Observed through what the SDK actually sends the (scripted) provider: its own
// `/template` and `/skill:name` expansion (PromptOptions.expandPromptTemplates
// defaults to true) and the active tool list. Written, NOT RUN.
//   - explicit skill/prompt paths and an explicit LOCAL package activate;
//   - precedence follows the pinned SDK resolve() order (package-manager.js
//     0.85.1: configured packages BEFORE top-level skill/prompt entries, first
//     wins). Final seam review corrected the earlier "explicit path wins"
//     expectation, which contradicted the SDK source;
//   - a malformed/odd prompt entry never prevents the chat from opening;
//   - nothing is discovered (project .pi, unconfigured folders) and package
//     globs/escaping entries are diagnostics, never loaded;
//   - final seam review: the package boundary is PHYSICAL (escaping links,
//     linked skill folders), aliases/cycles are walked once, the walk is bounded
//     even with no matching files, nested extension manifests obey the same
//     policy, and unsupported ignore files are diagnosed (entry not loaded).
//     Own fixture links only; no owner directory is read.
import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, type FauxResponseStep } from "../../src/sdk/testing.ts";
import { PACKAGE_LIMITS, resolveLocalPackage } from "../../src/plugin-ui/local-packages.ts";
import { harness, newSession, promptCommand, tempDir, type Harness } from "../helpers.ts";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

type Seen = { user: string; tools: string[] };
function capture(target: Harness, count = 6): Seen[] {
  const seen: Seen[] = [];
  const step: FauxResponseStep = async (context) => {
    const last = [...context.messages].reverse().find((m) => m.role === "user");
    const content = last?.content;
    const user = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c as { text?: string }).text ?? "").join("") : "";
    seen.push({ user, tools: (context.tools ?? []).map((t) => t.name) });
    return fauxAssistantMessage("ok");
  };
  target.scripted.setResponses(Array.from({ length: count }, () => step));
  return seen;
}

function write(file: string, content: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} fixture skill\n---\n${body}\n`;
const EXTENSION = `export default function (pi) {
  pi.registerTool({ name: "pkg_tool", label: "Package tool", description: "Tool from an explicit local package",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: "pkg" }], details: {} }) });
}
`;

async function turn(target: Harness, sid: string, dir: string, id: string, text: string): Promise<void> {
  await target.command(promptCommand(target, id, sid, dir, text));
  expect((await target.waitReceipt(id, ["completed", "failed", "rejected"])).state).toBe("completed");
}

it("explicit skills, prompts and a local package activate in the real SDK; a package resource wins a name collision (SDK order)", async () => {
  const root = tempDir("pi-resources");
  const skillsA = path.join(root, "skills-a"), promptsA = path.join(root, "prompts-a"), pkg = path.join(root, "pkg");
  write(path.join(skillsA, "review-helper", "SKILL.md"), skill("review-helper", "BODY-EXPLICIT"));
  write(path.join(promptsA, "greet.md"), "Explicit greet $1");
  write(path.join(pkg, "skills", "review-helper", "SKILL.md"), skill("review-helper", "BODY-PACKAGE"));
  write(path.join(pkg, "skills", "pkg-only", "SKILL.md"), skill("pkg-only", "BODY-PKG-ONLY"));
  write(path.join(pkg, "prompts", "greet.md"), "Package greet $1");
  write(path.join(pkg, "prompts", "pkg-prompt.md"), "From package: $ARGUMENTS");
  write(path.join(pkg, "extensions", "pkg-tool.js"), EXTENSION);
  h = await harness();
  const saved = await h.request("PUT", "/settings", { skillPaths: [skillsA], promptPaths: [promptsA], packagePaths: [pkg] });
  expect(saved.status).toBe(200);
  const dir = h.project("pi-resources"), sid = await newSession(h, dir);
  const seen = capture(h);
  await turn(h, sid, dir, "r-greet", "/greet Igor");
  await turn(h, sid, dir, "r-skill", "/skill:review-helper");
  await turn(h, sid, dir, "r-pkg-skill", "/skill:pkg-only");
  await turn(h, sid, dir, "r-pkg-prompt", "/pkg-prompt hello there");
  expect(seen).toHaveLength(4);
  // Same-named resources: the configured package precedes the top-level entry.
  expect(seen[0].user).toContain("Package greet Igor");
  expect(seen[0].user).not.toContain("Explicit greet");
  expect(seen[1].user).toContain("BODY-PACKAGE");
  expect(seen[1].user).not.toContain("BODY-EXPLICIT");
  expect(seen[2].user).toContain("BODY-PKG-ONLY");
  expect(seen[3].user).toContain("From package: hello there");
  expect(seen[0].tools).toContain("pkg_tool");
  // Package skill folders are expanded into SKILL.md files (2 skills), never
  // handed to the SDK's own unbounded directory walker.
  const status = await h.request<{ packages: Array<{ path: string; present: boolean; extensions: number; skills: number; prompts: number; diagnostics: string[] }> }>("GET", "/settings/resources");
  expect(status.body.packages).toEqual([{ path: pkg, present: true, extensions: 1, skills: 2, prompts: 2, themes: 0, diagnostics: [] }]);
});

it("an explicit skill path still activates when no package defines the same name", async () => {
  const root = tempDir("pi-resources-explicit");
  const skillsA = path.join(root, "skills-a"), pkg = path.join(root, "pkg");
  write(path.join(skillsA, "explicit-only", "SKILL.md"), skill("explicit-only", "BODY-EXPLICIT-ONLY"));
  write(path.join(pkg, "skills", "pkg-only", "SKILL.md"), skill("pkg-only", "BODY-PKG-ONLY"));
  h = await harness();
  expect((await h.request("PUT", "/settings", { skillPaths: [skillsA], packagePaths: [pkg] })).status).toBe(200);
  const dir = h.project("pi-resources-explicit"), sid = await newSession(h, dir);
  const seen = capture(h);
  await turn(h, sid, dir, "e-skill", "/skill:explicit-only");
  expect(seen[0].user).toContain("BODY-EXPLICIT-ONLY");
});

it("one package folder may provide both skills and prompts through the real SDK", async () => {
  const root = tempDir("pi-shared-resource-query"), pkg = path.join(root, "pkg");
  const shared = write(path.join(pkg, "assets", "shared-resource.md"), skill("shared-resource", "SHARED-RESOURCE $ARGUMENTS"));
  write(path.join(pkg, "package.json"), JSON.stringify({ pi: { skills: ["assets"], prompts: ["assets"] } }));
  const resolved = resolveLocalPackage(pkg);
  expect(resolved.skills).toEqual([shared]);
  expect(resolved.prompts).toEqual([shared]);
  expect(resolved.diagnostics).toEqual([]);
  h = await harness();
  expect((await h.request("PUT", "/settings", { packagePaths: [pkg] })).status).toBe(200);
  const dir = h.project("pi-shared-resource-query"), sid = await newSession(h, dir), seen = capture(h);
  await turn(h, sid, dir, "shared-prompt", "/shared-resource expanded");
  await turn(h, sid, dir, "shared-skill", "/skill:shared-resource");
  expect(seen).toHaveLength(2);
  expect(seen[0].user).toContain("SHARED-RESOURCE expanded");
  expect(seen[1].user).toContain("SHARED-RESOURCE");
});

it("a refused overlapping package query does not hide a later explicit clean folder", async () => {
  const root = tempDir("pi-overlapping-resource-query"), pkg = path.join(root, "pkg");
  write(path.join(pkg, "docs", ".gitignore"), "blocked.md\n");
  write(path.join(pkg, "docs", "blocked.md"), "MUST-NOT-LOAD");
  const kept = write(path.join(pkg, "docs", "clean", "kept.md"), "CLEAN-QUERY $1");
  write(path.join(pkg, "package.json"), JSON.stringify({ pi: { prompts: ["docs", "docs/clean"] } }));
  const resolved = resolveLocalPackage(pkg);
  expect(resolved.prompts).toEqual([kept]);
  expect(resolved.diagnostics).toEqual([expect.stringContaining("Файл исключений docs")]);
  h = await harness();
  expect((await h.request("PUT", "/settings", { packagePaths: [pkg] })).status).toBe(200);
  const dir = h.project("pi-overlapping-resource-query"), sid = await newSession(h, dir), seen = capture(h);
  await turn(h, sid, dir, "clean-query", "/kept survives");
  expect(seen[0].user).toContain("CLEAN-QUERY survives");
  expect(seen[0].user).not.toContain("MUST-NOT-LOAD");
});

const link = (target: string, at: string) => {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
};

it("links that leave the package are refused physically; nothing outside is returned", () => {
  const root = tempDir("pi-pkg-escape"), pkg = path.join(root, "pkg"), outside = path.join(root, "outside");
  write(path.join(outside, "secret.md"), "OUTSIDE");
  write(path.join(outside, "evil.js"), EXTENSION);
  write(path.join(outside, "stolen", "SKILL.md"), skill("stolen", "OUTSIDE"));
  write(path.join(pkg, "prompts", "fine.md"), "fine");
  link(outside, path.join(pkg, "prompts", "link"));
  link(outside, path.join(pkg, "extensions", "linked"));
  write(path.join(pkg, "skills", "ok", "SKILL.md"), skill("ok", "inside"));
  link(path.join(outside, "stolen"), path.join(pkg, "skills", "stolen"));
  const resolved = resolveLocalPackage(pkg);
  const all = [...resolved.extensions, ...resolved.skills, ...resolved.prompts, ...resolved.themes];
  expect(resolved.prompts).toEqual([path.join(pkg, "prompts", "fine.md")]);
  expect(resolved.skills).toEqual([path.join(pkg, "skills", "ok", "SKILL.md")]);
  expect(resolved.extensions).toEqual([]);
  expect(all.every((file) => !fs.realpathSync(file).startsWith(fs.realpathSync(outside)))).toBe(true);
  expect(resolved.diagnostics.some((d) => d.includes("за пределы пакета") && d.includes(path.join("prompts", "link")))).toBe(true);
  expect(resolved.diagnostics.some((d) => d.includes(path.join("skills", "stolen")))).toBe(true);
  // A manifest entry that is lexically inside but physically a link out.
  const viaManifest = path.join(root, "pkg-manifest");
  link(outside, path.join(viaManifest, "docs"));
  write(path.join(viaManifest, "package.json"), JSON.stringify({ pi: { prompts: ["docs"], extensions: ["docs/evil.js"] } }));
  const manifest = resolveLocalPackage(viaManifest);
  expect(manifest.prompts).toEqual([]);
  expect(manifest.extensions).toEqual([]);
  expect(manifest.diagnostics.some((d) => d.includes("за пределы пакета"))).toBe(true);
});

it("aliases and cycles are walked once per physical directory; the walk stops even without matching files", () => {
  const root = tempDir("pi-pkg-cycle"), pkg = path.join(root, "pkg");
  write(path.join(pkg, "prompts", "real", "one.md"), "one");
  link(path.join(pkg, "prompts", "real"), path.join(pkg, "prompts", "alias"));
  link(path.join(pkg, "prompts"), path.join(pkg, "prompts", "real", "loop"));
  const resolved = resolveLocalPackage(pkg);
  // `alias` (sorted first) and `real` are one physical folder: one file, once.
  expect(resolved.prompts).toHaveLength(1);
  expect(path.basename(resolved.prompts[0])).toBe("one.md");
  // No matching files at all, but a deep, wide alias fan-out: bounded work.
  const empty = path.join(root, "empty-pkg"), themes = path.join(empty, "themes");
  fs.mkdirSync(themes, { recursive: true });
  for (let i = 0; i < 8; i++) link(themes, path.join(themes, `a${i}`));
  const started = Date.now();
  const bounded = resolveLocalPackage(empty);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(bounded.themes).toEqual([]);
  expect(bounded.diagnostics).toEqual([expect.stringContaining("не найдено ресурсов (themes: themes)")]);
});

it("a package whose walk exceeds the directory bound loads nothing of that entry and says so", () => {
  const root = tempDir("pi-pkg-bound"), pkg = path.join(root, "pkg");
  for (let i = 0; i <= PACKAGE_LIMITS.directories; i++) fs.mkdirSync(path.join(pkg, "prompts", `d${String(i).padStart(4, "0")}`), { recursive: true });
  write(path.join(pkg, "prompts", "zzz.md"), "after the bound");
  const resolved = resolveLocalPackage(pkg);
  expect(resolved.prompts).toEqual([]);
  expect(resolved.diagnostics.some((d) => d.includes("предел") && d.includes("prompts: prompts"))).toBe(true);
});

it("nested extension manifests obey the pattern and boundary policy; ignore files are diagnosed, not guessed", () => {
  const root = tempDir("pi-pkg-nested"), pkg = path.join(root, "pkg"), outside = path.join(root, "outside");
  write(path.join(outside, "evil.js"), EXTENSION);
  write(path.join(pkg, "extensions", "sub", "good.js"), EXTENSION);
  write(path.join(pkg, "extensions", "sub", "package.json"), JSON.stringify({ pi: { extensions: ["*.js", "../../../outside/evil.js", "good.js"] } }));
  write(path.join(pkg, "prompts", "keep.md"), "keep");
  write(path.join(pkg, "prompts", "drop.md"), "drop");
  write(path.join(pkg, "prompts", ".gitignore"), "drop.md\n");
  write(path.join(pkg, "themes", "dark.json"), "{}");
  const resolved = resolveLocalPackage(pkg);
  expect(resolved.extensions).toEqual([path.join(pkg, "extensions", "sub", "good.js")]);
  expect(resolved.diagnostics.some((d) => d.includes("Шаблоны") && d.includes("*.js"))).toBe(true);
  expect(resolved.diagnostics.some((d) => d.includes("за пределы пакета") && d.includes("evil.js"))).toBe(true);
  // The SDK would honour .gitignore; Enki cannot, so the whole entry is refused honestly.
  expect(resolved.prompts).toEqual([]);
  expect(resolved.diagnostics.some((d) => d.includes(".gitignore") && d.includes("prompts: prompts"))).toBe(true);
  // An unrelated entry of the same package is unaffected.
  expect(resolved.themes).toEqual([path.join(pkg, "themes", "dark.json")]);
});

it("a malformed prompt file or a folder named *.md is a diagnostic, never a chat that cannot open", async () => {
  const root = tempDir("pi-prompts-odd"), prompts = path.join(root, "prompts");
  write(path.join(prompts, "ok.md"), "Fine prompt $1");
  write(path.join(prompts, "bad.md"), "---\nkey: [unclosed\n---\nbody\n");
  fs.mkdirSync(path.join(prompts, "folder.md"));
  h = await harness();
  expect((await h.request("PUT", "/settings", { promptPaths: [prompts] })).status).toBe(200);
  const dir = h.project("pi-prompts-odd"), sid = await newSession(h, dir);
  const seen = capture(h);
  await turn(h, sid, dir, "odd-ok", "/ok works");
  expect(seen[0].user).toContain("Fine prompt works");
});

it("nothing is discovered: project .pi resources and unconfigured folders stay inactive", async () => {
  h = await harness();
  const dir = h.project("pi-no-discovery");
  write(path.join(dir, ".pi", "prompts", "sneaky.md"), "SNEAKY-PROJECT-PROMPT");
  write(path.join(dir, ".pi", "skills", "sneaky-skill", "SKILL.md"), skill("sneaky-skill", "SNEAKY-PROJECT-SKILL"));
  write(path.join(dir, ".pi", "extensions", "sneaky.js"), EXTENSION);
  const sid = await newSession(h, dir);
  const seen = capture(h);
  await turn(h, sid, dir, "nd-prompt", "/sneaky");
  await turn(h, sid, dir, "nd-skill", "/skill:sneaky-skill");
  expect(seen[0].user).not.toContain("SNEAKY-PROJECT-PROMPT");
  expect(seen[1].user).not.toContain("SNEAKY-PROJECT-SKILL");
  expect(seen[0].tools).not.toContain("pkg_tool");
});

it("a package manifest is honoured with plain entries; globs, escaping entries and missing packages are diagnostics", () => {
  const root = tempDir("pi-manifest"), pkg = path.join(root, "pkg"), outside = path.join(root, "outside");
  write(path.join(outside, "secret.md"), "outside the package");
  write(path.join(pkg, "lib", "tool.js"), EXTENSION);
  write(path.join(pkg, "docs", "a.md"), "A");
  write(path.join(pkg, "docs", "nested", "b.md"), "B");
  // Conventional folders are ignored once a manifest exists (SDK rule).
  write(path.join(pkg, "prompts", "ignored.md"), "ignored");
  write(path.join(pkg, "package.json"), JSON.stringify({ name: "fixture", pi: { extensions: ["lib/tool.js"], prompts: ["docs", "../outside/secret.md", "docs/*.md"] } }));
  const resolved = resolveLocalPackage(pkg);
  expect(resolved.extensions).toEqual([path.join(pkg, "lib", "tool.js")]);
  expect(resolved.prompts).toEqual([path.join(pkg, "docs", "a.md"), path.join(pkg, "docs", "nested", "b.md")]);
  expect(resolved.skills).toEqual([]);
  expect(resolved.diagnostics.some((d) => d.includes("../outside/secret.md"))).toBe(true);
  expect(resolved.diagnostics.some((d) => d.includes("docs/*.md"))).toBe(true);
  expect(resolved.prompts.some((p) => p.includes("ignored") || p.includes("outside"))).toBe(false);
  const missing = resolveLocalPackage(path.join(root, "gone"));
  expect(missing).toMatchObject({ extensions: [], skills: [], prompts: [], themes: [] });
  expect(missing.diagnostics).toHaveLength(1);
  expect(resolveLocalPackage("relative/pkg").diagnostics).toHaveLength(1);
});
