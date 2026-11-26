// A learned skill lives or dies by its YAML frontmatter. A description with a
// colon used to make the whole skill disappear from the catalogue without an
// error in the UI, so the writer must always emit a quoted scalar.
import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveLearnedSkill } from "../src/skills/learned.ts";

const load = async (dir: string) => {
  const { loadSkills } = await import("@earendil-works/pi-coding-agent");
  return loadSkills({ cwd: dir, agentDir: dir, skillPaths: [dir], includeDefaults: false });
};

it("keeps a description with a colon and quotes loadable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enki-skill-"));
  const description = 'Аудит страницы: контраст, цели клика, «кавычки» и #якоря';
  const { path: file } = saveLearnedSkill(root, { name: "audit-check", description, content: "Шаги: 1. Проверить — 2. Записать." });
  const raw = fs.readFileSync(file, "utf8");
  expect(raw).toContain('description: "');
  const loaded = await load(root);
  expect(loaded.diagnostics.filter(d => d.type === "warning")).toEqual([]);
  expect(loaded.skills.map(s => s.name)).toEqual(["audit-check"]);
  expect(loaded.skills[0]!.description).toBe(description);
});

it("keeps a plain description untouched but still loadable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enki-skill-"));
  saveLearnedSkill(root, { name: "plain-check", description: "Простое описание без спецсимволов", content: "текст" });
  const loaded = await load(root);
  expect(loaded.diagnostics.filter(d => d.type === "warning")).toEqual([]);
  expect(loaded.skills[0]!.description).toBe("Простое описание без спецсимволов");
});
