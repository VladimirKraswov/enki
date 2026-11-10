// A skill the agent learned from a successful task. It is a TEXT artefact
// (SKILL.md with frontmatter), not executable code: a stronger model writes the
// method once, and a weaker one gets it ready-made in later sessions.
import fs from "node:fs";
import path from "node:path";

export interface LearnedSkillInput { name: string; description: string; content: string }

export function saveLearnedSkill(root: string, input: LearnedSkillInput): { path: string; name: string } {
  const name = input.name.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(name))
    throw new Error("Имя навыка: строчные латинские буквы, цифры и дефисы (например, release-check).");
  const description = input.description.trim().replace(/\s+/g, " ").slice(0, 300);
  const content = input.content.trim();
  if (!description) throw new Error("Укажите, когда навык полезен.");
  if (!content || content.length > 8000) throw new Error("Содержимое навыка: до 8000 символов, без секретов.");
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "SKILL.md");
  const body = `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}\n`;
  fs.writeFileSync(file, body, { mode: 0o600 });
  return { path: file, name };
}
