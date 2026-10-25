// Final integration: explicit, validated owner resources (extensions, skills,
// prompt templates) — no ambient discovery, no package installation, missing
// paths reported instead of silently "on". Written, NOT RUN.
import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { validSettings } from "../src/core/runtime.ts";
import { harness, newSession, tempDir, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });

it("explicit skill/prompt paths are validated, reported and passed to new workers only when present", async () => {
  h = await harness();
  const root = tempDir("resources"), skill = path.join(root, "skills", "my-skill"), prompts = path.join(root, "prompts");
  fs.mkdirSync(skill, { recursive: true }); fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: my-skill\ndescription: fixture\n---\nbody\n");
  fs.mkdirSync(prompts); fs.writeFileSync(path.join(prompts, "review.md"), "Review this");
  const gone = path.join(root, "gone");
  for (const bad of [{ skillPaths: ["relative/skill"] }, { promptPaths: ["/ok", 3] }, { skillPaths: Array.from({ length: 65 }, (_, i) => `/s${i}`) }])
    expect((await h.request("PUT", "/settings", bad)).status).toBe(400);
  const saved = await h.request<{ skillPaths: string[]; promptPaths: string[]; useUserPiResources: boolean; noDiscoveredExtensions: boolean }>(
    "PUT", "/settings", { skillPaths: [skill, gone], promptPaths: [prompts] });
  expect(saved.status).toBe(200);
  expect(saved.body).toMatchObject({ skillPaths: [skill, gone], promptPaths: [prompts], useUserPiResources: false, noDiscoveredExtensions: true });
  const status = await h.request<{ skills: unknown[]; prompts: unknown[]; extensions: unknown[]; deferred: string[] }>("GET", "/settings/resources");
  // Remainder review: the status additionally reports explicit local packages (none here).
  expect(status.body).toEqual({ extensions: [], skills: [{ path: skill, present: true }, { path: gone, present: false }], prompts: [{ path: prompts, present: true }], packages: [], deferred: [] });
  const dir = h.project("resources"), sid = await newSession(h, dir);
  const record = h.runtime.catalog.get(sid)!;
  const spec = await h.runtime["resources"](record);
  expect(spec.skillPaths).toContain(skill);
  expect(spec.skillPaths).not.toContain(gone);
  expect(spec.promptPaths).toEqual([prompts]);
  expect(spec.noDiscoveredExtensions).toBe(true);
});

it("older stored settings without the new lists stay valid and default to none", () => {
  const legacy = { defaultPolicy: "ask", extensionPaths: [], useUserPiResources: false, noDiscoveredExtensions: true, gitProgram: null,
    compaction: { enabled: true }, browserEnabled: false, lspEnabled: true };
  expect(validSettings(legacy)).toBe(true);
  expect(validSettings({ ...legacy, skillPaths: ["/a\u0000b"] })).toBe(false);
  // Explicit local packages: absolute, bounded, optional for older settings.
  expect(validSettings({ ...legacy, packagePaths: ["/opt/pi-packages/tools"] })).toBe(true);
  expect(validSettings({ ...legacy, packagePaths: ["npm:@scope/pkg"] })).toBe(false);
  expect(validSettings({ ...legacy, packagePaths: Array.from({ length: 65 }, (_, i) => `/p${i}`) })).toBe(false);
});
