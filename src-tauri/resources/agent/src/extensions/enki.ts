// Enki's inline extensions for one SDK session, assembled with that session's
// scope. The session's ResourceSpec is explicit (core/runtime.ts resources():
// these extensions, configured extension paths and enabled skill roots, with
// ambient agentDir/project extension discovery off); nothing here loads the
// owner's ~/.pi resources.

import path from "node:path";
import { Type, type Static } from "typebox";
import { attachBrowser } from "../../../browser/pi-extension.ts";
import { executionFeedback } from "../../../browser/execution-feedback.mjs";
import { attachLsp, loadLspConfig } from "./lsp.ts";
import { isEnkiProjectTool, projectToolsExtension } from "./project-tools.ts";
import { createToolGate, type GateVerdict } from "../../../pi/tool-gate.ts";
import { attachShared } from "../../../shared/pi-extension.ts";
import { readRegistry } from "../../../shared/registry.mjs";
import type { CapabilitiesScope } from "../control/broker.ts";
import { decide, evaluate, type DefaultPolicy } from "../interaction/access.ts";
import { prepareToolPaths } from "../interaction/access-paths.ts";
import { QUESTION_LIMITS, type InteractionBroker } from "../interaction/broker.ts";
import type { McpPool } from "../mcp/pool.ts";
import { sessionPolicyBlocks } from "../policy/prompt.ts";
import type { PermissionRule } from "../protocol.ts";
import type { SdkExtension } from "../sdk/adapter.ts";
import type { EventJournal } from "../store/events.ts";

export interface SessionScope {
  sessionID: string;
  directory: string;
  rules(): readonly PermissionRule[];
  workshop(): boolean;
}

export interface ExtensionDeps {
  broker: InteractionBroker;
  journal: EventJournal;
  pool: McpPool;
  defaultPolicy(): DefaultPolicy;
  capabilities: CapabilitiesScope | null;
}

/** Full access in the session rules is the only way the browser leaves project scope. */
export function browserAccess(rules: readonly PermissionRule[], fallback: DefaultPolicy): "full" | "project" {
  if (!rules.length) return fallback === "full" ? "full" : "project";
  return evaluate(rules, "bash", "*") === "allow" && evaluate(rules, "external_directory", "*") === "allow" ? "full" : "project";
}

export const QUESTION_TOOL = "question";
const QuestionParams = Type.Object({
  questions: Type.Array(Type.Object({
    question: Type.String({ minLength: 1, maxLength: QUESTION_LIMITS.question, description: "Complete question text" }),
    header: Type.Optional(Type.String({ maxLength: QUESTION_LIMITS.header, description: "Very short label (max 80 chars)" })),
    options: Type.Optional(Type.Array(Type.Object({
      label: Type.String({ minLength: 1, maxLength: QUESTION_LIMITS.label }),
      description: Type.Optional(Type.String({ maxLength: QUESTION_LIMITS.description })),
    }), { maxItems: QUESTION_LIMITS.options })),
    multiple: Type.Optional(Type.Boolean({ description: "Allow selecting several options" })),
    custom: Type.Optional(Type.Boolean({ description: "Allow a typed answer besides the options (default true)" })),
  }), { minItems: 1, maxItems: QUESTION_LIMITS.questions }),
});

/** Real blocking ask through the durable InteractionBroker (question.asked/replied). */
export function questionTool(scope: Pick<SessionScope, "sessionID" | "directory">, broker: InteractionBroker) {
  return {
    name: QUESTION_TOOL,
    label: "Вопрос пользователю",
    description: "Ask the user one or more questions and wait for the answers. Use it when a decision or missing information "
      + "blocks the task; do not use it to request permission for a tool (tools ask for permission themselves).",
    parameters: QuestionParams,
    async execute(toolCallId: string, params: Static<typeof QuestionParams>, signal: AbortSignal | undefined) {
      const answer = await broker.askQuestion({ sessionID: scope.sessionID, directory: scope.directory, questions: params.questions, callID: toolCallId, ...(signal ? { signal } : {}) });
      if (!("answers" in answer)) throw new Error("Пользователь не ответил на вопрос: он отклонён, отменён или истёк срок ожидания. Не повторяйте его без новой причины.");
      const text = params.questions.map((q, index) => `${q.header ?? q.question}: ${answer.answers[index].join(", ")}`).join("\n");
      return { content: [{ type: "text" as const, text }, ...(answer.content ?? [])], details: { answers: answer.answers, ...(answer.attachments?.length ? { attachments: answer.attachments } : {}) } };
    },
  };
}

export function enkiExtensions(scope: SessionScope, deps: ExtensionDeps): SdkExtension[] {
  const gate: SdkExtension = {
    name: "enki-tool-gate",
    factory: (pi) => createToolGate({
      prepare: prepareToolPaths,
      decide: (toolName, input, cwd, temporary): GateVerdict => {
        // Asking the user is not a privileged action: never ask permission to ask.
        // An explicit deny rule (for example "*" → deny) is still honoured.
        if (toolName === QUESTION_TOOL)
          return evaluate(scope.rules(), QUESTION_TOOL, "*") === "deny" ? { decision: "deny", reason: "Вопросы пользователю запрещены правилами чата." } : { decision: "allow" };
        // Project-tool classification only for Enki's own effective registration.
        const verdict = decide({ rules: scope.rules(), grants: [...deps.broker.grants(scope.sessionID), ...temporary], fallback: deps.defaultPolicy(), cwd, tool: toolName, input,
          projectTool: isEnkiProjectTool(pi, toolName) });
        return verdict.decision === "allow" ? { decision: "allow" }
          : verdict.decision === "deny" ? { decision: "deny", reason: verdict.reason ?? "Действие запрещено правилами чата." }
          : { decision: "ask", permission: verdict.permission, pattern: verdict.pattern, identity: verdict.identity };
      },
      approve: async (request) => {
        const reply = await deps.broker.askPermission({
          sessionID: scope.sessionID, directory: scope.directory, permission: request.permission, pattern: request.pattern, identity: request.identity,
          tool: request.toolName, callID: request.toolCallId, title: request.title, summary: request.summary, signal: request.signal,
          // A policy change while this waits settles it once; the gate then re-decides anyway.
          reevaluate: () => request.recheck().decision,
        });
        return reply === "once" || reply === "always";
      },
      feedback: (tool, output, isError) => executionFeedback("pi", tool, output, isError),
    })(pi),
  };
  const policy: SdkExtension = {
    name: "enki-turn-policy",
    factory: (pi) => {
      pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\n${sessionPolicyBlocks(scope.sessionID, scope.directory, scope.workshop()).join("\n\n")}`,
      }));
    },
  };
  const questions: SdkExtension = { name: "enki-questions", factory: (pi) => { pi.registerTool(questionTool(scope, deps.broker)); } };
  const out: SdkExtension[] = [gate, policy, questions, projectToolsExtension()];
  const caps = deps.capabilities;
  if (caps?.mcpUnavailable) {
    deps.journal.append(scope.directory, scope.sessionID, { type: "mcp.status", properties: { sessionID: scope.sessionID, servers: [], error: caps.mcpUnavailable } });
  }
  if (caps?.mcp) {
    out.push({
      name: "enki-shared-mcp",
      factory: (pi) => attachShared(pi, {
        registry: () => readRegistry(caps.root, caps.key),
        scope: { registryKey: caps.key, command: caps.executable },
        pool: deps.pool,
        report: (servers) => deps.journal.append(scope.directory, scope.sessionID, { type: "mcp.status", properties: { sessionID: scope.sessionID, servers } }),
        reserved: () => pi.getAllTools().map((tool) => tool.name),
      }),
    });
  }
  if (caps?.browser && path.isAbsolute(caps.executable)) {
    out.push({
      name: "enki-browser",
      factory: (pi) => attachBrowser(pi, { command: () => caps.executable, access: () => browserAccess(scope.rules(), deps.defaultPolicy()) }),
    });
  }
  if (caps?.lspConfig) {
    const config = loadLspConfig(caps.lspConfig);
    if (config.servers.length) out.push({ name: "enki-lsp", factory: (pi) => attachLsp(pi, config) });
  }
  return out;
}
