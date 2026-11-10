import { expect, it } from "vitest";
import { sessionPolicyBlocks, languageReminder } from "../src/policy/prompt.ts";
import { toolWorkflowReminder } from "../src/policy/toolWorkflow.ts";
import { workQualityReminder } from "../src/policy/workQuality.ts";
import { workshopReminder } from "../src/policy/workshop.ts";
import { compactToolText, LOCAL_TOOL_TEXT_LIMIT } from "../src/policy/tool-output.ts";

const ID = "session-1", DIR = "/project";

it("compact policy is much shorter but keeps the same rules and tags", () => {
  const full = sessionPolicyBlocks(ID, DIR, false);
  const compact = sessionPolicyBlocks(ID, DIR, false, true);
  expect(compact).toHaveLength(full.length);
  const size = (blocks: string[]) => blocks.reduce((n, b) => n + b.length, 0);
  expect(size(compact)).toBeLessThan(size(full) * 0.6);
  // Язык не сокращается: это поведенческий контракт, а не справка.
  expect(compact[0]).toBe(languageReminder(ID));
  for (const tag of ["arvela-tool-workflow-v1", "enki-work-quality-v1", "enki-user-wait-v1", "enki-schedules-v1"])
    expect(compact.join("\n")).toContain(`<${tag} session="${ID}"`);
  expect(compact.join("\n")).toContain(`directory=${JSON.stringify(DIR)}`);
});

it("compact quality block requires a short plan and a verified result", () => {
  const compact = sessionPolicyBlocks(ID, DIR, false, true).join("\n");
  expect(compact).toContain("план из 2–4 пунктов");
  expect(compact).toContain("только после проверки");
  expect(compact).toContain("что осталось непроверенным");
});

it("cloud models keep the full blocks, and the workshop contract is never shortened", () => {
  const full = sessionPolicyBlocks(ID, DIR, true);
  const compact = sessionPolicyBlocks(ID, DIR, true, true);
  expect(full[1]).toBe(toolWorkflowReminder(ID));
  expect(full[2]).toBe(workQualityReminder(ID));
  expect(compact.at(-1)).toBe(workshopReminder(ID));
  expect(full.at(-1)).toBe(workshopReminder(ID));
});

it("short command output is passed through untouched", () => {
  const text = "PASS\nexit=0";
  expect(compactToolText(text)).toBe(text);
  expect(compactToolText("x".repeat(LOCAL_TOOL_TEXT_LIMIT))).toHaveLength(LOCAL_TOOL_TEXT_LIMIT);
});

it("long output keeps the head and the error tail and points to the full log", () => {
  const head = "src/a.ts(1,1): error TS1005\n" + "line\n".repeat(500);
  const tail = "FAIL test/z.test.ts\nTests 1 failed\nexit=1\n";
  const text = head + "filler\n".repeat(4000) + tail;
  const out = compactToolText(text, "/tmp/full.log");
  expect(out.length).toBeLessThan(LOCAL_TOOL_TEXT_LIMIT + 200);
  expect(out).toContain("src/a.ts(1,1): error TS1005");
  expect(out).toContain("FAIL test/z.test.ts");
  expect(out.endsWith(tail)).toBe(true);
  expect(out).toContain("полный вывод: /tmp/full.log");
  expect(out).toContain("пропущено");
});

it("truncation without a saved log still says what was omitted", () => {
  const out = compactToolText("start\n" + "y".repeat(20_000) + "\nend");
  expect(out.startsWith("start")).toBe(true);
  expect(out.endsWith("end")).toBe(true);
  expect(out).toContain("пропущено");
  expect(out).not.toContain("полный вывод");
});
