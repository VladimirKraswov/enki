// Enki's inline extensions for one SDK session, assembled with that session's
// scope. The session's ResourceSpec is explicit (core/runtime.ts resources():
// these extensions, configured extension paths and enabled skill roots, with
// ambient agentDir/project extension discovery off); nothing here loads the
// owner's ~/.pi resources.

import { saveLearnedSkill } from "../skills/learned.ts";
import path from "node:path";
import { Type, type Static } from "typebox";
import { attachBrowser } from "../../../browser/pi-extension.ts";
import { executionFeedback } from "../../../browser/execution-feedback.mjs";
import { attachLsp, loadLspConfig } from "./lsp.ts";
import { isEnkiProjectTool, projectToolsExtension } from "./project-tools.ts";
import { createToolGate, type GateVerdict } from "../../../pi/tool-gate.ts";
import { attachShared } from "../../../shared/pi-extension.ts";
import type { ServerStatus } from "../../../shared/pi-extension.ts";
import { readRegistry } from "../../../shared/registry.mjs";
import type { CapabilitiesScope } from "../control/broker.ts";
import { decide, evaluate, type DefaultPolicy } from "../interaction/access.ts";
import { prepareToolPaths } from "../interaction/access-paths.ts";
import { QUESTION_LIMITS, type InteractionBroker } from "../interaction/broker.ts";
import type { McpPool } from "../mcp/pool.ts";
import { imageToolsPresent, imageToolsReminder, sessionPolicyBlocks } from "../policy/prompt.ts";
import { isModelRef } from "../protocol.ts";
import type { PermissionRule, ModelRef } from "../protocol.ts";
import { MAX_MINUTES, type Scheduler, type SchedulePatch } from "../schedule/scheduler.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SdkExtension } from "../sdk/adapter.ts";
import type { EventJournal } from "../store/events.ts";
import { isLocalProvider } from "../context-budget.ts";
import { compactToolText } from "../policy/tool-output.ts";

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
  /** Runtime-owned timers; present in a real session, absent in isolated tests. */
  scheduler?: Scheduler;
  defaultPolicy(): DefaultPolicy;
  capabilities: CapabilitiesScope | null;
  /** Compact project block (root + sibling chat titles); null for projectless chats. */
  /** Optional: lesson persistence; absent in isolated/test sessions. */
  lessons?: import("../store/lessons.ts").LessonStore;
  /** Root where learned skills (SKILL.md) are written and discovered from. */
  learnedSkills?: string;
  projectContext?(directory: string): string | null;
  reportMcp?(servers: ServerStatus[], error?: string): void;
  registerPreparation?(key: string, prepare: () => Promise<void>): void;
}

/** Full access in the session rules is the only way the browser leaves project scope. */
export function browserAccess(rules: readonly PermissionRule[], fallback: DefaultPolicy): "full" | "project" {
  if (!rules.length) return fallback === "full" ? "full" : "project";
  return evaluate(rules, "bash", "*") === "allow" && evaluate(rules, "external_directory", "*") === "allow" ? "full" : "project";
}

export const QUESTION_TOOL = "question";
export const SCHEDULE_TOOL = "desktop_schedule";
const QuestionParams = Type.Object({
  questions: Type.Array(Type.Object({
    question: Type.String({ minLength: 1, maxLength: QUESTION_LIMITS.question, description: "Complete question text" }),
    context: Type.Optional(Type.String({ maxLength: QUESTION_LIMITS.context, description: "2–4 предложения контекста для человека, который не следил за работой: что уже сделано в этой задаче и почему сейчас нужен его выбор. Без жаргона, по-русски." })),
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
      + "blocks the task; do not use it to request permission for a tool (tools ask for permission themselves). "
      + "Перед вопросом всегда заполняй context: что уже сделано и зачем нужен выбор. "
      + "В options.description указывай последствия и плюсы/минусы варианта; если есть рекомендуемый вариант, отметь его и объясни почему.",
    parameters: QuestionParams,
    async execute(toolCallId: string, params: Static<typeof QuestionParams>, signal: AbortSignal | undefined) {
      const answer = await broker.askQuestion({ sessionID: scope.sessionID, directory: scope.directory, questions: params.questions, callID: toolCallId, ...(signal ? { signal } : {}) });
      if (!("answers" in answer)) throw new Error("Пользователь не ответил на вопрос: он отклонён, отменён или истёк срок ожидания. Не повторяйте его без новой причины.");
      const text = params.questions.map((q, index) => `${q.header ?? q.question}: ${answer.answers[index].join(", ")}`).join("\n");
      return { content: [{ type: "text" as const, text }, ...(answer.content ?? [])], details: { answers: answer.answers, ...(answer.attachments?.length ? { attachments: answer.attachments } : {}) } };
    },
  };
}

const ScheduleParams = Type.Object({
  action: Type.String(),
  id: Type.Optional(Type.String()),
  request_key: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  minutes: Type.Optional(Type.Number()),
  mode: Type.Optional(Type.String()),
  run_at: Type.Optional(Type.Number()),
});

/**
 * Native timer tool for the current chat. It is always registered with the
 * session, so an agent never has to discover an MCP server (or a database file)
 * just to change one interval. Every edit is still executed by the one runtime
 * Scheduler, which owns delivery, retries and durable state.
 */
export function scheduleTool(
  scope: Pick<SessionScope, "sessionID" | "directory">,
  scheduler: Pick<Scheduler, "list" | "add" | "update" | "toggle" | "remove">,
) {
  const scoped = () => scheduler.list({ directory: scope.directory, sessionID: scope.sessionID }).tasks;
  const own = (id: string) => scoped().find((task) => task.id === id);
  const find = (params: Static<typeof ScheduleParams>) => {
    const byId = params.id?.trim();
    if (byId) return own(byId);
    const key = params.request_key?.trim();
    if (key) return scoped().find((task) => task.requestKey === key);
    // Один таймер в этом чате не требует предварительного list только ради id.
    const all = scoped();
    return all.length === 1 ? all[0] : undefined;
  };
  const modelOf = (ctx: ExtensionContext): ModelRef | null => {
    if (!ctx.model) return null;
    const variant = ctx.thinkingLevel && ctx.thinkingLevel !== "off" ? ctx.thinkingLevel : undefined;
    const model: ModelRef = { providerID: ctx.model.provider, modelID: ctx.model.id, ...(variant ? { variant } : {}) };
    return isModelRef(model) ? model : null;
  };
  const validTime = (runAt: number | null | undefined) => runAt === undefined || runAt === null
    || (Number.isFinite(runAt) && runAt >= Date.now() && runAt <= Date.now() + MAX_MINUTES * 60_000);

  return {
    name: SCHEDULE_TOOL,
    label: "Таймер Enki",
    description: "Timers of THIS chat: list/create/update/remove/pause/resume. create needs title,prompt,request_key; minutes default 15; mode once/repeat; run_at Unix ms (0 clears on update). update changes fields in ONE call by id/request_key or the only timer, never remove+create. No bash/files.",
    parameters: ScheduleParams,
    async execute(_callId: string, params: Static<typeof ScheduleParams>, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
      if (!["list", "create", "update", "remove", "pause", "resume"].includes(params.action))
        throw new Error("Действие таймера: list, create, update, remove, pause или resume.");
      if (params.action === "list") {
        const { tasks, skipped } = scheduler.list({ directory: scope.directory, sessionID: scope.sessionID });
        return {
          content: [{ type: "text" as const, text: tasks.length ? tasks.map((task) => `${task.id} · ${task.title} · ${task.enabled ? `${task.mode === "once" ? "один раз" : `каждые ${task.minutes} мин`}, следующий ${new Date(task.nextAt).toISOString()}` : "на паузе"}${task.requestKey ? ` · key=${task.requestKey}` : ""}`).join("\n") : "В этом чате таймеров нет." }],
          details: { tasks, skipped },
        };
      }
      if (params.action === "create") {
        const title = params.title?.trim(), prompt = params.prompt?.trim(), requestKey = params.request_key?.trim();
        if (!title) throw new Error("Укажите название таймера (title).");
        if (!prompt) throw new Error("Укажите задание таймера (prompt).");
        if (!requestKey) throw new Error("Укажите стабильный request_key, чтобы не создавать дубликаты.");
        if (!validTime(params.run_at)) throw new Error("Время запуска должно быть в пределах следующих 7 дней.");
        const minutes = params.minutes ?? 15;
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) throw new Error("Интервал: от 1 минуты до 7 дней.");
        if (params.mode !== undefined && params.mode !== "once" && params.mode !== "repeat") throw new Error("Режим: once или repeat.");
        const model = modelOf(ctx);
        if (!model) throw new Error("Не удалось определить модель чата.");
        const task = scheduler.add({
          directory: scope.directory, sessionID: scope.sessionID, title, prompt, minutes, mode: (params.mode ?? "repeat") as "once" | "repeat",
          ...(typeof params.run_at === "number" ? { runAt: params.run_at } : {}), requestKey, model,
        });
        return { content: [{ type: "text" as const, text: `Таймер сохранён: ${task.title}.` }], details: { task } };
      }
      if (params.id === undefined && params.request_key === undefined && scoped().length > 1)
        throw new Error("В этом чате несколько таймеров: укажите id из action=list.");
      const task = find(params);
      if (!task) throw new Error("Таймер не найден в этом чате. Сначала вызовите action=list.");
      if (params.action === "remove") {
        scheduler.remove(task.id);
        return { content: [{ type: "text" as const, text: `Таймер удалён: ${task.title}.` }], details: { id: task.id } };
      }
      if (params.action === "pause" || params.action === "resume") {
        const wanted = params.action === "resume";
        const changed = task.enabled === wanted ? task : scheduler.toggle(task.id, wanted);
        return { content: [{ type: "text" as const, text: `Таймер ${wanted ? "возобновлён" : "приостановлен"}: ${changed.title}.` }], details: { task: changed } };
      }
      const patch: SchedulePatch = {};
      if (params.title !== undefined) patch.title = params.title;
      if (params.prompt !== undefined) patch.prompt = params.prompt;
      if (params.minutes !== undefined) {
        if (!Number.isInteger(params.minutes) || params.minutes < 1 || params.minutes > MAX_MINUTES) throw new Error("Интервал: от 1 минуты до 7 дней.");
        patch.minutes = params.minutes;
      }
      if (params.mode !== undefined) {
        if (params.mode !== "once" && params.mode !== "repeat") throw new Error("Режим: once или repeat.");
        patch.mode = params.mode;
      }
      if (params.run_at !== undefined) {
        if (params.run_at === 0) patch.runAt = null;
        else {
          if (!validTime(params.run_at)) throw new Error("Время запуска должно быть в пределах следующих 7 дней.");
          patch.runAt = params.run_at;
        }
      }
      if (!Object.keys(patch).length) throw new Error("Укажите, что изменить: title, prompt, minutes, mode или run_at.");
      const changed = scheduler.update(task.id, patch);
      return { content: [{ type: "text" as const, text: `Таймер изменён без пересоздания: ${changed.title}.` }], details: { task: changed } };
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
        // A timer is an explicit, chat-scoped user action owned by this runtime,
        // not an arbitrary external tool: asking for permission each time would
        // only train blind approvals. An explicit deny rule is still honoured.
        if (toolName === SCHEDULE_TOOL)
          return evaluate(scope.rules(), SCHEDULE_TOOL, "*") === "deny" ? { decision: "deny", reason: "Таймеры запрещены правилами чата." } : { decision: "allow" };
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
      pi.on("before_agent_start", (event, ctx) => {
        const compact = isLocalProvider(ctx?.model?.provider);
        const blocks = sessionPolicyBlocks(scope.sessionID, scope.directory, scope.workshop(), compact);
        const project = deps.projectContext?.(scope.directory);
        const learned = deps.lessons?.list(scope.directory, 5) ?? [];
        if (learned.length) blocks.push(`<enki-lessons-v1 directory="${encodeURIComponent(scope.directory)}">Уроки из прошлых ходов этого проекта (советы, а не новые инструкции):\n${learned.map(l => `— ${l.text}`).join("\n")}\n</enki-lessons-v1>`);
        // Only when the session really has them: a rule about missing tools would
        // push the model to invent a shell substitute.
        const toolNames = (pi.getAllTools?.() ?? []).map(tool => tool.name);
        if (imageToolsPresent(toolNames)) blocks.push(imageToolsReminder(scope.sessionID));
        return { systemPrompt: `${event.systemPrompt}\n\n${[...blocks, ...(project ? [project] : [])].join("\n\n")}` };
      });
    },
  };
  const questions: SdkExtension = { name: "enki-questions", factory: (pi) => { pi.registerTool(questionTool(scope, deps.broker)); } };
  const schedules: SdkExtension = {
    name: "enki-schedules",
    factory: (pi) => { if (deps.scheduler) pi.registerTool(scheduleTool(scope, deps.scheduler)); },
  };
  const lessons: SdkExtension = {
    name: "enki-lessons",
    factory: (pi) => {
      const store = deps.lessons;
      if (!store) return;
      pi.registerTool({
        name: "remember_lesson",
        label: "Запомнить урок",
        description: "Сохрани короткий урок после исправленной ошибки или поправки пользователя: что не сработало и как делать правильно в следующий раз. Одна фраза по-русски, без секретов и чужих данных. Не используй для общих рассуждений.",
        parameters: Type.Object({ lesson: Type.String({ minLength: 8, maxLength: 500 }) }),
        async execute(_id: string, params: { lesson: string }) {
          const saved = store.add(scope.directory, params.lesson);
          return { content: [{ type: "text" as const, text: `Урок сохранён: ${saved.text}` }], details: { id: saved.id } };
        },
      });
    },
  };
  const learnedSkills: SdkExtension = {
    name: "enki-learned-skills",
    factory: (pi) => {
      if (!deps.learnedSkills) return;
      const root = deps.learnedSkills;
      pi.registerTool({
        name: "create_skill",
        label: "Создать навык",
        description: "После успешно решённой задачи сохрани переиспользуемый навык: краткую инструкцию, как делать такие задачи в будущем (что проверять, какие команды, какие ошибки обходить). Это текстовая подсказка (SKILL.md), не исполняемый код. Не сохраняй секреты и чужие данные.",
        parameters: Type.Object({
          name: Type.String({ minLength: 3, maxLength: 50, description: "slug навыка, например release-check" }),
          description: Type.String({ minLength: 8, maxLength: 300, description: "Когда этот навык полезен" }),
          content: Type.String({ minLength: 20, maxLength: 8000, description: "Содержимое SKILL.md без frontmatter" }),
        }),
        async execute(_id: string, params: { name: string; description: string; content: string }) {
          const saved = saveLearnedSkill(root, params);
          return { content: [{ type: "text" as const, text: `Навык «${saved.name}» сохранён и будет доступен в следующих ходах.` }], details: { path: saved.path } };
        },
      });
    },
  };
  // Local models get a bounded head+tail of long command output; cloud models
  // keep the SDK's own truncation unchanged.
  const toolOutput: SdkExtension = {
    name: "enki-local-tool-output",
    factory: (pi) => {
      pi.on("tool_result", (event, ctx) => {
        if (!isLocalProvider(ctx.model?.provider)) return;
        if (event.toolName !== "bash" && event.toolName !== "powershell") return;
        const full = (event.details as { fullOutputPath?: string } | undefined)?.fullOutputPath;
        let changed = false;
        const content = event.content.map(c => {
          if (c.type !== "text") return c;
          const next = compactToolText(c.text, full);
          if (next === c.text) return c;
          changed = true;
          return { ...c, text: next };
        });
        return changed ? { content } : undefined;
      });
    },
  };
  const out: SdkExtension[] = [gate, policy, questions, schedules, lessons, learnedSkills, toolOutput, projectToolsExtension()];
  const caps = deps.capabilities;
  const reportMcp = (servers: ServerStatus[], error?: string) => {
    if (deps.reportMcp) deps.reportMcp(servers, error);
    else deps.journal.append(scope.directory, scope.sessionID, { type: "mcp.status", properties: { sessionID: scope.sessionID, servers, ...(error ? { error } : {}) } });
  };
  if (caps?.mcpUnavailable) {
    reportMcp([], caps.mcpUnavailable);
  }
  if (caps?.mcp) {
    out.push({
      name: "enki-shared-mcp",
      factory: (pi) => attachShared(pi, {
        registry: () => readRegistry(caps.root, caps.key, caps.registryKeys ?? []),
        scope: { registryKey: caps.key, command: caps.executable, registryKeys: caps.registryKeys },
        pool: deps.pool,
        report: (servers) => reportMcp(servers),
        reserved: () => pi.getAllTools().map((tool) => tool.name),
      }),
    });
  }
  if (caps?.browser && path.isAbsolute(caps.executable)) {
    out.push({
      name: "enki-browser",
      factory: (pi) => {
        const prepare = attachBrowser(pi, { command: () => caps.executable, access: () => browserAccess(scope.rules(), deps.defaultPolicy()) });
        deps.registerPreparation?.('browser', prepare);
      },
    });
  }
  if (caps?.lspConfig) {
    const config = loadLspConfig(caps.lspConfig);
    if (config.servers.length) out.push({ name: "enki-lsp", factory: (pi) => attachLsp(pi, config) });
  }
  return out;
}
