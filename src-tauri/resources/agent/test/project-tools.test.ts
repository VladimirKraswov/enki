// Enki project tools (extensions/project-tools.ts): file behavior of repo_inspect
// and safe_edit on test-owned fixtures, their registration through enkiExtensions
// and the gate classification in interaction/access.ts. Expected values come from
// the fixtures (independent SHA-256 of the bytes, literal file contents), not
// from the implementation. Successor coverage for the retired
// integrations/opencode-agent/test_tools.py cases plus the new scope/race rules.
// Written, NOT RUN.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enkiExtensions, type ExtensionDeps } from "../src/extensions/enki.ts";
import {
  PROJECT_TOOL_LIMITS, PROJECT_TOOLS_EXTENSION, ProjectToolError, ignoredBy, inspectRepository, isEnkiProjectTool, parseIgnore, safeEdit,
} from "../src/extensions/project-tools.ts";
import { decide } from "../src/interaction/access.ts";
import { prepareToolPaths, ProjectPathError } from "../src/interaction/access-paths.ts";
import { exactIdentity } from "../src/interaction/grants.ts";
import type { PermissionRule } from "../src/protocol.ts";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function write(base: string, name: string, content: string | Buffer): string {
  const file = path.join(base, ...name.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
function fixture(files: Record<string, string | Buffer> = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "enki-project-tools-")));
  roots.push(root);
  const project = path.join(root, "project"), outside = path.join(root, "outside");
  fs.mkdirSync(project); fs.mkdirSync(outside);
  for (const [name, content] of Object.entries(files)) write(project, name, content);
  return { root, project, outside, file: (name: string) => path.join(project, ...name.split("/")) };
}
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const hashOf = (file: string) => sha(fs.readFileSync(file));
const staged = (directory: string) => fs.readdirSync(directory).filter(name => name.startsWith(".enki-safe-edit-")).sort();
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(predicate()).toBe(true);
}

describe("repo_inspect", () => {
  it("search returns path/line locations only and skips private, secret, ignored, generated, lock and linked content", async () => {
    const f = fixture({
      "src/planner.py": "def plan_step():\n    return 'READY'\n",
      ".local/receipt.txt": "READY private receipt",
      ".env": "TOKEN=READY-credential",
      "keys/deploy.pem": "READY-pem",
      ".gitignore": "dist/\n*.log\n",
      "dist/bundle.js": "READY bundle",
      "debug.log": "READY log",
      "node_modules/pkg/index.js": "READY dependency",
      "yarn.lock": "READY lock-content",
    });
    write(f.outside, "linked.txt", "READY outside");
    fs.symlinkSync(f.outside, path.join(f.project, "linked-dir"));
    fs.symlinkSync(path.join(f.outside, "linked.txt"), path.join(f.project, "linked-file.txt"));
    const report = await inspectRepository(f.project, { query: "ready" });
    expect(report.search?.locations).toEqual([{ path: "src/planner.py", line: 2 }]);
    const json = JSON.stringify(report);
    for (const leaked of ["return 'READY'", "receipt", "credential", "READY-pem", "bundle", "linked.txt", "dependency", "lock-content"]) expect(json).not.toContain(leaked);
    expect(report.search?.skipped).toMatchObject({ symlinks: 2, sensitive: 3, ignored: 2, generated: 1, lockfiles: 1 });
    expect(report.search?.truncated).toBe(false);
    expect(report.top_level).toEqual(["keys", "src"]);
    expect(report.note).toMatch(/not evidence/);
  });

  it("a snapshot hashes the exact bytes and lists likely tests and root-to-leaf instructions/manifests without their contents", async () => {
    const f = fixture({
      "AGENTS.md": "root rules SECRET-RULE",
      ".pi/TASK.md": "checkpoint text",
      "src/AGENTS.md": "source rules",
      "src/package.json": "{}",
      "package.json": JSON.stringify({ packageManager: "npm@11.0.0", scripts: { test: "vitest run --token=abc", build: "node build.mjs" } }),
      "src/planner.py": "def plan_step():\n    return 'READY'\n",
      "src/plannerClass.py": "class plannerClass: pass\n",
      "tests/test_planner.py": "from src.planner import plan_step\n",
      "tests/test_safety.py": "from src.planner import plannerClass\n",
      "tests/unrelated_test.py": "nothing here\n",
    });
    const report = await inspectRepository(f.project, { path: "src/planner.py" });
    expect(report.file).toMatchObject({
      path: "src/planner.py", bytes: fs.statSync(f.file("src/planner.py")).size, sha256: hashOf(f.file("src/planner.py")), encoding: "utf-8", safe_edit: "ok",
      applicable_instructions: ["AGENTS.md", ".pi/TASK.md", "src/AGENTS.md"], applicable_manifests: ["package.json", "src/package.json"],
    });
    expect(report.file?.matching_tests).toContain("tests/test_planner.py");
    expect(report.file?.matching_tests).not.toContain("tests/unrelated_test.py");
    expect(report.instructions).toEqual(["AGENTS.md", ".pi/TASK.md"]);
    expect(report.manifests).toEqual(["package.json"]);
    expect(report.package_manager).toBe("npm@11.0.0");
    expect(report.npm_script_names).toEqual(["build", "test"]);
    const json = JSON.stringify(report);
    for (const content of ["SECRET-RULE", "checkpoint text", "return 'READY'", "vitest run", "token=abc"]) expect(json).not.toContain(content);
    // A test that only references the module by name is found through its source.
    expect((await inspectRepository(f.project, { path: "src/plannerClass.py" })).file?.matching_tests).toContain("tests/test_safety.py");
  });

  it("reports the branch from .git/HEAD without running git and does not follow a .git pointer file", async () => {
    const f = fixture({ ".git/HEAD": "ref: refs/heads/feature/x\n" });
    expect((await inspectRepository(f.project, {})).git).toEqual({ repository: true, head: "feature/x" });
    const worktree = fixture({ ".git": `gitdir: ${path.join(os.tmpdir(), "elsewhere")}\n` });
    expect((await inspectRepository(worktree.project, {})).git).toEqual({ repository: true, head: null });
    expect((await inspectRepository(fixture().project, {})).git).toEqual({ repository: false, head: null });
  });

  it("binary and invalid UTF-8 files are hashed but neither searched nor editable", async () => {
    const latinBytes = Buffer.from([0x52, 0x45, 0x41, 0x44, 0x59, 0x20, 0xff, 0xfe, 0x0a]);
    const f = fixture({ "bin/data.bin": Buffer.from([0x52, 0x45, 0x41, 0x44, 0x59, 0x00, 0x01]), "bin/latin.txt": latinBytes });
    const report = await inspectRepository(f.project, { query: "READY" });
    expect(report.search?.locations).toEqual([]);
    expect(report.search?.skipped).toMatchObject({ binary: 1, invalid_utf8: 1 });
    const snapshot = await inspectRepository(f.project, { path: "bin/latin.txt" });
    expect(snapshot.file).toMatchObject({ encoding: "invalid_utf8", safe_edit: "invalid_utf8", sha256: sha(latinBytes) });
    await expect(safeEdit(f.project, { path: "bin/latin.txt", expected_sha256: sha(latinBytes), old: "READY", new: "DONE" })).rejects.toBeInstanceOf(ProjectToolError);
    expect(fs.readFileSync(f.file("bin/latin.txt")).equals(latinBytes)).toBe(true);
  });

  it("work, result and size bounds stop the walk and say so instead of pretending completeness", async () => {
    const f = fixture({ ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`many/f${String(i).padStart(2, "0")}.txt`, "needle\n"])), "big.txt": `${"needle ".repeat(20)}\n` });
    const capped = await inspectRepository(f.project, { query: "needle" });
    expect(capped.search?.locations).toHaveLength(PROJECT_TOOL_LIMITS.locations);
    expect(capped.search).toMatchObject({ truncated: true, exhausted: null });
    const entries = await inspectRepository(f.project, { query: "needle" }, undefined, { ...PROJECT_TOOL_LIMITS, entries: 10 });
    expect(entries.search).toMatchObject({ truncated: true, exhausted: "entries" });
    expect(entries.search!.locations.length).toBeLessThan(10);
    const files = await inspectRepository(f.project, { query: "needle" }, undefined, { ...PROJECT_TOOL_LIMITS, filesRead: 3 });
    expect(files.search).toMatchObject({ truncated: true, exhausted: "files" });
    expect(files.search?.locations).toHaveLength(3);
    const small = { ...PROJECT_TOOL_LIMITS, fileBytes: 64 };
    const sized = await inspectRepository(f.project, { query: "needle" }, undefined, small);
    expect(sized.search?.locations.map(location => location.path)).not.toContain("big.txt");
    expect(sized.search?.skipped.oversize).toBe(1);
    await expect(inspectRepository(f.project, { path: "big.txt" }, undefined, small)).rejects.toBeInstanceOf(ProjectToolError);
    for (const query of ["n", "two\nlines", "x".repeat(121)]) await expect(inspectRepository(f.project, { query }), JSON.stringify(query)).rejects.toBeInstanceOf(ProjectToolError);
  });

  it("output stays within its character bound by shortening lists and flags the cut", async () => {
    const f = fixture(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`${String(i).padStart(2, "0")}${"d".repeat(100)}/keep.txt`, "x\n"])));
    const report = await inspectRepository(f.project, {}, undefined, { ...PROJECT_TOOL_LIMITS, outputChars: 2_000 });
    expect(JSON.stringify(report).length).toBeLessThanOrEqual(2_000);
    expect(report.output_truncated).toBe(true);
    expect(report.top_level.length).toBeGreaterThan(0);
    expect(report.top_level.length).toBeLessThan(40);
  });

  it("deep applicable guidance is bounded too, without changing the file snapshot identity", async () => {
    const f = fixture({ "AGENTS.md": "root guidance", "package.json": "{}" });
    const parts: string[] = [];
    for (let i = 0; i < 8; i++) {
      parts.push(`level-${i}-${"x".repeat(22)}`);
      write(f.project, `${parts.join("/")}/AGENTS.md`, "guidance");
      write(f.project, `${parts.join("/")}/package.json`, "{}");
    }
    const target = `${parts.join("/")}/target.txt`;
    write(f.project, target, "snapshot bytes\n");
    const full = await inspectRepository(f.project, { path: target });
    const bounded = await inspectRepository(f.project, { path: target }, undefined, { ...PROJECT_TOOL_LIMITS, outputChars: 2_000 });
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(2_000);
    expect(bounded.output_truncated).toBe(true);
    expect(bounded.file).toMatchObject({ path: target, sha256: sha("snapshot bytes\n"), bytes: 15 });
    expect(bounded.file!.applicable_instructions.length + bounded.file!.applicable_manifests.length)
      .toBeLessThan(full.file!.applicable_instructions.length + full.file!.applicable_manifests.length);
  });

  it("unusable or over-budget gitignore refuses inspection and editing instead of silently including excluded files", async () => {
    const ignored = "guarded.txt\n";
    const cases = [
      Buffer.from(ignored + "#".repeat(PROJECT_TOOL_LIMITS.ignoreFileBytes)),
      Buffer.from([0xff, 0xfe]),
      Buffer.from(Array.from({ length: PROJECT_TOOL_LIMITS.ignoreRules }, (_, i) => `other-${i}.txt`).join("\n") + `\n${ignored}`),
    ];
    for (const content of cases) {
      const f = fixture({ ".gitignore": content, "guarded.txt": "alpha\n" });
      await expect(inspectRepository(f.project, { query: "alpha" })).rejects.toBeInstanceOf(ProjectToolError);
      await expect(inspectRepository(f.project, { path: "guarded.txt" })).rejects.toBeInstanceOf(ProjectToolError);
      await expect(safeEdit(f.project, { path: "guarded.txt", expected_sha256: sha("alpha\n"), old: "alpha", new: "changed" })).rejects.toBeInstanceOf(ProjectToolError);
      expect(fs.readFileSync(f.file("guarded.txt"), "utf8")).toBe("alpha\n");
      expect(staged(f.project)).toEqual([]);
    }
    const bom = fixture({ ".gitignore": `\uFEFF${ignored}`, "guarded.txt": "alpha\n" });
    expect((await inspectRepository(bom.project, { query: "alpha" })).search?.locations).toEqual([]);
    await expect(safeEdit(bom.project, { path: "guarded.txt", expected_sha256: sha("alpha\n"), old: "alpha", new: "changed" })).rejects.toBeInstanceOf(ProjectToolError);
    expect(fs.readFileSync(bom.file("guarded.txt"), "utf8")).toBe("alpha\n");
  });

  it("an aborted signal cancels inspection", async () => {
    const f = fixture({ "a.txt": "alpha\n" });
    const controller = new AbortController(); controller.abort();
    await expect(inspectRepository(f.project, { query: "alpha" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("gitignore subset: anchoring, directories, negation, ** and nested bases", () => {
    const rules = [...parseIgnore("# comment\n*.log\n!keep.log\n/build\ndocs/**/draft-*.md\ncache/\n", ""), ...parseIgnore("local.txt\n", "pkg")];
    const cases: Array<[string, boolean, boolean]> = [
      ["a/b/x.log", false, true], ["a/keep.log", false, false], ["build", true, true], ["src/build", true, false],
      ["docs/draft-1.md", false, true], ["docs/a/b/draft-2.md", false, true], ["docs/final.md", false, false],
      ["x/cache", true, true], ["x/cache", false, false], ["pkg/local.txt", false, true], ["local.txt", false, false],
    ];
    for (const [relative, directory, expected] of cases) expect(ignoredBy(rules, relative, directory), relative).toBe(expected);
  });

  it("adversarial wildcard matching is finite, and an exhausted matching budget refuses safe_edit", async () => {
    const name = `${"a".repeat(180)}.txt`, pattern = `${"a*".repeat(16)}b`;
    const f = fixture({ ".gitignore": `${pattern}\n`, [name]: "alpha\n" });
    // The equivalent repeated-wildcard regex can backtrack exponentially. Do
    // not execute the old regex as a repro: the actual matcher is a bounded NFA.
    const report = await inspectRepository(f.project, { query: "alpha" });
    expect(report.search?.locations).toEqual([{ path: name, line: 1 }]);
    const limited = { ...PROJECT_TOOL_LIMITS, ignoreOperations: 20 };
    await expect(inspectRepository(f.project, { query: "alpha" }, undefined, limited)).rejects.toThrow(/\.gitignore/);
    await expect(safeEdit(f.project, { path: name, expected_sha256: sha("alpha\n"), old: "alpha", new: "changed" }, undefined, {}, limited)).rejects.toThrow(/\.gitignore/);
    expect(fs.readFileSync(f.file(name), "utf8")).toBe("alpha\n");
    expect(staged(f.project)).toEqual([]);
    // Preserve the common wildcard subset, including an unanchored match
    // restarting after a slash and **/ matching zero or multiple directories.
    const rules = parseIgnore("[ab]?.log\n**/keep[0-9].txt\n", "");
    expect(ignoredBy(rules, "nested/a1.log", false)).toBe(true);
    expect(ignoredBy(rules, "keep3.txt", false)).toBe(true);
    expect(ignoredBy(rules, "a/b/keep3.txt", false)).toBe(true);
    expect(ignoredBy(rules, "a/b/keepX.txt", false)).toBe(false);
  });
});

describe("safe_edit", () => {
  it("applies one literal replacement preserving mode, BOM, CRLF and every unrelated byte", async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const original = Buffer.concat([bom, Buffer.from("first\r\nREADY = 1\r\nlast\r\n")]);
    const f = fixture({ "src/config.txt": original, "src/other.txt": "READY = 1\r\n" });
    const file = f.file("src/config.txt"), other = fs.readFileSync(f.file("src/other.txt"));
    if (process.platform !== "win32") fs.chmodSync(file, 0o640);
    const snapshot = await inspectRepository(f.project, { path: "src/config.txt" });
    expect(snapshot.file?.sha256).toBe(sha(original));
    const result = await safeEdit(f.project, { path: "src/config.txt", expected_sha256: snapshot.file!.sha256, old: "READY = 1", new: "READY = 2" });
    const expected = Buffer.concat([bom, Buffer.from("first\r\nREADY = 2\r\nlast\r\n")]);
    expect(fs.readFileSync(file).equals(expected)).toBe(true);
    expect(result).toEqual({ status: "applied", path: "src/config.txt", before_sha256: sha(original), after_sha256: sha(expected), bytes: expected.length });
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(f.file("src/other.txt")).equals(other)).toBe(true);
    expect(staged(path.dirname(file))).toEqual([]);
  });

  it("stale hash, missing text and ambiguous (even overlapping) text are conflicts that write nothing", async () => {
    const f = fixture({ "a.txt": "line\n" });
    const file = f.file("a.txt");
    fs.writeFileSync(file, "line\n# changed by another actor\n");
    expect(await safeEdit(f.project, { path: "a.txt", expected_sha256: sha("line\n"), old: "line", new: "LINE" }))
      .toMatchObject({ status: "conflict", reason: "stale", sha256: hashOf(file) });
    expect(fs.readFileSync(file, "utf8")).toBe("line\n# changed by another actor\n");
    const conflicts: Array<[string, string, string, number]> = [
      ["a\r\nb\r\n", "a\nb", "missing", 0],
      ["READY\nREADY\n", "READY", "ambiguous", 2],
      ["aaa", "aa", "ambiguous", 2],
    ];
    for (const [content, old, reason, occurrences] of conflicts) {
      fs.writeFileSync(file, content);
      expect(await safeEdit(f.project, { path: "a.txt", expected_sha256: sha(content), old, new: "X" }), JSON.stringify(content))
        .toMatchObject({ status: "conflict", reason, occurrences, sha256: sha(content) });
      expect(fs.readFileSync(file, "utf8")).toBe(content);
    }
    expect(staged(f.project)).toEqual([]);
    for (const request of [{ old: "", new: "x" }, { old: "same", new: "same" }]) {
      await expect(safeEdit(f.project, { path: "a.txt", expected_sha256: sha("aaa"), ...request })).rejects.toBeInstanceOf(ProjectToolError);
    }
    await expect(safeEdit(f.project, { path: "a.txt", expected_sha256: "not-a-hash", old: "aaa", new: "b" })).rejects.toBeInstanceOf(ProjectToolError);
  });

  it("outside, symlinked, private, secret, generated and ignored paths are refused by both tools", async () => {
    const value = "value\n";
    const f = fixture({ "src/ok.txt": value, ".env.local": value, ".gitignore": "generated/\n", "generated/out.txt": value, ".local/state.txt": value, "config/server.key": value, ".git/config": value });
    write(f.outside, "target.txt", value);
    fs.symlinkSync(f.file("src/ok.txt"), f.file("alias.txt"));
    fs.symlinkSync(f.outside, f.file("escape"));
    fs.symlinkSync(f.file("src"), f.file("src-link"));
    vi.spyOn(os, "homedir").mockReturnValue(f.outside);
    const refused: Array<[string, typeof ProjectPathError | typeof ProjectToolError]> = [
      ["../outside/target.txt", ProjectPathError], [path.join(f.outside, "target.txt"), ProjectPathError], ["~/target.txt", ProjectPathError],
      ["escape/target.txt", ProjectPathError], ["alias.txt", ProjectPathError], ["src-link/ok.txt", ProjectPathError],
      [".env.local", ProjectToolError], ["generated/out.txt", ProjectToolError], [".local/state.txt", ProjectToolError],
      ["config/server.key", ProjectToolError], [".git/config", ProjectToolError],
    ];
    for (const [target, kind] of refused) {
      await expect(inspectRepository(f.project, { path: target }), target).rejects.toBeInstanceOf(kind);
      await expect(safeEdit(f.project, { path: target, expected_sha256: sha(value), old: "value", new: "changed" }), target).rejects.toBeInstanceOf(kind);
    }
    for (const file of [path.join(f.outside, "target.txt"), f.file("src/ok.txt"), f.file(".env.local"), f.file("generated/out.txt"), f.file(".local/state.txt"), f.file("config/server.key"), f.file(".git/config")])
      expect(fs.readFileSync(file, "utf8"), file).toBe(value);
    // The real path of the same file still works.
    expect((await safeEdit(f.project, { path: "src/ok.txt", expected_sha256: sha(value), old: "value", new: "changed" })).status).toBe("applied");
  });

  it("a hardlinked file is reported and refused so the other link cannot silently diverge", async () => {
    const f = fixture({ "src/a.txt": "alpha\n" });
    fs.linkSync(f.file("src/a.txt"), f.file("src/b.txt"));
    expect((await inspectRepository(f.project, { path: "src/a.txt" })).file?.safe_edit).toBe("hardlinked");
    await expect(safeEdit(f.project, { path: "src/a.txt", expected_sha256: sha("alpha\n"), old: "alpha", new: "beta" })).rejects.toBeInstanceOf(ProjectToolError);
    expect(fs.readFileSync(f.file("src/b.txt"), "utf8")).toBe("alpha\n");
  });

  it("oversize files and results are refused without writing", async () => {
    const small = { ...PROJECT_TOOL_LIMITS, fileBytes: 64 };
    const big = "x".repeat(65), f = fixture({ "big.txt": big, "small.txt": "xx\n" });
    await expect(safeEdit(f.project, { path: "big.txt", expected_sha256: sha(big), old: "xx", new: "y" }, undefined, {}, small)).rejects.toBeInstanceOf(ProjectToolError);
    await expect(safeEdit(f.project, { path: "small.txt", expected_sha256: sha("xx\n"), old: "xx", new: "y".repeat(100) }, undefined, {}, small)).rejects.toBeInstanceOf(ProjectToolError);
    expect(fs.readFileSync(f.file("big.txt"), "utf8")).toBe(big);
    expect(fs.readFileSync(f.file("small.txt"), "utf8")).toBe("xx\n");
    expect(staged(f.project)).toEqual([]);
  });

  it("a change, replacement or parent swap between staging and publication is a conflict; nothing is overwritten", async () => {
    const f = fixture({ "src/a.txt": "alpha\n" });
    const file = f.file("src/a.txt"), directory = path.dirname(file);
    const request = { path: "src/a.txt", expected_sha256: sha("alpha\n"), old: "alpha", new: "beta" };
    expect(await safeEdit(f.project, request, undefined, { beforePublish: () => { fs.writeFileSync(file, "alpha\nconcurrent\n"); } }))
      .toMatchObject({ status: "conflict", reason: "changed" });
    expect(fs.readFileSync(file, "utf8")).toBe("alpha\nconcurrent\n");
    expect(staged(directory)).toEqual([]);

    fs.writeFileSync(file, "alpha\n");
    // Another writer publishes identical bytes by rename: a different physical file.
    expect(await safeEdit(f.project, request, undefined, { beforePublish: () => { write(f.root, "theirs.txt", "alpha\n"); fs.renameSync(path.join(f.root, "theirs.txt"), file); } }))
      .toMatchObject({ status: "conflict", reason: "changed" });
    expect(fs.readFileSync(file, "utf8")).toBe("alpha\n");
    expect(staged(directory)).toEqual([]);

    write(f.outside, "a.txt", "alpha\n");
    const swapped = await safeEdit(f.project, request, undefined, { beforePublish: () => { fs.renameSync(directory, f.file("src-real")); fs.symlinkSync(f.outside, directory); } });
    expect(swapped).toMatchObject({ status: "conflict", reason: "changed" });
    expect(swapped).toMatchObject({ cleanup: { state: "unknown", temporary: expect.stringMatching(/^\.enki-safe-edit-[a-f0-9]+\.tmp$/) } });
    expect(swapped).toHaveProperty("message", expect.stringContaining("Удаление собственного временного файла"));
    expect(fs.readFileSync(path.join(f.outside, "a.txt"), "utf8")).toBe("alpha\n");
    expect(fs.readdirSync(f.outside).sort()).toEqual(["a.txt"]);
    expect(fs.readFileSync(f.file("src-real/a.txt"), "utf8")).toBe("alpha\n");
    // No unsafe search/unlink through the replaced parent: preserve the exact
    // outside assertion above and report this owned residual stage honestly.
    expect(staged(f.file("src-real"))).toHaveLength(1);
  });

  it("cancellation before publication removes only its own staged file and keeps the original", async () => {
    const f = fixture({ "src/a.txt": "alpha\n", "src/.enki-safe-edit-foreign.tmp": "not ours\n" });
    const controller = new AbortController();
    await expect(safeEdit(f.project, { path: "src/a.txt", expected_sha256: sha("alpha\n"), old: "alpha", new: "beta" }, controller.signal,
      { beforePublish: () => controller.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(fs.readFileSync(f.file("src/a.txt"), "utf8")).toBe("alpha\n");
    expect(staged(f.file("src"))).toEqual([".enki-safe-edit-foreign.tmp"]);
    expect(fs.readFileSync(f.file("src/.enki-safe-edit-foreign.tmp"), "utf8")).toBe("not ours\n");
  });

  it("same-process writers of one file are serialized: the second sees the first result as stale and writes nothing", async () => {
    const f = fixture({ "src/a.txt": "one\ntwo\n" });
    const expected = sha("one\ntwo\n");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let staging = 0;
    const first = safeEdit(f.project, { path: "src/a.txt", expected_sha256: expected, old: "one", new: "ONE" }, undefined, { beforePublish: async () => { staging++; await held; } });
    // Path scope checks are asynchronous: establish the first lock holder
    // before introducing the competing writer, rather than assuming I/O order.
    await until(() => staging === 1);
    const second = safeEdit(f.project, { path: "src/a.txt", expected_sha256: expected, old: "two", new: "TWO" }, undefined, { beforePublish: () => { staging++; } });
    await until(() => staging === 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(staging).toBe(1); // the second writer is still waiting and has staged nothing
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe("applied");
    expect(b).toMatchObject({ status: "conflict", reason: "stale", sha256: sha("ONE\ntwo\n") });
    expect(fs.readFileSync(f.file("src/a.txt"), "utf8")).toBe("ONE\ntwo\n");
    expect(staging).toBe(1);
  });
});

describe("registration and Enki policy", () => {
  const READS = ["read", "glob", "grep", "list", "question", "todowrite"].map(permission => ({ permission, pattern: "*", action: "allow" as const }));
  // Same shapes as the shipped presets in src/state/access.ts.
  const FULL: PermissionRule[] = [{ permission: "*", pattern: "*", action: "allow" }];
  const ASK: PermissionRule[] = [{ permission: "*", pattern: "*", action: "ask" }, ...READS];
  const READ: PermissionRule[] = [{ permission: "*", pattern: "*", action: "deny" }, ...READS];

  it("every Enki session registers each project tool exactly once next to the question tool", () => {
    const deps = { broker: {}, journal: {}, pool: {}, defaultPolicy: () => "ask", capabilities: null } as unknown as ExtensionDeps;
    const registered: Array<{ name: string; parameters: { properties?: Record<string, unknown>; required?: string[] }; executionMode?: string }> = [];
    const pi = { on: () => undefined, registerTool: (tool: (typeof registered)[number]) => { registered.push(tool); }, getAllTools: () => [] };
    for (const extension of enkiExtensions({ sessionID: "s", directory: "/work", rules: () => [], workshop: () => false }, deps))
      void (typeof extension === "function" ? extension : extension.factory)(pi as never);
    expect(registered.map(tool => tool.name).sort()).toEqual(["question", "repo_inspect", "safe_edit"]);
    const edit = registered.find(tool => tool.name === "safe_edit")!;
    expect([...(edit.parameters.required ?? [])].sort()).toEqual(["expected_sha256", "new", "old", "path"]);
    expect(edit.executionMode).toBe("sequential");
    expect(Object.keys(registered.find(tool => tool.name === "repo_inspect")!.parameters.properties ?? {}).sort()).toEqual(["path", "query"]);
  });

  it("project-tool classification requires Enki's own single effective registration", () => {
    const own = { name: "repo_inspect", sourceInfo: { path: PROJECT_TOOLS_EXTENSION } };
    const plugin = { name: "repo_inspect", sourceInfo: { path: "/plugins/shadow.js" } };
    const pi = (tools: unknown[]) => ({ getAllTools: () => tools }) as never;
    expect(isEnkiProjectTool(pi([own]), "repo_inspect")).toBe(true);
    expect(isEnkiProjectTool(pi([{ ...own, sourceInfo: { path: `<inline:${PROJECT_TOOLS_EXTENSION}>` } }]), "repo_inspect")).toBe(true);
    expect(isEnkiProjectTool(pi([plugin]), "repo_inspect")).toBe(false);
    expect(isEnkiProjectTool(pi([plugin, own]), "repo_inspect")).toBe(false);
    expect(isEnkiProjectTool(pi([{ ...own, name: "read" }]), "read")).toBe(false);
    expect(isEnkiProjectTool({ getAllTools: () => { throw new Error("not bound"); } } as never, "safe_edit")).toBe(false);
  });

  it("read allows inspection and refuses edits, full allows both, ask asks only for the edit with the exact target", () => {
    const f = fixture({ "src/a.txt": "x\n" });
    const target = f.file("src/a.txt");
    const query = (rules: PermissionRule[], tool: string, input: Record<string, unknown>) => decide({ rules, grants: [], fallback: "ask", cwd: f.project, tool, input, projectTool: true });
    expect(query(READ, "repo_inspect", {}).decision).toBe("allow");
    expect(query(READ, "repo_inspect", { path: "src/a.txt", query: "x" })).toMatchObject({ decision: "allow", permission: "read", pattern: target });
    expect(query(READ, "safe_edit", { path: "src/a.txt" }).decision).toBe("deny");
    expect(query(FULL, "safe_edit", { path: "src/a.txt" }).decision).toBe("allow");
    expect(query(ASK, "repo_inspect", { query: "x" }).decision).toBe("allow");
    expect(query(ASK, "safe_edit", { path: "src/a.txt" })).toMatchObject({ decision: "ask", permission: "edit", pattern: target, identity: exactIdentity("edit", { tool: "safe_edit", target }) });
    // Inherited default policy (chat without rules).
    const inherited = (fallback: "read" | "ask" | "full", tool: string, input: Record<string, unknown>) => decide({ rules: [], grants: [], fallback, cwd: f.project, tool, input, projectTool: true }).decision;
    expect(inherited("read", "repo_inspect", {})).toBe("allow");
    expect(inherited("read", "safe_edit", { path: "src/a.txt" })).toBe("deny");
    expect(inherited("ask", "safe_edit", { path: "src/a.txt" })).toBe("ask");
    expect(inherited("full", "safe_edit", { path: "src/a.txt" })).toBe("allow");
  });

  it("a remembered safe_edit grant covers exactly that tool and file, and a later deny rule still wins", () => {
    const f = fixture({ "src/a.txt": "x\n", "src/b.txt": "y\n" });
    const target = f.file("src/a.txt");
    const grant = { permission: "edit", pattern: "", identity: exactIdentity("edit", { tool: "safe_edit", target }) };
    const builtIn = { permission: "edit", pattern: "", identity: exactIdentity("edit", { tool: "edit", target }) };
    const query = (rules: PermissionRule[], grants: typeof grant[], input: Record<string, unknown>) => decide({ rules, grants, fallback: "ask", cwd: f.project, tool: "safe_edit", input, projectTool: true }).decision;
    expect(query(ASK, [grant], { path: "src/a.txt" })).toBe("allow");
    expect(query(ASK, [grant], { path: "src/b.txt" })).toBe("ask");
    expect(query(ASK, [builtIn], { path: "src/a.txt" })).toBe("ask");
    expect(query([...ASK, { permission: "edit", pattern: "src/*", action: "deny" }], [grant], { path: "src/a.txt" })).toBe("deny");
  });

  it("outside and aliased targets are refused before any prompt, even with full access", () => {
    const f = fixture({ "src/a.txt": "x\n" });
    write(f.outside, "x.txt", "outside\n");
    fs.symlinkSync(f.file("src/a.txt"), f.file("alias.txt"));
    fs.symlinkSync(f.outside, f.file("escape"));
    vi.spyOn(os, "homedir").mockReturnValue(f.outside);
    for (const value of ["../outside/x.txt", path.join(f.outside, "x.txt"), "~/x.txt", "alias.txt", "escape/x.txt", new URL(`file://${path.join(f.outside, "x.txt")}`).href]) {
      for (const [tool, rules] of [["safe_edit", FULL], ["repo_inspect", READ], ["repo_inspect", FULL]] as const) {
        const verdict = decide({ rules, grants: [], fallback: "full", cwd: f.project, tool, input: { path: value }, projectTool: true });
        expect(verdict.decision, `${tool} ${value}`).toBe("deny");
        expect(verdict.reason).toBeTruthy();
      }
    }
  });

  it("a same-named tool that is not Enki's registration stays an unknown tool and its input is never rewritten", () => {
    const f = fixture({ "src/a.txt": "x\n" });
    const input = { path: "src/a.txt" };
    expect(decide({ rules: READ, grants: [], fallback: "ask", cwd: f.project, tool: "repo_inspect", input, projectTool: false }).decision).toBe("deny");
    expect(decide({ rules: [], grants: [], fallback: "ask", cwd: f.project, tool: "repo_inspect", input }))
      .toMatchObject({ decision: "ask", permission: "repo_inspect", identity: exactIdentity("repo_inspect", { tool: "repo_inspect", input }) });
    for (const tool of ["repo_inspect", "safe_edit"]) {
      const prepared = { path: "src/a.txt" };
      prepareToolPaths(tool, prepared, f.project);
      expect(prepared.path).toBe("src/a.txt");
    }
  });
});
