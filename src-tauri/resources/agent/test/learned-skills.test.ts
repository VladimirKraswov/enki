import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { saveLearnedSkill } from "../src/skills/learned.ts";
import { tempDir } from "./helpers.ts";

it("writes a valid SKILL.md with frontmatter that the SDK can discover", () => {
  const root = tempDir("learned-skills");
  const saved = saveLearnedSkill(root, { name: "Release Check", description: "  Как проверять релиз  ", content: "1. Соберите\n2. Прогоните тесты" });
  expect(saved.name).toBe("release-check");
  const body = fs.readFileSync(saved.path, "utf8");
  expect(body).toContain("name: release-check");
  expect(body).toContain("description: Как проверять релиз");
  expect(body).toContain("1. Соберите");
  expect(saved.path).toBe(path.join(root, "release-check", "SKILL.md"));
});

it("refuses path traversal, a bad name and oversized content", () => {
  const root = tempDir("learned-skills");
  expect(() => saveLearnedSkill(root, { name: "../escape", description: "x", content: "y".repeat(30) })).toThrow(/Имя навыка/);
  expect(() => saveLearnedSkill(root, { name: "ok-name", description: "x", content: "y".repeat(9000) })).toThrow(/8000/);
  expect(() => saveLearnedSkill(root, { name: "ok-name", description: "", content: "y".repeat(30) })).toThrow(/когда навык полезен/);
});

it("updating the same skill replaces its content, not a sibling file", () => {
  const root = tempDir("learned-skills");
  saveLearnedSkill(root, { name: "pdf-work", description: "PDF", content: "Первый вариант, достаточно длинный" });
  const saved = saveLearnedSkill(root, { name: "pdf-work", description: "PDF", content: "Второй вариант, тоже достаточно длинный" });
  expect(fs.readFileSync(saved.path, "utf8")).toContain("Второй вариант");
  expect(fs.readdirSync(root)).toEqual(["pdf-work"]);
});
