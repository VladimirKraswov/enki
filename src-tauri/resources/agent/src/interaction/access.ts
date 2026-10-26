// Session access rules → a decision for one tool call.
//
// Rules keep the shape the UI already stores per chat. Evaluation is
// last-match-wins (later, more specific rules override a leading wildcard),
// which is how the shipped "ask"/"read"/"full" presets are written. A chat
// without rules uses the runtime default policy, which itself defaults to ask.

import type { PermissionRule } from "../protocol.ts";
import { exactIdentity } from "./grants.ts";
import { externalToolPath, ProjectPathError, resolveProjectPath, resolvedRulePath, resolvedToolPath } from "./access-paths.ts";

export type Decision = "allow" | "ask" | "deny";
export type DefaultPolicy = "ask" | "read" | "full";

/** Tools that only observe; asking about them would train users to click "yes". */
const READ_ONLY = new Set(["read", "ls", "list", "find", "glob", "grep", "search", "tree", "lsp_diagnostics", "lsp_hover", "lsp_definition"]);
/** Tools that can change files, run commands or reach the network. */
const MUTATING = new Set(["write", "edit", "multiedit", "multi_edit", "apply_patch", "patch", "bash", "powershell", "shell", "run", "fetch", "web_fetch", "download"]);

/**
 * Enki's own project tools (extensions/project-tools.ts). Applied ONLY when the
 * caller proves the effective registration of that name is Enki's; a plugin
 * tool with the same name stays an unknown tool (all-argument identity, asks).
 */
const PROJECT_TOOLS = new Map([
  ["repo_inspect", { permission: "read", readOnly: true, optionalPath: true }],
  ["safe_edit", { permission: "edit", readOnly: false, optionalPath: false }],
]);

export function isReadOnlyTool(tool: string): boolean { return READ_ONLY.has(tool); }
export function isMutatingTool(tool: string): boolean { return MUTATING.has(tool); }

/** Permission vocabulary shared with the stored rules. */
export function permissionFor(tool: string): string {
  switch (tool) {
    case "find": return "glob";
    case "ls": return "list";
    case "write": case "edit": case "multiedit": case "multi_edit": case "apply_patch": case "patch": return "edit";
    case "powershell": case "shell": return "bash";
    default: return tool;
  }
}

export function patternFor(input: Record<string, unknown>): string {
  for (const key of ["command", "path", "file_path", "filePath", "url", "pattern"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "*";
}

function glob(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const expression = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "s");
  return expression.test(value);
}

export function evaluate(rules: readonly PermissionRule[], permission: string, pattern: string): Decision | null {
  let decision: Decision | null = null;
  for (const rule of rules)
    if (glob(rule.permission, permission) && glob(rule.pattern, pattern)) decision = rule.action;
  return decision;
}

/** Paths that resolve outside the session directory need their own approval. */
export function outsideDirectory(cwd: string, input: Record<string, unknown>): string | null {
  return externalToolPath(cwd, "read", input);
}

export interface AccessQuery {
  rules: readonly PermissionRule[];
  grants: readonly { permission: string; pattern: string; identity?: string; tool?: "bash" }[];
  fallback: DefaultPolicy;
  cwd: string;
  tool: string;
  input: Record<string, unknown>;
  /** True only when `tool` is Enki's own effective project-tool registration. */
  projectTool?: boolean;
}

export interface AccessVerdict { decision: Decision; permission: string; pattern: string; identity: string; reason?: string }

export function decide(query: AccessQuery): AccessVerdict {
  const project = query.projectTool === true ? PROJECT_TOOLS.get(query.tool) : undefined;
  const permission = project ? project.permission : permissionFor(query.tool);
  let target: string | null;
  if (project) {
    // Outside/aliased targets are refused before any rule or prompt: the tool
    // would refuse them anyway, and asking would only train "yes".
    try { target = resolveProjectPath(query.cwd, query.input.path, project.optionalPath).target; }
    catch (error) {
      if (!(error instanceof ProjectPathError)) throw error;
      return { decision: "deny", permission, pattern: patternFor(query.input), identity: exactIdentity(permission, { tool: query.tool, input: query.input }), reason: error.message };
    }
  } else target = resolvedToolPath(query.cwd, query.tool, query.input);
  const pattern = target ?? patternFor(query.input);
  // Built-in file grants cover this exact tool/target. Unknown tools hash ALL
  // arguments; a matching path alone must not authorize another MCP operation.
  const identity = exactIdentity(permission, target ? { tool: query.tool, target } : { tool: query.tool, input: query.input });
  const granted = (p: string, id: string) => query.grants.some(g => g.permission === p && g.identity === id);
  const fileRules = (p: string, value: string): Decision | null => {
    let result: Decision | null = null;
    for (const rule of query.rules) {
      if (!glob(rule.permission, p)) continue;
      if (glob(resolvedRulePath(query.cwd, rule.pattern), value)) result = rule.action;
    }
    return result;
  };
  const explicit = target ? fileRules(permission, target) : evaluate(query.rules, permission, pattern);
  const readOnly = project ? project.readOnly : isReadOnlyTool(query.tool);
  const toolDecision = explicit ?? (query.fallback === "full" || readOnly ? "allow" : query.fallback === "read" ? "deny" : "ask");
  // Every prohibition wins BEFORE asking about another independent constraint.
  if (toolDecision === "deny") return { decision: "deny", permission, pattern, identity, reason: "Действие запрещено правилами доступа этого чата." };
  const external = externalToolPath(query.cwd, query.tool, query.input);
  if (external) {
    const rule = fileRules("external_directory", external) ?? (query.fallback === "full" ? "allow" : "ask");
    const externalIdentity = exactIdentity("external_directory", { target: external });
    if (rule === "deny") return { decision: "deny", permission: "external_directory", pattern: external, identity: externalIdentity, reason: "Доступ вне папки проекта запрещён правилами чата." };
    if (rule === "ask" && !granted("external_directory", externalIdentity)) return { decision: "ask", permission: "external_directory", pattern: external, identity: externalIdentity };
  }
  const bashGranted = permission === "bash" && query.tool === "bash"
    && query.grants.some(grant => grant.permission === "bash" && grant.tool === "bash");
  return { decision: toolDecision === "allow" || granted(permission, identity) || bashGranted ? "allow" : "ask", permission, pattern, identity };
}
