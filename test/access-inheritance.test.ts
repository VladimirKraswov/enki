// Chat access presets (src/state/access.ts) as the runtime actually evaluates
// them (src-tauri/resources/agent/src/interaction/access.ts, last match wins).
//
// Retired with OpenCode: resources/browser/access-policy.mjs (the OpenCode
// `chat.message` plugin that copied a parent's full access into task-tool
// subagents and upgraded legacy rules through session.update). It is no longer
// shipped (capabilities.rs shared_runtime_ships_no_agent_engine_plugins) and the
// runtime starts no live subagents: child sessions exist only as read-only
// imported archives, which never execute.
import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { accessMode, accessRules, type AccessMode } from "../src/state/access";
import { decide, evaluate, type DefaultPolicy } from "../src-tauri/resources/agent/src/interaction/access";

let root: string, project: string, outside: string;
beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "enki-access-"));
  project = path.join(root, "project"); outside = path.join(root, "outside");
  mkdirSync(project); mkdirSync(outside);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
const verdict = (mode: AccessMode | null, tool: string, input: Record<string, unknown>, fallback: DefaultPolicy = "ask", rules = mode ? accessRules(mode) : []) =>
  decide({ rules, grants: [], fallback, cwd: project, tool, input }).decision;

it("full access runs tools without confirmation, including outside the project", () => {
  expect(accessRules("full")).toEqual([{ permission: "*", pattern: "*", action: "allow" }]);
  expect(verdict("full", "write", { path: "a.txt" })).toBe("allow");
  expect(verdict("full", "bash", { command: "rm -rf build" })).toBe("allow");
  expect(verdict("full", "read", { path: path.join(outside, "x.txt") })).toBe("allow");
  expect(verdict("full", "write", { path: path.join(outside, "x.txt") })).toBe("allow");
});

it("ask allows observation, asks for changes, commands and anything outside the project", () => {
  expect(verdict("ask", "read", { path: "a.txt" })).toBe("allow");
  expect(verdict("ask", "grep", { pattern: "x" })).toBe("allow");
  expect(verdict("ask", "write", { path: "a.txt" })).toBe("ask");
  expect(verdict("ask", "bash", { command: "ls" })).toBe("ask");
  expect(verdict("ask", "read", { path: path.join(outside, "x.txt") })).toBe("ask");
  expect(verdict("ask", "some_future_tool", {})).toBe("ask");
});

it("read only denies every mutation and command and never silently reads outside", () => {
  expect(verdict("read", "read", { path: "a.txt" })).toBe("allow");
  for (const [tool, input] of [["write", { path: "a.txt" }], ["edit", { path: "a.txt" }], ["bash", { command: "ls" }], ["some_future_tool", {}]] as const)
    expect(verdict("read", tool, input), tool).toBe("deny");
  expect(verdict("read", "read", { path: path.join(outside, "x.txt") })).not.toBe("allow");
});

it("inherit stores no rules, so the runtime default policy decides", () => {
  expect(accessRules("inherit")).toEqual([]);
  expect(accessMode([])).toBe("inherit");
  expect(verdict(null, "write", { path: "a.txt" }, "ask")).toBe("ask");
  expect(verdict(null, "write", { path: "a.txt" }, "read")).toBe("deny");
  expect(verdict(null, "write", { path: "a.txt" }, "full")).toBe("allow");
  expect(verdict(null, "read", { path: "a.txt" }, "read")).toBe("allow");
});

it("full representations stored by earlier versions stay full, and the runtime treats them as full", () => {
  for (const legacy of [
    [{ permission: "*", pattern: "*", action: "allow" }, { permission: "external_directory", pattern: "*", action: "allow" }],
    [{ permission: "*", pattern: "*", action: "allow" }, { permission: "external_directory", pattern: "*", action: "allow" }, { permission: "doom_loop", pattern: "*", action: "allow" }],
    [{ permission: "*", pattern: "*", action: "allow" }, { permission: "doom_loop", pattern: "*", action: "ask" }],
  ] as const) {
    expect(accessMode([...legacy])).toBe("full");
    expect(verdict(null, "write", { path: "a.txt" }, "ask", [...legacy])).toBe("allow");
    expect(verdict(null, "write", { path: path.join(outside, "x") }, "ask", [...legacy])).toBe("allow");
  }
});

it("custom rules are last-match-wins and never mistaken for a preset", () => {
  const custom = [{ permission: "*", pattern: "*", action: "allow" as const }, { permission: "edit", pattern: "*", action: "deny" as const }];
  expect(accessMode(custom)).toBe("custom");
  expect(verdict(null, "write", { path: "a.txt" }, "full", custom)).toBe("deny");
  expect(verdict(null, "bash", { command: "ls" }, "ask", custom)).toBe("allow");
  // A preset appended after older rules wins (how a mode change is stored).
  expect(accessMode([...custom, ...accessRules("read")])).toBe("read");
  expect(evaluate([...accessRules("full"), ...accessRules("read")], "bash", "ls")).toBe("deny");
  expect(evaluate([...accessRules("read"), ...accessRules("full")], "bash", "ls")).toBe("allow");
});
