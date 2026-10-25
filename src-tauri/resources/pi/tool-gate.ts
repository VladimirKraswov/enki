/**
 * Enki — approval gate for every tool call in an SDK-hosted Pi session.
 *
 * Pi's own `write`, `edit`, `bash` and extension tools run without asking
 * anyone. Enki Runtime loads this gate as an inline extension into every real
 * session; the session's access mode decides what is allowed, denied or asked.
 *
 * Safe default end to end:
 *   - a call that needs approval waits for an Enki permission request;
 *   - the runtime broker denies on deadline, on Stop, on shutdown and when the
 *     tool's abort signal fires; a failed approval path is a denial too;
 *   - there is no implicit "remember": only an explicit "always" reply adds a
 *     session-scoped grant, and only the user-selected mode grants full access.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { exactIdentity, permissionPreview, type ObservedGrant } from "../agent/src/interaction/grants.ts";

/** Tools that can change files, run commands or reach the network. */
const MUTATING = new Set([
  "write", "edit", "multiedit", "multi_edit", "apply_patch", "patch",
  "bash", "powershell", "shell", "run", "fetch", "web_fetch", "download",
]);

/** Read-only built-ins; asking about these would train the user to click "yes". */
const READ_ONLY = new Set([
  "read", "list", "ls", "find", "glob", "grep", "search", "tree",
  "lsp_diagnostics", "lsp_hover", "lsp_definition",
]);

export type Policy = "ask" | "read" | "full";

/** Unknown tools — a new built-in, an extension's tool — fail closed. */
export function needsApproval(toolName: string): boolean {
  return !READ_ONLY.has(toolName);
}

/** Known-dangerous tools get a blunter prompt than merely unfamiliar ones. */
export function isMutating(toolName: string): boolean {
  return MUTATING.has(toolName);
}

export function describe(toolName: string, input: Record<string, unknown>): string {
  for (const key of ["command", "path", "file_path", "filePath", "url", "pattern"]) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) {
      const target = value.trim();
      const preview = permissionPreview(target);
      return `${toolName}: ${preview.length > 400 ? `${preview.slice(0, 400)}…` : preview}`;
    }
  }
  return toolName;
}

export type GateVerdict =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "ask"; permission: string; pattern: string; identity?: string };

export interface ToolGateOptions {
  /** Pure decision from the session's access mode and grants. */
  decide(toolName: string, input: Record<string, unknown>, cwd: string, temporary: readonly ObservedGrant[]): GateVerdict;
  /** Normalize only actual built-in targets; mutates the SDK-authorized input. */
  prepare?(toolName: string, input: Record<string, unknown>, cwd: string): void;
  /** Ask the user. Resolves true only for an explicit approval. `recheck`
   * re-runs `decide` for this exact pending call against the CURRENT policy
   * (e.g. the chat was switched to full access while the request waited). */
  approve(request: { toolName: string; toolCallId: string; title: string; summary: string; permission: string; pattern: string; identity: string; signal?: AbortSignal; recheck(): GateVerdict }): Promise<boolean>;
  /** Advisory text appended to a failed bash result (never changes the command). */
  feedback?(toolName: string, output: string, isError: boolean): { message: string } | undefined;
}

export const DENIED = "Пользователь не разрешил это действие в Enki. Предложи более безопасный шаг или спроси, что делать.";

/** Decision for a policy without per-call rules; used by tests and as a fallback. */
export function policyVerdict(policy: Policy, toolName: string, input: Record<string, unknown>, temporary: readonly ObservedGrant[] = []): GateVerdict {
  if (policy === "full" || !needsApproval(toolName)) return { decision: "allow" };
  if (policy === "read") return { decision: "deny", reason: "В этом чате выбран режим «Только чтение»." };
  const identity = exactIdentity(toolName, { tool: toolName, input });
  if (temporary.some(grant => grant.permission === toolName && grant.identity === identity)) return { decision: "allow" };
  return { decision: "ask", permission: toolName, pattern: describe(toolName, input), identity };
}

export function createToolGate(options: ToolGateOptions) {
  return (pi: ExtensionAPI): void => {
    pi.on("tool_result", (event) => {
      if (event.toolName !== "bash" || !options.feedback) return;
      const text = event.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const feedback = options.feedback(event.toolName, text, event.isError);
      if (!feedback) return;
      return { content: [...event.content, { type: "text" as const, text: feedback.message }], isError: true };
    });
    pi.on("tool_call", async (event, ctx) => {
      const toolName = String(event.toolName ?? "");
      const input = (event.input ?? {}) as Record<string, unknown>;
      const temporary: ObservedGrant[] = [];
      // Once proofs live only in this invocation. Re-evaluate every constraint
      // and current policy after each answer; never globally persist once.
      for (let checks = 0; checks < 16; checks++) {
        if (ctx.signal?.aborted) return { block: true, reason: DENIED };
        let verdict: GateVerdict;
        try { options.prepare?.(toolName, input, ctx.cwd); verdict = options.decide(toolName, input, ctx.cwd, temporary); }
        catch { return { block: true, reason: DENIED }; }
        if (verdict.decision === "allow") return;
        if (verdict.decision === "deny") return { block: true, reason: verdict.reason };
        const identity = verdict.identity ?? exactIdentity(verdict.permission, { tool: toolName, input, pattern: verdict.pattern });
        if (temporary.some(grant => grant.permission === verdict.permission && grant.identity === identity))
          return { block: true, reason: "Не удалось перепроверить разрешение действия. Действие не выполнялось." };
        let approved = false;
        try {
          approved = (await options.approve({
          toolName,
          toolCallId: event.toolCallId,
          title: isMutating(toolName) ? "Агент хочет изменить файлы или выполнить команду" : "Агент запрашивает действие",
          summary: describe(toolName, input),
          permission: verdict.permission,
          pattern: verdict.pattern,
          identity,
          signal: ctx.signal,
          recheck: () => options.decide(toolName, input, ctx.cwd, temporary),
          })) === true;
        } catch {
          return { block: true, reason: "Не удалось получить подтверждение действия. Действие не выполнялось; проверьте подключение и хранилище Enki." };
        }
        if (!approved) return { block: true, reason: DENIED };
        temporary.push({ permission: verdict.permission, pattern: verdict.pattern, identity });
      }
      return { block: true, reason: "Условия доступа менялись слишком часто. Действие не выполнялось; повторите после проверки настроек." };
    });
  };
}
