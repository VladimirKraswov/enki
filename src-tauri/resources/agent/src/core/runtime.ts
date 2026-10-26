// Composition root of one Enki Runtime process (one per execution host).

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { backup as sqliteBackup } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { Admission } from "../admission.ts";
import { MaintenanceGate } from "../lifecycle.ts";
import type { Broker, CapabilitiesScope } from "../control/broker.ts";
import { Dispatcher } from "../execution/dispatcher.ts";
import { ToolJournal } from "../execution/tools.ts";
import { enkiExtensions } from "../extensions/enki.ts";
import { InteractionBroker } from "../interaction/broker.ts";
import type { DefaultPolicy } from "../interaction/access.ts";
import { continueLegacy, recoverLegacyContinuations } from "../legacy/continue.ts";
import { OpenCodeArchiveReader } from "../legacy/opencode-reader.ts";
import { OpenCodeImporter } from "../legacy/opencode-import.ts";
import { importPiAgent, planPiAgentImport } from "../legacy/pi-agent.ts";
import { NativePiConfigCommitPort, type CommitReceipt } from "../legacy/pi-config-commit.ts";
import { PiCliImporter } from "../legacy/pi-cli.ts";
import { archiveWireId, projectArchiveMessages } from "../legacy/wire-projection.ts";
import { CutoverJournal, type CutoverSessionRef, type CutoverTarget } from "../migration/cutover.ts";
import { McpPool } from "../mcp/pool.ts";
import { ConfigProjection, userModelsPresent, type ConfigStatus } from "../models/config.ts";
import { VaultCredentialStore } from "../models/credentials.ts";
import { HubLeases } from "../models/hub.ts";
import { findGit, GitService } from "../platform/git.ts";
import { ownedSessionPath, runtimePaths, sessionDirFor, SESSION_LAYOUT, validDirectory, type RuntimePaths } from "../platform/paths.ts";
import { PtyService, type PtyModule } from "../platform/pty.ts";
import { openOwnedFileForSync } from "../platform/owned-sync.ts";
import { snapshotSessions, syncDirectory, type SessionSnapshot } from "../platform/update-snapshot.ts";
import { resolveLocalPackage } from "../plugin-ui/local-packages.ts";
import { shutdownPluginUi, type NativeUiScope } from "../plugin-ui/runtime.ts";
import { isReadOnlyOrigin, SCHEMA_VERSION, SDK_VERSION, type MessageDTO, type ModelRef, type PromptPart, type ScheduleDTO, type SessionStatusDTO } from "../protocol.ts";
import { PromptQueue } from "../queue/queue.ts";
import { Scheduler } from "../schedule/scheduler.ts";
import { assertPinnedSdk, createModelRuntime, findModel, isThinkingLevel, qualifiedResourceSpec, trustStore, type ResourceSpec, type SdkExtension, type SdkModelRuntime, type SettingsSpec } from "../sdk/adapter.ts";
import { SessionCatalog, type SessionRecord } from "../sessions/catalog.ts";
import { SessionShards } from "../sessions/rehome.ts";
import { SessionRegistry } from "../sessions/registry.ts";
import { recoverInterruptedTools } from "../sessions/worker.ts";
import { AttachmentStore } from "../store/attachments.ts";
import { CommandLedger } from "../store/commands.ts";
import { acquireWriterLock, Database, text } from "../store/db.ts";
import { EventJournal } from "../store/events.ts";
import { CatalogueAccess } from "../models/access.ts";

export interface RuntimeSettings {
  defaultPolicy: DefaultPolicy;
  /** Explicit extension files loaded in addition to Enki's own (no ambient discovery). */
  extensionPaths: string[];
  /** Explicit skill files/directories of THIS host (owner-chosen; never discovered). */
  skillPaths?: string[];
  /** Explicit prompt-template files/directories of THIS host (owner-chosen; never discovered). */
  promptPaths?: string[];
  /** Explicit LOCAL Pi package folders of THIS host (owner-chosen; never
   * discovered, downloaded or installed). Their extensions are trusted code
   * because the owner configured them; see plugin-ui/local-packages.ts. */
  packagePaths?: string[];
  /** Wire-compatible field. Owner ~/.pi/agent resources are never loaded
   * implicitly, so the effective (and stored) value is always false. */
  useUserPiResources: boolean;
  /** Wire-compatible field. Ambient agentDir/project discovery is always off
   * (ResourceSpec is explicit), so the effective value is always true. */
  noDiscoveredExtensions: boolean;
  gitProgram: string | null;
  compaction: { enabled: boolean; reserveTokens?: number; keepRecentTokens?: number };
  /** The managed browser is opt-in in Enki's settings; its tools load only when on. */
  browserEnabled: boolean;
  /** Persisted LSP switch: when off, the configured language servers are not loaded. */
  lspEnabled: boolean;
}

/** The only resource-discovery policy the runtime implements (see resources()). */
const EFFECTIVE_DISCOVERY = Object.freeze({ useUserPiResources: false, noDiscoveredExtensions: true });
const DEFAULT_SETTINGS: RuntimeSettings = {
  defaultPolicy: "ask", extensionPaths: [], skillPaths: [], promptPaths: [], packagePaths: [], useUserPiResources: false, noDiscoveredExtensions: true, gitProgram: null,
  compaction: { enabled: true }, browserEnabled: false, lspEnabled: true,
};

/** At most 64 absolute host paths without NUL (optional lists may be absent). */
const explicitPaths = (value: unknown, optional = false): boolean => (optional && value === undefined)
  || (Array.isArray(value) && value.length <= 64 && value.every((p) => typeof p === "string" && path.isAbsolute(p) && !p.includes("\0")));

export interface ResourcePathStatus { path: string; present: boolean }

export function validSettings(value: unknown): value is RuntimeSettings {
  if (!value || typeof value !== "object") return false;
  const s = value as RuntimeSettings;
  return ["ask", "read", "full"].includes(s.defaultPolicy) && explicitPaths(s.extensionPaths)
    && explicitPaths(s.skillPaths, true) && explicitPaths(s.promptPaths, true) && explicitPaths(s.packagePaths, true) && typeof s.useUserPiResources === "boolean"
    && typeof s.noDiscoveredExtensions === "boolean" && (s.gitProgram === null || (typeof s.gitProgram === "string" && path.isAbsolute(s.gitProgram)))
    && !!s.compaction && typeof s.compaction.enabled === "boolean" && typeof s.browserEnabled === "boolean" && typeof s.lspEnabled === "boolean";
}

export interface RuntimeConfig {
  /** Host lifecycle cancellation during initialization. */
  signal?: AbortSignal;
  /** Trusted installer startup; no prompt/queue/timer is admitted before commit. */
  initialMaintenance?: boolean;
  dataDir: string;
  agentDir?: string;
  host: "local" | "remote";
  broker: Broker;
  credentials: "vault" | "agent-dir" | "memory";
  /** Explicitly configured former Pi profile; absent for isolated profiles. */
  userPiAgentDir?: string;
  legacy: { opencodeDb?: string; piCliRoot?: string };
  allowModelNetwork: boolean;
  version: string;
  /** Tests inject a model runtime with a scripted provider. */
  modelRuntime?: SdkModelRuntime;
  /** Tests inject shared-capability scope; production asks the broker. */
  capabilities?: (directory: string) => Promise<CapabilitiesScope | null>;
  /** Tests add plugin extensions (tools, UI calls) exactly as a Pi package would. */
  extraExtensions?: (session: { sessionID: string; directory: string }) => SdkExtension[];
  settingsInMemory?: boolean;
  /** Tests replace node-pty with an in-memory module; no shell is spawned. */
  ptyModule?: () => Promise<PtyModule | null>;
}
export interface UpdateBackup {
  id: string; relativePath: string; sha256: string; bytes: number; schema: number;
  runtimeVersion: string; sdk: string; createdAt: number;
  /** Exact paired copy of every mutable SDK session JSONL (platform/update-snapshot.ts). */
  sessions: SessionSnapshot;
}

export class Runtime {
  readonly instance = randomUUID();
  readonly startedAt = Date.now();
  draining = false;
  readonly admission = new Admission();
  readonly hostId: string;
  readonly config: RuntimeConfig;
  readonly paths: RuntimePaths;
  readonly db: Database;
  readonly journal: EventJournal;
  readonly ledger: CommandLedger;
  readonly catalog: SessionCatalog;
  readonly interactions: InteractionBroker;
  readonly tools: ToolJournal;
  readonly attachments: AttachmentStore;
  readonly queue: PromptQueue;
  readonly scheduler: Scheduler;
  readonly pool: McpPool;
  readonly pty: PtyService;
  readonly git: GitService;
  readonly importer: OpenCodeImporter;
  /** Former Pi CLI chats: immutable original + owned writable working copy. */
  readonly piCli: PiCliImporter;
  readonly cutover: CutoverJournal;
  /** Canonical shard keying of Enki's own transcripts (restart-safe migration). */
  readonly shards: SessionShards;
  /** Startup recovery failures, reported by GET /migrations. */
  readonly recoveryIssues: Array<{ kind: string; message: string }> = [];
  /** Chats whose transcript the shard migration deliberately left alone. */
  readonly shardIssues: Array<{ session: string; reason: string }> = [];
  readonly hub: HubLeases;
  /** Verified imported config resolved into memory at startup; immutable until restart. */
  configProjection: ConfigProjection = ConfigProjection.none();
  /** Generation committed by importPiConfig in THIS process; active after restart. */
  private committedForRestart: { configRevision: number; generationId: string } | undefined;
  registry!: SessionRegistry;
  dispatcher!: Dispatcher;
  modelRuntime!: SdkModelRuntime;
  modelAccess?: CatalogueAccess;
  private releaseLock: () => void;
  private archiveReaders = new Map<string, OpenCodeArchiveReader>();
  private capabilityScopes = new Map<string, { at: number; scope: CapabilitiesScope | null }>();
  private capabilityEpoch = 0;
  private readonly uiAuthorities = new Map<string, number>();
  private readonly maintenance = new MaintenanceGate({
    fence: held => this.fenceMaintenance(held), authoritativeIdle: async () => this.activity().idle,
  });
  private shuttingDown?: Promise<void>;
  private updateCopies = 0;

  private constructor(config: RuntimeConfig) {
    const underlying = config.broker;
    this.config = { ...config, broker: {
      kind: underlying.kind, available: () => underlying.available(),
      call: <T>(method: Parameters<Broker["call"]>[0], params: Record<string, unknown>, signal?: AbortSignal, timeout?: number) => {
        const release = this.admission.reserve("broker");
        return Promise.resolve().then(() => underlying.call<T>(method, params, signal, timeout)).finally(release);
      },
    } };
    this.pty = new PtyService(config.ptyModule);
    this.paths = runtimePaths(config.dataDir, config.agentDir);
    this.releaseLock = acquireWriterLock(this.paths.data, { pid: process.pid, instance: this.instance, startedAt: this.startedAt });
    let opened: Database | undefined;
    try {
    this.db = opened = new Database(this.paths.db);
    const savedHost = text(this.db.get("SELECT value FROM meta WHERE key='host_id'"), "value");
    if (savedHost && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(savedHost)) throw new Error("Повреждён идентификатор хоста Enki.");
    this.hostId = savedHost || randomUUID();
    if (!savedHost) this.db.run("INSERT INTO meta(key,value) VALUES('host_id',?)", this.hostId);
    this.journal = new EventJournal(this.db);
    this.ledger = new CommandLedger(this.db, this.journal);
    this.catalog = new SessionCatalog(this.db, this.journal);
    this.interactions = new InteractionBroker(this.db, this.journal);
    this.tools = new ToolJournal(this.db);
    this.attachments = new AttachmentStore(this.db, this.paths.data);
    this.queue = new PromptQueue(this.db, this.journal, this.attachments);
    this.scheduler = new Scheduler(this.db, this.journal);
    this.pool = new McpPool();
    this.git = new GitService(() => findGit(this.settings().gitProgram));
    this.importer = new OpenCodeImporter(this.db, this.catalog, this.paths.legacy, this.paths.staging);
    // Disjoint app-owned roots; the names are never 64-hex archive ids or UUID
    // job ids, so neither importer's recovery can address the other's files.
    // Writable imports live in SESSION_LAYOUT.piCli, which the paired update
    // snapshot copies and restores together with the SDK shards.
    this.piCli = new PiCliImporter(this.db, this.catalog, {
      archives: path.join(this.paths.legacy, "pi-cli"), staging: path.join(this.paths.staging, "pi-cli"), sessions: path.join(this.paths.sessions, SESSION_LAYOUT.piCli),
    });
    this.cutover = new CutoverJournal(this.db, this.attachments, this.queue, this.scheduler, (ref, model, signal) => this.cutoverTarget(ref, model, signal));
    this.shards = new SessionShards(this.db, this.catalog, this.paths);
    this.hub = new HubLeases(this.config.broker, this.db, (owner) => this.leaseActive(owner),
      (owner, status) => this.journal.append(this.catalog.get(owner)?.directory ?? null, owner, { type: "model.status", properties: { sessionID: owner, status } }, true),
      (owner, message) => this.hubLeaseLost(owner, message));
    } catch (error) {
      // Synchronous construction owns the OS lease too. A malformed/missing DB
      // must not strand it until GC or prevent a repaired retry in this process.
      try { opened?.close(); this.releaseLock(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Runtime construction and cleanup failed"); }
      throw error;
    }
  }

  static async create(config: RuntimeConfig): Promise<Runtime> {
    config.signal?.throwIfAborted();
    if (!config.modelRuntime) assertPinnedSdk();
    const runtime = new Runtime(config);
    try {
      await runtime.backupOnVersionChange();
      config.signal?.throwIfAborted();
      // Before catalog/admission/registry: the committed sanitized snapshot is
      // verified and every binding resolved into memory. Missing/changed
      // bindings leave the projection blocked (CONFIG_SECRET_UNAVAILABLE).
      // Only the local vault-backed host has a native config authority.
      if (!config.modelRuntime && config.credentials === "vault" && config.host === "local")
        runtime.configProjection = await ConfigProjection.load(runtime.config.broker, { agentDir: runtime.paths.agentDir, signal: config.signal });
      config.signal?.throwIfAborted();
      const projection = runtime.configProjection;
      runtime.modelRuntime = config.modelRuntime ?? await createModelRuntime({
        agentDir: runtime.paths.agentDir,
        credentials: config.credentials === "vault" ? { kind: "vault", store: new VaultCredentialStore(runtime.config.broker, projection) } : config.credentials === "memory" ? { kind: "memory" } : { kind: "agent-dir" },
        allowNetwork: config.allowModelNetwork, signal: config.signal,
        ...(projection.state === "none" ? {} : { config: projection }),
      });
      config.signal?.throwIfAborted();
      runtime.modelAccess = new CatalogueAccess(runtime.modelRuntime, (p, m) => !!runtime.hub.route(p, m),
        () => runtime.journal.append(null, null, { type: "provider.catalog.updated", properties: {} }, true), config.allowModelNetwork);
      runtime.wire();
      runtime.recover();
      if (config.initialMaintenance) runtime.maintenance.holdAtStartup();
      runtime.registry.start();
      runtime.scheduler.start();
      runtime.hub.start();
      return runtime;
    } catch (error) {
      try { await runtime.shutdown(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Enki Runtime initialization and cleanup failed'); }
      throw error;
    }
  }

  /**
   * First start of a different runtime artifact: keep a consistent copy of the
   * metadata database for rollback before anything new is written. Session
   * transcripts are append-only JSONL and are not rewritten by an upgrade.
   */
  private async backupOnVersionChange(): Promise<void> {
    const previous = text(this.db.get("SELECT value FROM meta WHERE key='runtime_version'"), "value");
    if (previous === this.config.version) return;
    if (previous) {
      const dir = path.join(this.paths.data, "backups");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      await sqliteBackup(this.db.db, path.join(dir, `runtime-${previous.replace(/[^A-Za-z0-9._-]/g, "_")}-${Date.now()}.sqlite`));
    }
    this.db.run("INSERT INTO meta(key,value) VALUES('runtime_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", this.config.version);
    this.db.run("INSERT INTO meta(key,value) VALUES('previous_runtime_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", previous || "");
  }

  settings(): RuntimeSettings {
    try {
      const stored: unknown = JSON.parse(text(this.db.get("SELECT value FROM meta WHERE key='settings'"), "value") || "null");
      // Fields added later default without discarding the user's other choices.
      const value = stored && typeof stored === "object" ? { ...DEFAULT_SETTINGS, ...stored, ...EFFECTIVE_DISCOVERY } : DEFAULT_SETTINGS;
      return validSettings(value) ? value : DEFAULT_SETTINGS;
    } catch { return DEFAULT_SETTINGS; }
  }

  saveSettings(requested: RuntimeSettings): RuntimeSettings {
    if (!validSettings(requested)) throw new Error("Некорректные настройки среды выполнения.");
    // Report and store what actually applies, never an inert "on" switch.
    const next = { ...requested, ...EFFECTIVE_DISCOVERY };
    const before = this.settings();
    this.db.run("INSERT INTO meta(key,value) VALUES('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(next));
    this.journal.append(null, null, { type: "runtime.settings", properties: { settings: next } });
    // Switches that select worker resources apply to open chats at their next idle use.
    const resources = (s: RuntimeSettings) => JSON.stringify([s.extensionPaths, s.skillPaths ?? [], s.promptPaths ?? [], s.packagePaths ?? [], s.browserEnabled, s.lspEnabled]);
    if (this.registry && resources(before) !== resources(next)) void this.refreshCapabilities(null).catch(() => undefined);
    // Requests already waiting are decided by the policy now in force (exactly once).
    if (before.defaultPolicy !== next.defaultPolicy) this.interactions.reevaluatePermissions();
    return next;
  }

  /**
   * The explicitly configured resources of THIS host and whether each path
   * exists (a missing one is skipped, never searched for), plus the imported
   * Pi resource keys that were NOT activated (`deferred` pointers, no values).
   */
  resourceStatus(): { extensions: ResourcePathStatus[]; skills: ResourcePathStatus[]; prompts: ResourcePathStatus[];
    packages: Array<ResourcePathStatus & { extensions: number; skills: number; prompts: number; themes: number; diagnostics: string[] }>; deferred: string[] } {
    const s = this.settings();
    const status = (paths: readonly string[] = []) => paths.map((file) => ({ path: file, present: fs.existsSync(file) }));
    const packages = (s.packagePaths ?? []).map((root) => {
      const resolved = resolveLocalPackage(root);
      return { path: root, present: fs.existsSync(root), extensions: resolved.extensions.length, skills: resolved.skills.length,
        prompts: resolved.prompts.length, themes: resolved.themes.length, diagnostics: resolved.diagnostics.slice(0, 20) };
    });
    return { extensions: status(s.extensionPaths), skills: status(s.skillPaths), prompts: status(s.promptPaths), packages, deferred: [...this.configStatus().deferred] };
  }

  sdkSettings(): SettingsSpec {
    const s = this.settings();
    const imported = this.configProjection.settings;
    const retry = imported.retry && typeof imported.retry === "object" ? imported.retry as SettingsSpec["retry"] : { enabled: true, maxRetries: 3 };
    return { compaction: s.compaction, retry, ...(Object.keys(imported).length ? { imported } : {}),
      ...(this.config.settingsInMemory ? { inMemory: true } : {}) };
  }

  /** Sanitized import state for clients: no values, header names or paths. */
  configStatus(): ConfigStatus {
    const status = this.configProjection.status(), pending = this.committedForRestart;
    return pending && pending.generationId !== status.generationId ? { ...status, pendingRestart: { ...pending } } : status;
  }

  /**
   * The imported default model of the ACTIVE projection, only when it exists in
   * the live catalog and passes the projection's admission; otherwise null with
   * a structured code. Used for sessions created without an explicit model and
   * offered to clients; never written into owner settings or UI preferences.
   */
  configDefaults(): { model: ModelRef | null; code: string | null } {
    const wanted = this.configProjection.defaultModel;
    if (!wanted) return { model: null, code: null };
    if (!this.modelRuntime || !findModel(this.modelRuntime, wanted.providerID, wanted.modelID)) return { model: null, code: "CONFIG_DEFAULT_MODEL_UNAVAILABLE" };
    try { this.configProjection.assertAdmissible(wanted.providerID); }
    catch (error) { return { model: null, code: (error as { code?: unknown }).code === undefined ? "CONFIG_DEFAULT_MODEL_UNAVAILABLE" : String((error as { code: unknown }).code) }; }
    return { model: { providerID: wanted.providerID, modelID: wanted.modelID }, code: null };
  }

  /**
   * Import the owner's explicitly configured Pi agent directory through the
   * native authority. Applies on the next runtime start (or a future
   * maintenance-fenced reload): this process keeps its immutable projection,
   * so an old endpoint and a new key are never mixed.
   */
  async importPiConfig(signal?: AbortSignal): Promise<{ receiptId: string; copied: string[]; credentials: number; deferred: string[]; receipt: CommitReceipt; applies: "restart" }> {
    if (this.config.host !== "local" || this.config.credentials !== "vault" || this.config.broker.kind !== "supervisor")
      throw new Error("CONFIG_NATIVE_UNAVAILABLE: перенос настроек Pi требует локального хранилища ключей Enki; auth.json не используется.");
    const source = this.config.userPiAgentDir;
    if (!source) throw new Error("CONFIG_SOURCE_UNCONFIGURED: для этого профиля Enki не задан каталог прежних настроек Pi; ничего не прочитано.");
    const release = this.admission.reserve("config");
    try {
      const plan = planPiAgentImport(source, { origin: "user-pi-agent" });
      let receipt: CommitReceipt | undefined;
      const port = new NativePiConfigCommitPort(this.config.broker, { signal, preflight: () => {
        if (this.maintenance.isHeld()) throw new Error("CONFIG_MAINTENANCE: идёт обслуживание среды выполнения; повторите позже.");
        if (userModelsPresent(this.paths.agentDir))
          throw new Error("CONFIG_EXISTING_MODELS_CONFLICT: в Enki уже есть models.json; объедините настройки вручную, импорт не перезапишет их.");
      } });
      const result = await importPiAgent(plan, { commit: async value => (receipt = await port.commit(value)) });
      if (!receipt) throw new Error("CONFIG_INCOMPLETE: нет квитанции фиксации.");
      // Honest restart semantics: the running projection/ModelRuntime stay as
      // they are (no old-endpoint/new-key mix); status reports the pending one.
      this.committedForRestart = { configRevision: receipt.configRevision, generationId: receipt.generationId };
      return { ...result, receipt, applies: "restart" };
    } finally { release(); }
  }

  sessionDir(directory: string): string { return sessionDirFor(this.paths, directory); }

  private async capabilities(directory: string): Promise<CapabilitiesScope | null> {
    if (this.config.capabilities) return this.config.capabilities(directory);
    if (this.config.host !== "local" || !this.config.broker.available()) return null;
    const cached = this.capabilityScopes.get(directory);
    if (cached && Date.now() - cached.at < 30_000) return cached.scope;
    const epoch = this.capabilityEpoch;
    const scope = await this.config.broker.call<CapabilitiesScope>("capabilities.prepare", { directory }, undefined, 20_000).catch(() => null);
    // A reply that raced a refresh may describe the old registry: use it once, never cache it.
    if (epoch === this.capabilityEpoch) this.capabilityScopes.set(directory, { at: Date.now(), scope });
    return scope;
  }

  /**
   * Called by an authenticated client after it CONFIRMED a shared-registry,
   * skill or capability commit on this execution host. The next worker opens
   * with the updated scope immediately; idle workers reopen on next use, busy
   * ones once idle (registry.refreshResources). `directory` null = all.
   */
  async refreshCapabilities(directory: string | null): Promise<{ reopened: number; pending: number }> {
    this.capabilityEpoch++;
    if (directory === null) this.capabilityScopes.clear(); else this.capabilityScopes.delete(directory);
    const result = await this.registry.refreshResources(directory);
    this.journal.append(directory, null, { type: "runtime.resources", properties: { directory, ...result } });
    return result;
  }

  private async resources(record: SessionRecord): Promise<ResourceSpec> {
    const settings = this.settings();
    const scope = await this.capabilities(record.directory);
    // Persisted switches gate the actual resources (applied when a worker opens).
    const caps = scope ? { ...scope, browser: scope.browser && settings.browserEnabled, lspConfig: settings.lspEnabled ? scope.lspConfig : null } : null;
    const reported = (scope as (CapabilitiesScope & { computerSkillPath?: unknown }) | null)?.computerSkillPath;
    const computerSkill = typeof reported === "string" && path.isAbsolute(reported) ? reported : null;
    const trust = trustStore(this.paths.agentDir);
    // Owner-configured resources follow the pinned SDK's resolve() order
    // (package-manager.js 0.85.1): configured PACKAGES first, then the top-level
    // extension/skill/prompt entries; first wins a name collision (SDK skill
    // loader, ScopedResources' prompt dedupe). Enki's own capability, browser
    // and computer skills precede both, as the bundled tool authority.
    const packages = (settings.packagePaths ?? []).map((root) => resolveLocalPackage(root));
    const fromPackages = (type: "extensions" | "skills" | "prompts" | "themes") => packages.flatMap((resolved) => resolved[type]);
    return qualifiedResourceSpec({
      extensions: [
        ...enkiExtensions({
          sessionID: record.id, directory: record.directory,
          rules: () => this.catalog.get(record.id)?.permission ?? [],
          workshop: () => this.catalog.get(record.id)?.workshop ?? false,
        }, { broker: this.interactions, journal: this.journal, pool: this.pool, defaultPolicy: () => this.settings().defaultPolicy, capabilities: caps }),
        ...(this.config.extraExtensions?.({ sessionID: record.id, directory: record.directory }) ?? []),
      ],
      // Owner-chosen files only; a path that no longer exists is skipped (and
      // reported by GET /settings/resources), never searched for elsewhere.
      extensionPaths: [...fromPackages("extensions"), ...settings.extensionPaths.filter((p) => fs.existsSync(p))],
      skillPaths: [...(caps?.skillPaths ?? []), ...(caps?.browser && caps.browserSkillPath ? [caps.browserSkillPath] : []),
        // Explicitly enabled computer use of THIS execution host (native gate re-checks every call).
        ...(computerSkill ? [computerSkill] : []), ...fromPackages("skills"), ...(settings.skillPaths ?? []).filter((p) => fs.existsSync(p))],
      promptPaths: [...fromPackages("prompts"), ...(settings.promptPaths ?? []).filter((p) => fs.existsSync(p))],
      ...(packages.some((resolved) => resolved.themes.length) ? { themePaths: fromPackages("themes") } : {}),
      noDiscoveredExtensions: true,
      projectTrusted: async (cwd) => trust.get(cwd) === true,
    });
  }

  /**
   * Explicit deletion of an idle chat: the registry closes its worker, writes
   * the tombstone and keeps a recoverable transcript copy in trash; then the
   * metadata this chat owned is dropped so nothing keeps acting for it (queued
   * prompts, remembered grants, a held Hub reservation). Timers stay listed,
   * paused by the scheduler with "chat deleted", for the owner to remove.
   */
  async deleteSession(sessionID: string): Promise<void> {
    if (this.dispatcher.inFlight(sessionID)) throw new Error("Сначала остановите ответ.");
    await this.registry.remove(sessionID);
    this.queue.discardSession(sessionID);
    this.interactions.forgetSession(sessionID);
    await this.hub.release(sessionID).catch(() => undefined);
    this.publishActivity();
  }

  /** Busy, queued, gated or waiting for the user: keep the session worker open. */
  retained(sessionID: string): boolean {
    return this.dispatcher?.inFlight(sessionID) || this.queue.hasWork(sessionID) || this.interactions.hasPending(sessionID);
  }

  /** Whole-turn lease: held while a turn runs or the next armed queue item is about to. */
  private leaseActive(sessionID: string): boolean {
    return this.dispatcher?.inFlight(sessionID) || this.interactions.hasPending(sessionID) || this.queue.armedWork(sessionID);
  }

  /** The Hub explicitly ended a held reservation. Inference that depends on it
   * — a running turn, a source-model summary before a switch, a manual
   * compaction, a target about to be selected — is stopped with a truthful
   * reason (never continued on whatever the Hub serves now, never silently
   * re-prepared, never followed by the target). Between turns the next
   * ensureRun prepares anew. */
  private hubLeaseLost(sessionID: string, message: string): void {
    if (!this.dispatcher?.leaseInUse(sessionID)) return;
    // The notice is best effort; failing to record it never skips the stop.
    try {
      this.journal.append(this.catalog.get(sessionID)?.directory ?? null, sessionID,
        { type: "session.error", properties: { sessionID, error: { name: "HubLeaseLost", message } } });
    } catch { /* the abort below still runs */ }
    void this.dispatcher.abort(sessionID, message).catch(() => undefined);
  }

  /** Read-only raw reader of one verified, app-owned archive snapshot. */
  archiveReader(archive: string): OpenCodeArchiveReader {
    let reader = this.archiveReaders.get(archive);
    if (!reader) {
      reader = new OpenCodeArchiveReader(this.importer.archiveFile(archive));
      this.archiveReaders.set(archive, reader);
    }
    return reader;
  }

  /**
   * Wire projection of an archive: message/part ids are namespaced to this
   * runtime session, so a historical SQL id is never mistaken for a live SDK
   * entry (stop/fork/usage/latest-result paths). Raw ids stay in annotations.
   */
  legacyHistory(record: SessionRecord): MessageDTO[] | null {
    if (record.origin.kind !== "opencode") return null;
    return projectArchiveMessages(this.archiveReader(record.origin.archive).messages(record.origin.legacyId), record.id);
  }

  legacyHistoryPage(record: SessionRecord, limit: number, before?: string): { messages: MessageDTO[]; before?: string } | null {
    if (record.origin.kind !== "opencode") return null;
    const page = this.archiveReader(record.origin.archive).historyPage(record.origin.legacyId, limit, before,
      id => archiveWireId("message", record.id, id));
    return { ...page, messages: projectArchiveMessages(page.messages, record.id) };
  }

  /** Transcript directory owned for this record.
   *
   * An existing app-owned transcript keeps its own shard: a chat is never
   * orphaned while its folder is reachable through an alias, and imported Pi CLI
   * copies keep living in the root they were adopted with. New work always lands
   * in the canonical shard of the directory. */
  sessionDirOf(record: SessionRecord): string {
    if (record.sessionFile && ownedSessionPath(this.paths, record.sessionFile)) return path.dirname(record.sessionFile);
    if (record.origin.kind === "pi-cli" && record.sessionFile === this.piCli.runtimeFile(record.origin.runtimeId)) return path.dirname(record.sessionFile);
    return this.sessionDir(record.directory);
  }

  /** Stable source identity of this host's former Pi CLI root. */
  piCliOrigin(root: string): string {
    return `pi-cli:${this.hostId}:${createHash("sha256").update(fs.realpathSync(root)).digest("hex").slice(0, 32)}`;
  }

  /** Bounded seed for a continuation, derived from the model that will continue it. */
  private seedOptions(model: ModelRef | null): { maxBytes: number; maxMessages: number; includeImages: boolean } {
    const info = model ? findModel(this.modelRuntime, model.providerID, model.modelID) : undefined;
    const window = info && Number.isFinite(info.contextWindow) && info.contextWindow > 0 ? info.contextWindow : 32_000;
    const output = info && Number.isFinite(info.maxTokens) && info.maxTokens > 0 ? Math.min(info.maxTokens, window / 2) : window / 4;
    // A quarter of the remaining input window, ~4 bytes per token, within the importer's own bounds.
    const maxBytes = Math.max(16 * 1024, Math.min(1024 * 1024, Math.floor(((window - output) / 4) * 4)));
    return { maxBytes, maxMessages: 512, includeImages: !!info?.input?.includes("image") };
  }

  private continuing: Promise<unknown> = Promise.resolve();
  /**
   * Verified archive → writable continuation, serialized per runtime. An
   * existing `continuedBy` is returned unchanged; nothing historical is sent.
   * The directory is the archive's mapped LOCAL project directory, validated
   * on this host — a historical cwd is never passed to a shell or resolver.
   */
  continueArchive(record: SessionRecord, options: { model: ModelRef | null; signal?: AbortSignal }): Promise<SessionRecord> {
    const run = this.continuing.then(async () => {
      if (record.origin.kind !== "opencode") throw new Error("Продолжить можно только архивный чат OpenCode.");
      if (!validDirectory(record.directory)) throw new Error("Папка этого архива недоступна на этом компьютере. Продолжение не создано.");
      const release = this.admission.reserve("continuation");
      try {
        return await continueLegacy(this.db, this.catalog, record, this.archiveReader(record.origin.archive), this.sessionDir(record.directory),
          { directory: record.directory, ...this.seedOptions(options.model), ...(options.signal ? { signal: options.signal } : {}) });
      } finally { release(); }
    });
    this.continuing = run.catch(() => undefined);
    return run;
  }

  /** Cutover mapping: source chat → exactly one WRITABLE runtime chat on this host, or a visible reason. */
  private async cutoverTarget(ref: CutoverSessionRef, model: ModelRef, signal?: AbortSignal): Promise<CutoverTarget> {
    const fail = (code: string, reason: string, retryable: boolean): CutoverTarget => ({ ok: false, code, reason, retryable });
    let candidates: SessionRecord[];
    if (ref.engine === "runtime") candidates = [this.catalog.get(ref.id)].filter((r): r is SessionRecord => !!r);
    else candidates = this.catalog.all().filter((r) => r.origin.kind === ref.engine && "legacyId" in r.origin && r.origin.legacyId === ref.id
      && (!ref.sourceOrigin || r.origin.sourceOrigin === ref.sourceOrigin));
    candidates = candidates.filter((r) => r.directory === ref.directory);
    if (!candidates.length) return fail("source_not_imported", ref.engine === "runtime" ? "Чат не найден в этой среде выполнения."
      : "Исходный чат ещё не импортирован в Enki на этом компьютере. Импортируйте историю и повторите перенос.", true);
    if (candidates.length > 1) return fail("ambiguous_source", "Этому идентификатору соответствует несколько импортированных чатов. Перенос остановлен, чтобы не выбрать чужой чат.", false);
    let target = candidates[0];
    if (target.origin.kind === "opencode") {
      const continued = target.origin.continuedBy ? this.catalog.get(target.origin.continuedBy) : null;
      if (target.origin.continuedBy && !continued) return fail("continuation_removed", "Продолжение этого архива удалено; оно не восстанавливается автоматически. Создайте продолжение заново и повторите.", true);
      if (!validDirectory(target.directory)) return fail("directory_unavailable", "Папка архива недоступна на этом компьютере.", true);
      try { target = continued ?? await this.continueArchive(target, { model, ...(signal ? { signal } : {}) }); }
      catch (error) { return fail("continuation_failed", error instanceof Error ? error.message : String(error), true); }
    }
    if (isReadOnlyOrigin(target.origin)) return fail("read_only", "Целевой чат доступен только для чтения.", false);
    if (target.archived) return fail("archived", "Чат перенесён в архив Enki. Верните его из архива и повторите перенос.", true);
    return { ok: true, record: target };
  }

  private wire(): void {
    this.registry = new SessionRegistry(this.catalog, {
      catalog: this.catalog, journal: this.journal, ledger: this.ledger, interactions: this.interactions, tools: this.tools,
      modelRuntime: this.modelRuntime, agentDir: this.paths.agentDir, settings: () => this.sdkSettings(),
      sessionDir: (d, sessionID) => { const record = sessionID ? this.catalog.get(sessionID) : null; return record ? this.sessionDirOf(record) : this.sessionDir(d); },
      resources: (record) => this.resources(record),
      ui: {
        db: this.db, hostId: this.hostId,
        authorize: (principal, sessionID, directory) => this.authorizeUi(principal, sessionID, directory),
        admit: () => this.admission.open(),
        submit: async command => this.dispatcher.submit(command).receipt,
        native: {
          copySelection: (scope, value) => this.nativeUiCall<boolean>(scope, "ui.clipboard.write", { text: value }),
          openUrl: (scope, url) => this.nativeUiCall<void>(scope, "ui.open-url", { url }),
          requestPaste: scope => this.nativeUiCall<string>(scope, "ui.clipboard.read", {}),
          readGitBranch: async directory => (await this.git.info(directory))?.branch ?? undefined,
        },
      },
      onSettled: (sessionID, outcome) => {
        this.queue.onSettled(sessionID, outcome.state === "failed" ? outcome.error : null);
        this.publishActivity();
      },
      onUndelivered: (sessionID, directory, texts) => this.queue.restoreUndelivered(sessionID, directory, texts, this.catalog.get(sessionID)?.model ?? null),
      trashDir: path.join(this.paths.data, "trash"),
      retained: (id) => this.retained(id),
      legacyHistory: (record) => this.legacyHistory(record),
      legacyHistoryPage: (record, limit, before) => this.legacyHistoryPage(record, limit, before),
    });
    this.dispatcher = new Dispatcher(this.registry, this.catalog, this.ledger, this.hub, this.journal, () => !this.admission.open());
    this.dispatcher.onReleased = id => { this.queue.drain(id); this.publishActivity(); };
    this.dispatcher.onReceipt((receipt, request) => {
      if (request.kind === "prompt" || request.kind === "steer") {
        if (request.payload.source === "queue") this.queue.onReceipt(receipt);
        if (request.payload.source === "schedule" && request.payload.sourceId) this.scheduler.onReceipt(request.payload.sourceId, receipt);
      }
      this.publishActivity();
    });
    const hubRoute = (model: ModelRef) => !!this.hub.route(model.providerID, model.modelID);
    this.queue.bind({
      ready: (sessionID) => this.admission.open() && !this.dispatcher.inFlight(sessionID) && !this.interactions.hasPending(sessionID) && this.writable(sessionID),
      streaming: (sessionID) => this.admission.open() && !!this.registry.live(sessionID)?.streaming(),
      submit: (kind, item) => this.dispatcher.submit({ id: item.commandId, kind, sessionID: item.sessionID, directory: item.directory,
        payload: { parts: item.parts, model: item.model, source: "queue", sourceId: item.itemId, ...(hubRoute(item.model) ? { hubRoute: true } : {}) } }).receipt,
    });
    this.scheduler.bind({
      blocker: (sessionID) => !this.admission.open() ? "Enki Runtime обновляется" : this.dispatcher.inFlight(sessionID) ? "Ожидает завершения текущей работы агента"
        : this.interactions.hasPending(sessionID) ? "Ожидает вашего ответа в чате" : this.queue.hasWork(sessionID) ? "Ожидает очереди запросов" : null,
      invalid: (task) => this.scheduleProblem(task),
      submit: (task, commandId, prompt) => this.dispatcher.submit({ id: commandId, kind: "prompt", sessionID: task.sessionID, directory: task.directory,
        payload: { parts: [{ type: "text", text: prompt }], model: task.model, source: "schedule", sourceId: task.id, ...(hubRoute(task.model) ? { hubRoute: true } : {}) } }).receipt,
    });
  }

  /** The authenticated transport owns this registration, not model output. */
  attachUiAuthority(principal: string, sessionID: string, directory: string): () => void {
    if (!/^client:[a-f0-9]{64}$/.test(principal) || this.catalog.get(sessionID)?.directory !== directory)
      throw new Error("Не подтверждён клиент интерфейса или его рабочий каталог.");
    const key = JSON.stringify([principal, sessionID, directory]);
    this.uiAuthorities.set(key, (this.uiAuthorities.get(key) ?? 0) + 1);
    let released = false;
    return () => { if (released) return; released = true; const n = this.uiAuthorities.get(key) ?? 0; if (n <= 1) this.uiAuthorities.delete(key); else this.uiAuthorities.set(key, n - 1); };
  }
  authorizeUi(principal: string, sessionID: string, directory: string): boolean {
    return this.catalog.get(sessionID)?.directory === directory
      && (this.uiAuthorities.get(JSON.stringify([principal, sessionID, directory])) ?? 0) > 0;
  }
  private nativeUiCall<T>(scope: NativeUiScope, method: "ui.clipboard.write" | "ui.clipboard.read" | "ui.open-url", params: Record<string, unknown>): Promise<T> {
    if (!this.authorizeUi(scope.principal, scope.sessionId, scope.directory)) throw new Error("Клиент интерфейса отключён.");
    const actual = this.registry.live(scope.sessionId)?.ui().snapshot(scope.principal).nativeScope;
    if (!actual || ["hostId", "sessionId", "sessionEpoch", "surfaceId", "directory", "principal"].some(key => actual[key as keyof NativeUiScope] !== scope[key as keyof NativeUiScope]))
      throw new Error("Системное действие относится к другому владельцу или поколению интерфейса.");
    const release = this.admission.reserve("native-ui");
    return this.config.broker.call<unknown>(method, { ...params, scope }, undefined, 10_000).then(value => {
      if (method === "ui.clipboard.write" && typeof value !== "boolean") throw new Error("Некорректный ответ системного буфера обмена.");
      if (method === "ui.clipboard.read" && (typeof value !== "string" || value.length > 4 * 1024 * 1024)) throw new Error("Буфер обмена недоступен или превышает допустимый размер.");
      if (method === "ui.open-url" && value !== undefined && value !== null) throw new Error("Системное открытие ссылки не подтверждено.");
      return value as T;
    }).finally(release);
  }

  private writable(sessionID: string): boolean {
    const record = this.catalog.get(sessionID);
    return !!record && !isReadOnlyOrigin(record.origin) && !record.archived;
  }

  private scheduleProblem(task: ScheduleDTO): string | null {
    const record = this.catalog.get(task.sessionID);
    if (!record) return "Чат удалён или больше недоступен. Задание приостановлено.";
    if (record.directory !== task.directory || record.archived) return "Чат архивирован или перенесён в другую папку. Задание приостановлено.";
    if (record.origin.kind === "opencode") return "Это архив OpenCode только для чтения. Создайте таймер в продолжении чата.";
    if (isReadOnlyOrigin(record.origin)) return "Чат доступен только для чтения. Задание приостановлено.";
    const model = findModel(this.modelRuntime, task.model.providerID, task.model.modelID);
    // The saved effort is part of the intent: never run it with a silently
    // different one. A missing model must reach the worker's fresh exact Hub
    // alias authority; it is not admitted to inference here. The canonical
    // target's reasoning support is checked there before any lease/selection.
    const variant = task.model.variant;
    if (variant && (!isThinkingLevel(variant) || (model && variant !== "off" && !model.reasoning)))
      return `Режим «${variant}» больше недоступен для модели ${task.model.providerID}/${task.model.modelID}. Выберите режим и создайте задание заново.`;
    return null;
  }

  /** Startup reconciliation: nothing is replayed; uncertainty is shown. */
  private recover(): void {
    // Every app-owned import/continuation journal is settled before any worker
    // can open or append. Each importer touches only its own roots and rows;
    // catalog/map/continuedBy publication stays inside those importers.
    // A failed recovery is kept as a structured, visible migration failure: its
    // unfinished journal rows keep that importer fenced (no new import), while
    // committed chats stay usable. Nothing is deleted or resurrected to "fix" it.
    const recovering = (kind: string, work: () => void) => {
      try { work(); } catch (error) { this.recoveryIssues.push({ kind, message: error instanceof Error ? error.message : String(error) }); }
    };
    recovering("opencode", () => this.importer.recover());
    recovering("pi-cli", () => this.piCli.recover());
    for (const entry of fs.readdirSync(this.paths.sessions, { withFileTypes: true }))
      if (entry.isDirectory() && !entry.isSymbolicLink() && SESSION_LAYOUT.shard.test(entry.name))
        recovering("continuation", () => recoverLegacyContinuations(this.db, this.catalog, path.join(this.paths.sessions, entry.name)));
    // Then every transcript lives in the ONE shard of its real folder and every
    // durable row names that folder, before the queue or a timer reads them.
    recovering("session-shard", () => { const report = this.shards.migrate(); if (report.skipped.length) this.shardIssues.push(...report.skipped); });
    const { uncertain } = this.ledger.recoverAfterRestart();
    this.queue.recover((id) => this.ledger.get(id));
    this.scheduler.recover((id) => this.ledger.get(id));
    const affected = new Set([...uncertain.map((r) => r.sessionID), ...this.tools.interrupted().map((t) => t.sessionID)]);
    for (const sessionID of affected) {
      const record = this.catalog.get(sessionID);
      if (record) recoverInterruptedTools(record, this.sessionDirOf(record), { tools: this.tools, journal: this.journal });
    }
    this.journal.prune();
    this.tools.prune(Date.now() - 30 * 24 * 3600_000);
  }

  activity() {
    const registry = this.registry?.activity() ?? { opening: 0, closing: 0, busy: 0, ui: 0 };
    const queues = this.queue.sessions();
    const queued = queues.reduce((sum, q) => sum + q.items.length, 0);
    // A paused/uncertain saved item and a future timer are durable data, not an
    // executing task. Armed queue work and dispatching timer occurrences block
    // maintenance until deliberately paused/settled.
    const readyQueue = queues.filter(q => q.armed).reduce((n, q) => n + q.items.filter(i => i.state !== "uncertain").length, 0);
    const sending = queues.reduce((n, q) => n + q.items.filter(i => i.state === "sending").length, 0);
    const scheduled = this.scheduler.list({}).tasks.filter(t => t.state === "dispatching").length;
    const questions = this.interactions.pendingQuestions().length;
    const pending = this.interactions.pendingPermissions().length + this.interactions.pendingDialogs().length + questions;
    const mcp = this.pool.activity();
    const preparing = this.dispatcher?.preparingCount() ?? 0;
    const operations = this.admission.active();
    const hub = this.hub.activeCount();
    // An owned shell blocks maintenance until it is explicitly closed and its
    // exit observed; a quiet terminal may still be running a long command.
    const pty = this.pty.activity();
    const terminals = pty.running + pty.starting + pty.unconfirmed;
    const active = registry.opening + registry.closing + registry.busy + registry.ui + pending + preparing
      + operations + hub + mcp.connecting + mcp.calls + mcp.closing + sending + scheduled + this.updateCopies + terminals;
    return { running: registry.busy, queued, pending, questions, idle: active === 0 && readyQueue === 0,
      preparing, opening: registry.opening, closing: registry.closing, ui: registry.ui, operations,
      mcp, hub, sending, scheduled, readyQueue, pty, terminals, backups: this.updateCopies,
      // Quit drain waits for agent work only; shutdown() then terminates owned
      // shells. Update maintenance uses `idle`, where a live shell still blocks.
      quiescent: active - terminals === 0 };
  }

  /** Busy indicator for the supervisor (tray, update idle checks). */
  onActivity?: (activity: ReturnType<Runtime["activity"]>) => void;
  private publishActivity(): void { this.onActivity?.(this.activity()); }

  statuses(directory: string | null): Record<string, SessionStatusDTO> {
    return this.registry.statuses(directory);
  }

  /** Synchronous all-sources stop fence before awaiting host lifecycle work. */
  admitMutation(): () => void { return this.admission.reserve("http"); }
  private fenceMaintenance(held: boolean): void {
    this.admission.setMaintenance(held);
    const allowed = this.admission.open();
    this.registry?.setAdmission(allowed); this.pool.setAdmission(allowed);
    this.scheduler.setAdmission(allowed); this.hub.setAdmission(allowed);
    this.pty.setAdmission(allowed);
    this.publishActivity();
  }
  beginMaintenance(): Promise<void> {
    return this.maintenance.begin(); // synchronous fence precedes its first await
  }
  async backupForUpdate(id: string): Promise<UpdateBackup> {
    if (!this.maintenance.isHeld() || this.draining || !this.activity().idle)
      throw new Error("Резервная копия требует удержанного режима обслуживания и подтверждённого простоя.");
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new Error("Некорректный идентификатор копии обновления.");
    const backups = path.join(this.paths.data, "update-backups");
    fs.mkdirSync(backups, { mode: 0o700, recursive: true });
    if (fs.lstatSync(backups).isSymbolicLink() || fs.realpathSync(backups) !== backups) throw new Error("Каталог резервных копий содержит ссылку.");
    const directory = path.join(backups, id);
    // A partial pre-existing copy is never overwritten or presented as success.
    fs.mkdirSync(directory, { mode: 0o700 });
    const target = path.join(directory, "state.sqlite");
    this.updateCopies++;
    try {
    await sqliteBackup(this.db.db, target);
    if (!this.maintenance.isHeld() || this.draining) throw new Error("Обслуживание прервано до завершения резервной копии.");
    fs.chmodSync(target, 0o600);
    const fd = openOwnedFileForSync(target);
    let sha256: string, bytes: number;
    try {
      fs.fsyncSync(fd); const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024); bytes = 0;
      for (;;) { const read = fs.readSync(fd, buffer); if (!read) break; hash.update(buffer.subarray(0, read)); bytes += read; }
      sha256 = hash.digest("hex");
    }
    finally { fs.closeSync(fd); }
    // Same held fence and confirmed idle: SDK sessions append synchronously, so
    // no turn can extend a JSONL file while it is copied. Paired with the DB.
    const sessions = snapshotSessions(this.paths.data, id);
    if (!this.maintenance.isHeld() || this.draining) throw new Error("Обслуживание прервано до завершения резервной копии.");
    const receipt: UpdateBackup = { id, relativePath: `update-backups/${id}/state.sqlite`, sha256, bytes,
      schema: SCHEMA_VERSION, runtimeVersion: this.config.version, sdk: SDK_VERSION, createdAt: Date.now(), sessions };
    const receiptFile = fs.openSync(path.join(directory, "receipt.json"), "wx", 0o600);
    try { fs.writeFileSync(receiptFile, JSON.stringify(receipt)); fs.fsyncSync(receiptFile); } finally { fs.closeSync(receiptFile); }
    for (const dir of [directory, backups]) syncDirectory(dir);
    return receipt;
    } finally { this.updateCopies--; }
  }
  endMaintenance(): void {
    if (this.updateCopies) throw new Error("Резервная копия ещё создаётся; дождитесь подтверждения обслуживания.");
    this.maintenance.end();
    if (this.admission.open()) {
      for (const queue of this.queue.sessions()) this.queue.drain(queue.sessionID);
      this.scheduler.tick();
    }
  }
  stopAdmission(): void {
    this.draining = true; this.admission.stop();
    this.modelAccess?.cancel();
    this.registry?.setAdmission(false); this.pool.setAdmission(false);
    this.scheduler.setAdmission(false); this.hub.setAdmission(false);
    this.pty.setAdmission(false);
  }

  /** Stop accepting turns; wait (bounded) for running turns to settle. */
  async drain(deadlineMs: number): Promise<{ interrupted: { sessionID: string; directory: string }[] }> {
    this.stopAdmission();
    this.journal.append(null, null, { type: "runtime.draining", properties: { deadline: Date.now() + deadlineMs } });
    const until = Date.now() + deadlineMs;
    while (!this.activity().quiescent && Date.now() < until) await new Promise((r) => setTimeout(r, Math.min(100, Math.max(0, until - Date.now()))));
    const interrupted = [...new Set([...Object.keys(this.registry?.statuses(null) ?? {}), ...(this.dispatcher?.preparingSessions() ?? [])])].map((sessionID) => ({
      sessionID, directory: this.catalog.get(sessionID)?.directory ?? "",
    }));
    return { interrupted };
  }

  shutdown(): Promise<void> { return this.shuttingDown ??= this.close(); }
  private async close(): Promise<void> {
    this.stopAdmission();
    const errors: unknown[] = [];
    const attempt = async (work: () => void | Promise<void>) => { try { await work(); } catch (error) { errors.push(error); } };
    await attempt(() => this.modelAccess?.close());
    await attempt(() => this.scheduler.stop());
    await attempt(() => this.hub.stop());
    await attempt(() => this.interactions.cancelAll());
    await attempt(() => this.pty.shutdown());
    if (this.dispatcher) await attempt(() => this.dispatcher.abortAll());
    if (this.registry) await attempt(() => this.registry.shutdown());
    if (this.dispatcher) await attempt(() => this.dispatcher.settled());
    await attempt(() => shutdownPluginUi());
    await attempt(() => this.pool.closeAll());
    for (const reader of this.archiveReaders.values()) await attempt(() => reader.close());
    // Do not close SQLite under a still-running preparation/broker callback.
    // The lifecycle reports a bounded failure; its supervisor owns termination.
    if (this.dispatcher?.preparingCount() || this.hub.activeCount() || this.admission.active() || this.updateCopies)
      errors.push(new Error("Подготовка или системная операция ещё не завершена; хранилище не закрыто."));
    let closed = false;
    if (!errors.length) await attempt(() => { this.db.close(); closed = true; });
    // A failed close cannot hand writer ownership to another live process.
    if (closed) await attempt(() => this.releaseLock());
    if (errors.length) throw new AggregateError(errors, 'Enki Runtime shutdown was incomplete');
  }

  home(): string { return os.homedir(); }

  /** Projectless chat folder owned by the runtime on this host. */
  prepareChatWorkspace(id: string): { directory: string; root: string } {
    if (!/^[A-Za-z0-9-]{12,80}$/.test(id)) throw new Error("Некорректный идентификатор рабочего каталога.");
    const dir = path.join(this.paths.chats, id);
    fs.mkdirSync(this.paths.chats, { recursive: true, mode: 0o700 });
    // A retried request (lost response) gets the same folder; a link or file
    // under that name is never adopted.
    try { fs.mkdirSync(dir, { recursive: false, mode: 0o700 }); }
    catch (error) {
      const stat = (error as NodeJS.ErrnoException).code === "EEXIST" ? fs.lstatSync(dir) : null;
      if (!stat?.isDirectory() || stat.isSymbolicLink()) throw error;
    }
    const real = fs.realpathSync(dir);
    return { directory: real, root: path.dirname(real) };
  }

  /** Text parts helper for API-originated prompts. */
  static textPart(value: string): PromptPart { return { type: "text", text: value }; }
}
