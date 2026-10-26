// The only production module that imports values from the Pi SDK packages.
//
// Every other runtime module depends on the narrow types re-exported here, so an
// SDK upgrade is reviewed in one file plus `translate.ts`/`history.ts`, which
// read SDK entry/event shapes through these aliases. Verified against the
// published declarations of @earendil-works/pi-coding-agent 0.85.1.

import { syncOwnedFile } from "../platform/owned-sync.ts";
import {
  createAgentSession,
  createBashToolDefinition,
  createPowerShellToolDefinition,
  estimateTokens,
  AgentSessionRuntime,
  parseSessionEntries,
  migrateSessionEntries,
  type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  type FileEntry,
  type ExtensionCommandContextActions,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  VERSION,
  type AgentSession,
  type AgentSessionEvent,
  type CompactionResult,
  type ContextUsage,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
  type InlineExtension,
  type SessionEntry,
  type SessionInfo,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type {
  Api, AssistantMessage, AuthOperationOptions, Credential, CredentialInfo, CredentialStore, ImageContent, Model, TextContent,
  ToolResultMessage, UserMessage,
} from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";
import { ScopedResources } from "../plugin-ui/scoped-resources.ts";
import { SDK_VERSION } from "../protocol.ts";
import { projectToolEnvironment } from "../platform/environment.ts";
import { applyHeaders, type ConfigProjection } from "../models/config.ts";

export type SdkSession = AgentSession;
export type SdkSessionRuntime = AgentSessionRuntime;
export type SdkCommandActions = ExtensionCommandContextActions;
export type SdkEvent = AgentSessionEvent;
export type SdkEntry = SessionEntry;
export type SdkSessionInfo = SessionInfo;
export type SdkModel = Model<Api>;
export type SdkImage = ImageContent;
export type SdkThinkingLevel = ThinkingLevel;
export type SdkExtension = InlineExtension;
export type SdkExtensionApi = ExtensionAPI;
export type SdkExtensionContext = ExtensionContext;
export type SdkUiContext = ExtensionUIContext;
export type SdkCompaction = CompactionResult;
export type SdkContextUsage = ContextUsage;
export type SdkToolDefinition = ToolDefinition;
export type SdkModelRuntime = ModelRuntime;
export type SdkMessage = AgentMessage;
export type SdkAssistantMessage = AssistantMessage;
export type SdkUserMessage = UserMessage;
export type SdkToolResultMessage = ToolResultMessage;
export type SdkTextContent = TextContent;
export type SdkCredentialStore = CredentialStore;
export type SdkCredential = Credential;
export type SdkCredentialInfo = CredentialInfo;
export type SdkAuthOptions = AuthOperationOptions;

export const THINKING_LEVELS: readonly SdkThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function isThinkingLevel(value: unknown): value is SdkThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** The installed package version, compared against the contract pin at startup. */
export function installedSdkVersion(): string {
  return VERSION;
}

export function assertPinnedSdk(): void {
  if (VERSION !== SDK_VERSION)
    throw new Error(`Enki Runtime adapter is written for Pi SDK ${SDK_VERSION}; installed ${VERSION}. Rebuild the runtime artifact.`);
}

export interface ModelRuntimeOptions {
  agentDir: string;
  /**
   * "vault": credentials live in the OS vault behind the native broker.
   * "agent-dir": Pi's standard agentDir/auth.json (remote hosts, explicit choice).
   * "memory": tests.
   */
  credentials: { kind: "vault"; store: SdkCredentialStore } | { kind: "agent-dir" } | { kind: "memory" };
  allowNetwork: boolean;
  signal?: AbortSignal;
  /**
   * Verified imported configuration. Its immutable generation models.json
   * (sanitized: no apiKey/headers) replaces agentDir/models.json so the SDK
   * keeps its own merge/modelOverrides/oauth semantics; literal secrets never
   * enter SDK config interpolation.
   */
  config?: ConfigProjection;
}

/** Projection bound to a model runtime: every session opened on it gets the
 * preflight and header injector, including ephemeral model-access checks. */
const projections = new WeakMap<SdkModelRuntime, ConfigProjection>();
const modelConfigPaths = new WeakMap<SdkModelRuntime, string>();

export async function createModelRuntime(options: ModelRuntimeOptions): Promise<SdkModelRuntime> {
  const credentials = options.credentials.kind === "vault" ? options.credentials.store
    : options.credentials.kind === "memory" ? new InMemoryCredentialStore() : undefined;
  if (options.config && options.credentials.kind === "agent-dir")
    throw new Error("Импортированные настройки требуют хранилища ключей Enki, а не auth.json.");
  const runtime = await ModelRuntime.create({
    authPath: `${options.agentDir}/auth.json`,
    modelsPath: options.config?.modelsPath ?? `${options.agentDir}/models.json`,
    modelsStorePath: `${options.agentDir}/models-store.json`,
    allowModelNetwork: options.allowNetwork,
    modelRefreshTimeoutMs: 15_000,
    signal: options.signal,
    ...(credentials ? { credentials } : {}),
  });
  if (options.config) projections.set(runtime, options.config);
  modelConfigPaths.set(runtime, options.config?.modelsPath ?? `${options.agentDir}/models.json`);
  return runtime;
}

export function configProjection(runtime: SdkModelRuntime): ConfigProjection | undefined {
  return projections.get(runtime);
}

interface ProviderHeadersEvent { headers: Record<string, string | null | undefined>; model?: { provider?: string; id?: string } }

/** Host prelude: literal imported headers, mutated in place (null deletes). The
 * SDK ignores the return value and swallows exceptions, so admission relies on
 * `assertAdmissible` + the credential store, never on this hook throwing. */
function configHeaders(projection: ConfigProjection): SdkExtension {
  return { name: "<enki-host:config-headers>", factory: pi => {
    pi.on("before_provider_headers", (event, ctx) => {
      const typed = event as unknown as ProviderHeadersEvent;
      const model = typed.model ?? (ctx as { model?: { provider?: string; id?: string } }).model;
      if (!model?.provider || !typed.headers) return;
      applyHeaders(typed.headers, projection.headersFor(model.provider, model.id));
    });
  } };
}

export interface ResourceSpec {
  /** Inline Enki extensions (gate, policy, bridges) bound to this session. */
  extensions: SdkExtension[];
  /** User/plugin extension files explicitly configured in Enki settings. */
  extensionPaths: string[];
  skillPaths: string[];
  promptPaths: string[];
  themePaths?: string[];
  /** Explicit inherited context files supplied by the project boundary. */
  contextPaths?: string[];
  /** Explicit override; normal Pi discovery stays on otherwise. */
  noDiscoveredExtensions: boolean;
  /** Decision for project-local `.pi` resources; undecided projects are not trusted. */
  projectTrusted: (cwd: string) => Promise<boolean>;
}

/** Validate an explicit Enki resource selection without discovering the owner's
 * Pi profile. The returned lists are detached from mutable settings arrays. */
export function qualifiedResourceSpec(input: ResourceSpec): ResourceSpec {
  const paths = (values: string[], kind: string): string[] => [...new Set(values.map(file => {
    if (!path.isAbsolute(file) || file.includes("\0")) throw new Error(`Путь ${kind} должен быть абсолютным.`);
    return path.normalize(file);
  }))];
  return { ...input, extensions: [...input.extensions], extensionPaths: paths(input.extensionPaths, "расширения"),
    skillPaths: paths(input.skillPaths, "навыка"), promptPaths: paths(input.promptPaths, "шаблона"),
    ...(input.contextPaths ? { contextPaths: paths(input.contextPaths, "контекста") } : {}),
    ...(input.themePaths ? { themePaths: paths(input.themePaths, "темы") } : {}) };
}

export interface SettingsSpec {
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
  retry?: { enabled?: boolean; maxRetries?: number; baseDelayMs?: number };
  /** Tests run without user/global settings files. */
  inMemory?: boolean;
  /** Allowlisted behavior settings of the active imported generation. */
  imported?: Readonly<Record<string, unknown>>;
}

export interface OpenSessionOptions {
  cwd: string;
  agentDir: string;
  sessionDir: string;
  /** Existing session file to resume; omitted for a new session. */
  sessionFile?: string;
  newSessionId?: string;
  parentSession?: string;
  modelRuntime: SdkModelRuntime;
  settings: SettingsSpec;
  resources: ResourceSpec;
  model?: SdkModel;
  thinking?: SdkThinkingLevel;
  /** Built-in tool allowlist; omitted means Pi defaults plus extension tools. */
  tools?: string[];
  /** In-memory, tool-less session that leaves no transcript (model access checks). */
  ephemeral?: boolean;
}

export interface OpenedSession {
  session: SdkSession;
  runtime: SdkSessionRuntime;
  diagnostics: string[];
  extensionErrors: Array<{ path: string; error: string }>;
  modelFallback?: string;
}

function settingsFor(options: OpenSessionOptions): SettingsManager {
  // Enki settings are canonical. In-memory storage also preserves these values
  // across SDK reload(), unlike applyOverrides on a disk-backed manager.
  // Imported behavior settings first; Enki-owned keys, telemetry policy and
  // the explicit empty resource lists always override them.
  return SettingsManager.inMemory({
    // Keys/values were allowlisted from the Pi settings schema by the planner and config.ts.
    ...(options.settings.imported ?? {}) as NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>,
    ...(options.settings.compaction ? { compaction: options.settings.compaction } : {}),
    ...(options.settings.retry ? { retry: options.settings.retry } : {}),
    enableAnalytics: false, enableInstallTelemetry: false,
    packages: [], extensions: [], skills: [], prompts: [], themes: [],
  });
}

export function ownedSessionFile(file: string, directory: string): string {
  const root = fs.realpathSync(directory), resolved = fs.realpathSync(file);
  if (fs.lstatSync(file).isSymbolicLink() || !resolved.startsWith(root + path.sep))
    throw new Error("Историю можно изменять только в рабочем хранилище Enki; сначала импортируйте внешний файл.");
  const reader = openSessionReader(resolved, directory);
  if (reader.header && readEntries(resolved).header.version !== 3)
    throw new Error("Старый формат Pi должен быть импортирован в рабочую копию до запуска.");
  return resolved;
}

export async function openAgentSession(options: OpenSessionOptions): Promise<OpenedSession> {
  if (![options.cwd, options.agentDir, options.sessionDir].every(path.isAbsolute)) throw new Error("Пути SDK должны быть абсолютными.");
  // Fail closed BEFORE any session exists: an unresolved imported binding for
  // this provider (or an unreadable authority) never reaches the network.
  const projection = configProjection(options.modelRuntime);
  projection?.assertAdmissible(options.model?.provider);
  const hostPrelude: SdkExtension[] = projection?.needsHeaders() ? [configHeaders(projection)] : [];
  fs.mkdirSync(options.agentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(options.sessionDir, { recursive: true, mode: 0o700 });
  const cwd = fs.realpathSync(options.cwd);
  let activeSession: SdkSession | undefined;
  const factory: CreateAgentSessionRuntimeFactory = async (input) => {
    // Replacement commands stay inside the same Enki project. Switching project
    // is handled by the registry, with a fresh resource/access scope.
    if (fs.realpathSync(input.cwd) !== cwd) throw new Error("Нельзя сменить проект внутри активного SDK worker.");
    const settingsManager = settingsFor(options);
    // The SDK's default process profile is isolated at bootstrap. Public shell
    // factories preserve its normal execution/cancellation while restoring the
    // original project environment through the public spawnHook; SDK PI_SESSION_*
    // metadata and HOME pass through untouched. The SDK resolves the FIRST tool
    // registration and this prelude loads first, so ScopedResources removes any
    // of these names an explicit plugin/inline extension supplies: they are
    // fallbacks only and never mask a selected plugin override.
    const projectShells: SdkExtension = pi => {
      const spawnHook = <T extends { env: NodeJS.ProcessEnv }>(context: T): T =>
        ({ ...context, env: projectToolEnvironment(context.env) });
      pi.registerTool(createBashToolDefinition(cwd, { spawnHook }));
      pi.registerTool(createPowerShellToolDefinition(cwd, { spawnHook }));
    };
    const resourceLoader = new ScopedResources(cwd, options.agentDir, qualifiedResourceSpec(options.resources),
      [{ name: "<enki-host:project-shells>", factory: projectShells }, ...hostPrelude]);
    await resourceLoader.reload();
    let sessionManager = input.sessionManager;
    const target = sessionManager.getSessionFile();
    if (sessionManager.isPersisted() && target && !fs.existsSync(target)) {
      // Seed the real public header before handing the manager to the SDK. A
      // reopened manager is already flushed, so even its first user entry is
      // written immediately; no fake assistant or SDK-private flag is needed.
      if (fs.realpathSync(path.dirname(target)) !== fs.realpathSync(options.sessionDir)) throw new Error("Новая сессия вышла за рабочее хранилище Enki.");
      const header = sessionManager.getHeader(); if (!header) throw new Error("SDK не создал заголовок сессии.");
      const fd = fs.openSync(target, "wx", 0o600);
      try { fs.writeFileSync(fd, [header, ...sessionManager.getEntries()].map(value => JSON.stringify(value)).join("\n") + "\n"); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      sessionManager = SessionManager.open(target, options.sessionDir, cwd);
    }
    const services: AgentSessionServices = { cwd, agentDir: options.agentDir,
      modelRuntime: options.modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
    const selectedModel = activeSession?.model ?? options.model;
    const selectedThinking = activeSession?.thinkingLevel ?? options.thinking;
    const created = await createAgentSession({ cwd, agentDir: options.agentDir,
      modelRuntime: options.modelRuntime, settingsManager, resourceLoader, sessionManager,
      ...(input.sessionStartEvent ? { sessionStartEvent: input.sessionStartEvent } : {}),
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(selectedThinking ? { thinkingLevel: selectedThinking } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.ephemeral ? { noTools: "all" as const } : {}),
    });
    activeSession = created.session;
    return { ...created, services, diagnostics: [] };
  };
  const manager = options.ephemeral ? SessionManager.inMemory(cwd)
    : options.sessionFile ? SessionManager.open(ownedSessionFile(options.sessionFile, options.sessionDir), options.sessionDir, cwd)
    : SessionManager.create(cwd, options.sessionDir, { ...(options.newSessionId ? { id: options.newSessionId } : {}),
      ...(options.parentSession ? { parentSession: options.parentSession } : {}) });
  const created = await factory({ cwd, agentDir: options.agentDir, sessionManager: manager });
  const runtime = new AgentSessionRuntime(created.session, created.services, factory);
  return { session: created.session, runtime, diagnostics: [],
    extensionErrors: created.extensionsResult.errors, modelFallback: created.modelFallbackMessage };
}

/** Bind the Enki UI bridge so extension dialogs, notices and status reach clients. */
export async function bindSessionUi(session: SdkSession, ui: SdkUiContext, onError: (path: string, event: string, error: string) => void, bindings: Required<Pick<Parameters<SdkSession["bindExtensions"]>[0], "commandContextActions" | "abortHandler" | "shutdownHandler">>): Promise<void> {
  await session.bindExtensions({
    uiContext: ui,
    mode: "tui",
    ...bindings,
    onError: (error) => onError(error.extensionPath, error.event, error.error),
  });
}

/** Extensions get their documented session_shutdown before the session is dropped. */
export async function shutdownSession(session: SdkSession, reason: "quit" | "reload"): Promise<void> {
  try {
    await session.extensionRunner.emit({ type: "session_shutdown", reason });
  } finally {
    session.dispose();
  }
}

/** Read-only view of a persisted session file; never appends. */
export interface SessionReader {
  id: string;
  file: string | undefined;
  cwd: string;
  name: string | undefined;
  header: { id: string; timestamp: string; cwd: string; parentSession?: string } | null;
  /** Entries on the current branch, root → leaf, including compactions. */
  branch(): SdkEntry[];
  all(): SdkEntry[];
  leafId(): string | null;
}

export function readerFromManager(manager: SessionManager): SessionReader {
  const header = manager.getHeader();
  return {
    id: manager.getSessionId(),
    file: manager.getSessionFile(),
    cwd: manager.getCwd(),
    name: manager.getSessionName(),
    header: header ? { id: header.id, timestamp: header.timestamp, cwd: header.cwd, parentSession: header.parentSession } : null,
    branch: () => structuredClone(manager.getBranch()),
    all: () => structuredClone(manager.getEntries()),
    leafId: () => manager.getLeafId(),
  };
}

function readEntries(file: string): { entries: FileEntry[]; header: { version?: number; cwd: string; id: string } } {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let content: string;
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > 128 * 1024 * 1024) throw new Error("История Pi имеет неверный тип или слишком велика.");
    content = fs.readFileSync(fd, "utf8");
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error("История изменилась во время чтения.");
  } finally { fs.closeSync(fd); }
  const lines = content.split("\n").filter(line => line.trim());
  for (const line of lines) {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Строка истории Pi повреждена.");
  }
  const entries = parseSessionEntries(content);
  if (entries.length !== lines.length || entries[0]?.type !== "session") throw new Error("Заголовок истории Pi повреждён.");
  const header = entries[0];
  if (![1,2,3].includes(header.version ?? 1) || typeof header.cwd !== "string" || typeof header.id !== "string") throw new Error("Формат истории Pi не поддерживается.");
  const supported = new Set(["message", "thinking_level_change", "model_change", "compaction", "branch_summary", "custom", "custom_message", "label", "session_info"]);
  const sourceHeader = { ...header };
  migrateSessionEntries(entries);
  const ids = new Set<string>();
  for (const entry of entries.slice(1)) {
    if (entry.type === "session" || typeof entry.id !== "string" || ids.has(entry.id) || !(entry.parentId === null || ids.has(entry.parentId))) throw new Error("Дерево истории Pi повреждено.");
    if (!supported.has(entry.type)) throw new Error("История содержит неподдерживаемый тип записи.");
    if (entry.type === "message") {
      const message = entry.message;
      if (!message || typeof message !== "object" || !["user", "assistant", "toolResult", "custom", "bashExecution"].includes(message.role)) throw new Error("В истории Pi неизвестная роль сообщения.");
      if (message.role === "user" || message.role === "assistant" || message.role === "toolResult" || message.role === "custom") {
        if (typeof message.content !== "string" && !Array.isArray(message.content)) throw new Error("Содержимое сообщения Pi повреждено.");
      }
    }
    if ((entry.type === "compaction" || entry.type === "branch_summary") && typeof entry.summary !== "string") throw new Error("Выжимка истории Pi повреждена.");
    ids.add(entry.id);
  }
  return { entries, header: sourceHeader };
}
export function openSessionReader(file: string, _sessionDir: string): SessionReader {
  // No SessionManager.open(): it repairs missing LF and rewrites old formats.
  const { entries, header } = readEntries(file);
  const reader = readerFromManager(SessionManager.inMemory(header.cwd, undefined, structuredClone(entries)));
  return { ...reader, file };
}

export function sessionReaderOf(session: SdkSession): SessionReader {
  return readerFromManager(session.sessionManager);
}

export async function listSessionFiles(cwd: string, sessionDir: string): Promise<SdkSessionInfo[]> {
  if (!fs.existsSync(sessionDir)) return [];
  const result: SdkSessionInfo[] = [];
  for (const entry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const file = path.join(sessionDir, entry.name);
    // One unreadable/corrupt file stays on disk untouched; it must not hide
    // every other transcript of this folder from adoption.
    let reader: SessionReader;
    try { reader = openSessionReader(file, sessionDir); } catch { continue; }
    if (reader.cwd !== cwd) continue;
    const messages = reader.all().filter(entry => entry.type === "message");
    const texts = messages.flatMap(entry => entry.type === "message" && entry.message.role === "user" ?
      typeof entry.message.content === "string" ? [entry.message.content] : entry.message.content.flatMap(block => block.type === "text" ? [block.text] : []) : []);
    result.push({ path: file, id: reader.id, cwd, name: reader.name, parentSessionPath: reader.header?.parentSession,
      created: new Date(reader.header?.timestamp ?? 0), modified: fs.statSync(file).mtime,
      messageCount: messages.length, firstMessage: texts[0] ?? "", allMessagesText: texts.join("\n") });
  }
  return result;
}

/**
 * Branch a session into a new file containing the path root → `leafId`.
 * The source file is opened by a dedicated manager that never appends to it.
 */
export function branchSessionFile(sourceFile: string, sessionDir: string, leafId: string | null, cwd: string, newId: string): string {
  const source = openSessionReader(sourceFile, sessionDir), all = source.all();
  const byId = new Map(all.map(entry => [entry.id, entry]));
  const branch: SdkEntry[] = []; let next = leafId;
  while (next !== null) {
    const entry = byId.get(next); if (!entry) throw new Error("Сообщение не найдено в истории Pi.");
    branch.unshift(entry); next = entry.parentId;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(newId)) throw new Error("Неверный идентификатор ветки.");
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const file = path.join(sessionDir, `${Date.now()}_${newId}.jsonl`);
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, [{ type: "session", version: 3, id: newId, timestamp: new Date().toISOString(), cwd, parentSession: sourceFile }, ...branch].map(value => JSON.stringify(value)).join("\n") + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return file;
}

export type SeedMessage = SdkUserMessage | SdkAssistantMessage | SdkToolResultMessage;

/**
 * Create a new persisted session pre-filled with converted messages (legacy
 * continuation). Returns the file and the entry id of every appended message.
 * The caller owns a new staging directory. Persist the public header first,
 * then reopen the real SDK manager so empty/user-only histories are durable too.
 */
export function seedSession(cwd: string, sessionDir: string, id: string, intro: { customType: string; text: string; details: unknown },
  messages: SeedMessage[]): { file: string; entryIds: string[] } {
  if (!path.isAbsolute(cwd) || !path.isAbsolute(sessionDir) || !/^[A-Za-z0-9_-]{1,200}$/.test(id))
    throw new Error("Некорректная область нового продолжения.");
  const manager = SessionManager.create(cwd, sessionDir, { id });
  const file = manager.getSessionFile();
  const header = manager.getHeader();
  if (!file || !header || header.id !== id || fs.realpathSync(path.dirname(file)) !== fs.realpathSync(sessionDir))
    throw new Error("SDK не создал корректный заголовок продолжения.");
  const descriptor = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify(header) + "\n"); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  const persisted = SessionManager.open(file, sessionDir, cwd);
  persisted.appendCustomMessageEntry(intro.customType, intro.text, true, intro.details);
  const entryIds = messages.map(message => persisted.appendMessage(message));
  syncOwnedFile(file);
  return { file, entryIds };
}

/** Append-only recovery entries for a session that has no live worker. */
export function appendRecoveryToolResult(file: string, sessionDir: string, result: { toolCallId: string; toolName: string; text: string }): string {
  const manager = SessionManager.open(ownedSessionFile(file, sessionDir), sessionDir);
  return manager.appendMessage({
    role: "toolResult",
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    content: [{ type: "text", text: result.text }],
    isError: true,
    timestamp: Date.now(),
  });
}

export function findModel(runtime: SdkModelRuntime, providerID: string, modelID: string): SdkModel | undefined {
  return runtime.getModel(providerID, modelID);
}

export interface CatalogProvider {
  id: string;
  name: string;
  baseUrl?: string;
  configured: boolean;
  models: SdkModel[];
}

/** Static snapshot of every known provider/model and whether auth is configured. */
export function catalogSnapshot(runtime: SdkModelRuntime): CatalogProvider[] {
  return runtime.getProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    configured: runtime.hasConfiguredAuth(provider.id),
    models: [...runtime.getModels(provider.id)],
  }));
}

/** Private request material for read-only access discovery. Never a protocol DTO.
 * Skip command-backed/config auth: listing models must not execute a configured
 * API-key command. Explicit model requests retain the SDK's normal semantics. */
export async function catalogueRequest(runtime: SdkModelRuntime, model: SdkModel, signal: AbortSignal): Promise<{ baseURL: string; headers: Record<string, string>; subscription: boolean } | null> {
  configProjection(runtime)?.assertAdmissible(model.provider);
  const status = runtime.getProviderAuthStatus(model.provider);
  if (!status.configured || !["stored", "runtime", "environment", "models_json_key", "fallback"].includes(status.source ?? "")) return null;
  const commandHeaders = (value: unknown): boolean => !!value && typeof value === "object" && Object.values(value).some(v => typeof v === "string" && v.trimStart().startsWith("!"));
  const registered = runtime.getRegisteredProviderConfig(model.provider);
  if (commandHeaders(model.headers) || commandHeaders(registered?.headers)) return null;
  const file = modelConfigPaths.get(runtime);
  if (file && fs.existsSync(file)) {
    try {
      if (fs.statSync(file).size > 4 * 1024 * 1024) return null;
      const providers = JSON.parse(fs.readFileSync(file, "utf8")).providers;
      const config = providers?.[model.provider];
      if (commandHeaders(config?.headers) || commandHeaders(config?.modelOverrides?.[model.id]?.headers)
        || commandHeaders(config?.models?.find((m: { id?: string }) => m.id === model.id)?.headers)) return null;
    } catch { return null; }
  }
  const resolved = await runtime.getAuth(model, { signal });
  if (!resolved) return null;
  const headers: Record<string, string> = {};
  if (resolved.auth.apiKey) {
    if (model.api === "anthropic-messages") { headers["x-api-key"] = resolved.auth.apiKey; headers["anthropic-version"] ??= "2023-06-01"; }
    else if (model.api === "google-generative-ai") headers["x-goog-api-key"] = resolved.auth.apiKey;
    else headers.Authorization = `Bearer ${resolved.auth.apiKey}`;
  }
  for (const [name, value] of Object.entries(resolved.auth.headers ?? {})) {
    for (const k of Object.keys(headers)) if (k.toLowerCase() === name.toLowerCase()) delete headers[k];
    if (value !== null) headers[name] = value;
  }
  for (const [name, value] of configProjection(runtime)?.headersFor(model.provider, model.id) ?? []) {
    for (const k of Object.keys(headers)) if (k.toLowerCase() === name.toLowerCase()) delete headers[k];
    if (value !== null) headers[name] = value;
  }
  return { baseURL: resolved.auth.baseUrl ?? model.baseUrl, headers, subscription: runtime.isUsingSubscription(model.provider) };
}

export async function refreshCatalog(runtime: SdkModelRuntime, signal: AbortSignal): Promise<string[]> {
  const result = await runtime.refresh({ allowNetwork: true, signal });
  return [...result.errors.entries()].map(([provider, error]) => `${provider}: ${error.message}`.slice(0, 300));
}
export async function refreshCredentialSnapshot(runtime: SdkModelRuntime, signal: AbortSignal): Promise<void> {
  await runtime.refresh({ allowNetwork: false, signal });
}

export function modelThinkingLevels(model: SdkModel): string[] {
  return getSupportedThinkingLevels(model);
}

export function trustStore(agentDir: string): { get(cwd: string): boolean | null; set(cwd: string, decision: boolean | null): void } {
  const store = new ProjectTrustStore(agentDir);
  return { get: (cwd) => store.get(cwd), set: (cwd, decision) => store.set(cwd, decision) };
}

export function supportedThinkingLevels(session: SdkSession): SdkThinkingLevel[] {
  return session.getAvailableThinkingLevels();
}

export type SdkUsageSnapshot = { tokens: number | null; contextWindow: number; percent: number | null };

export function contextUsage(session: SdkSession): SdkUsageSnapshot | undefined {
  return session.getContextUsage();
}

/** Conservative per-image allowance; providers bill images far above chars/4. */
export const IMAGE_TOKEN_ALLOWANCE = 1_600;

/** max(SDK chars/4 estimate, own content estimate + image allowance). Image
 * payload bytes are never counted as text; each image block gets the allowance. */
export function estimateMessageTokens(message: SdkMessage): number {
  let images = 0;
  const body = (message as { content?: unknown }).content ?? message;
  const text = JSON.stringify(body, (_key, value: unknown) => {
    if (value && typeof value === "object" && (value as { type?: unknown }).type === "image") { images++; return "[image]"; }
    return value;
  }) ?? "";
  const own = Math.ceil(text.length / 4) + images * IMAGE_TOKEN_ALLOWANCE;
  let sdk = 0;
  try { sdk = estimateTokens(message); } catch { sdk = 0; }
  return Math.max(own, Number.isFinite(sdk) && sdk > 0 ? sdk : 0);
}

export interface SessionContextEstimate {
  /** Public SDK getContextUsage().tokens; null when unknown (e.g. right after compaction). */
  usage: number | null;
  /** System prompt + active tool schemas + current context messages, estimated. */
  estimate: number;
  system: number;
  tools: number;
  messages: number;
  /** Conservative input tokens of the next request: max(usage, estimate). */
  tokens: number;
}

/** What the NEXT request carries, from bounded public SDK data only. Throws
 * when no finite estimate exists; unknown must never mean "fits". */
export function estimateSessionContext(session: SdkSession): SessionContextEstimate {
  const raw = session.getContextUsage()?.tokens;
  const usage = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
  const system = Math.ceil((session.systemPrompt ?? "").length / 4);
  const active = new Set(session.getActiveToolNames());
  const tools = session.getAllTools().filter(tool => active.has(tool.name))
    .reduce((sum, tool) => sum + Math.ceil(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length / 4), 0);
  const messages = session.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const estimate = system + tools + messages;
  if (!Number.isFinite(estimate) || estimate < 0) throw new Error("Не удалось оценить размер контекста по данным SDK.");
  return { usage, estimate, system, tools, messages, tokens: Math.max(usage ?? 0, estimate) };
}
