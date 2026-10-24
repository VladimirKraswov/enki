import {inputBudget, transferSource, waitForSummary} from './contextTransfer';
import {McpNotices} from '../capabilities/notices';
import {applyGlobalPlugins} from '../api/configReload';
import {refreshGlobalPolicy} from '../capabilities/globalPolicy';
import { agentParts, steeringParts, scheduleWakeReminder } from "../agent/promptPolicy";
import { prepareWorkshop, resolveWorkshop, isWorkshopSession, type WorkshopRecord } from "../workshop/workspace";
import { ownWork } from "../operations/ownership";
import { StreamNotifications, selectedSnapshot, shallowEqual } from "./notifications";
import { DEFAULT_BASE_URL } from "../api/client";
import { NotDispatched, operationJournal, type Operation } from "../operations/journal";
import { PromptQueueController, isQueuePausingError } from "./promptQueue";
import { errText } from "./errors";
import { describeMessageError } from "../chat/errors";
import { SubmissionLifecycle, type Submission } from "./submission";
import { projectErrorText } from "../api/projectError";
import type { MessagePart } from '../api/types';
import { initialState } from './initial';
import type { AppState, UiState } from './types';
export type { AppState, UiState, ConnectionState, ConnectionPhase } from './types';
import { chooseOpenCodeModel, choosePiModel, parseModelId, piModelInfo, type ModelChoice } from './modelChoice';
import {configureShared,capabilityNative,invalidateCapabilities} from "../capabilities/integration";
import { modelServices, type ModelService } from "../models/services";
import type { HubModelServices } from "../models/hub";
import { ScheduleBlocked, type ScheduledTask, type DispatchResult } from "../schedules/tasks";
import { chatBlocker, liveModelProblem, modelProblem } from "../schedules/preflight";
import { untilAborted } from "../util/abort";
import { configureLocalBrowser, invalidateBrowserSetup, browserSetupSnapshot, openSessionBrowser } from "../browser/integration";
import { browserTaskKey, browserEfforts, browserDefaultEffort } from "../browser/task";
import { browserEnabled, browserNodeProgram } from "../browser/preferences";
import { isLocalComputer } from "./computer";
import { isNative } from "../native/platform";
import { attachmentParts, stageArchive, type ArchiveStager } from '../attachments/archive';
import { applyAppearance, normalizeAppearance, type Appearance } from "./appearance";
import {
  connectSsh,
  prepareChat,
  remoteKey,
  hostHeaders,
  validRemote,
  type RemoteHost,
} from "../native/hosts";
import { contextUsage } from "./context";
import { accessRules, accessMode, type AccessMode } from "./access";
import { newMessageId, type QueuedPrompt } from "./queue";
import type { AsrSettings } from "../voice/asr";
import { attachmentDrafts, attachmentScope, type DraftAttachment } from "../attachments/drafts";
import { prepareAttachments } from "../attachments/prepare";
import { stageImagePromptContext, imagePromptParts } from '../images/context';
import { pathIsWithin } from "../util/paths";
import { DEFAULT_HELPER_ENDPOINT } from "../attachments/helper";
// Central application store: connection lifecycle, project/session selection,
// chat state driven by the pure stream reducer, and command actions.
// Designed to be testable: Tauri is only touched through theme/window niceties.

import { useMemo, useSyncExternalStore } from "react";
import { ApiError, ConnectionError, type OpenCodeClient } from "../api/client";
import type { AgentBackend } from "../agent/backend";
import { asOpenCodeClient } from "../agent/opencode";
import {
  createBackend,
  DEFAULT_BACKEND_ID,
  findBackendDescriptor,
  registerBackendDescriptor,
} from "../agent/registry";
import {
  PiBackend,
  piDescriptor,
  PI_BACKEND_ID,
} from "../agent/pi/backend";
import { piBridge } from "../agent/pi/native";
import { buildHandoffTranscript } from "./handoffTranscript";
import {
  DEFAULT_ENGINE,
  engineForDirectory,
  engineForSession,
  modelScope,
  piAvailability,
  type EngineId,
} from "./engines";
import { completionChime } from "../native/sound";
import { startLocalServerIfNative } from "../native/localServer";
import { emptySidebarList, emptyRecentList, mergeSidebarSessions } from "./sidebar";
import type {
  ModelInfo,
  PermissionRequest,
  ProviderInfo,
  QuestionRequest,
  ServerEvent,
  Session,
  SessionStatus,
} from "../api/types";
import {
  applyHistory,
  emptyChatRoot,
  emptySessionChat,
  pendingForSession,
  prependHistory,
  reduceEvent,
  reconcileHistoryEvents,
  type ChatRootState,
} from "./chatReducer";
import {
  DEFAULT_PREFS,
  flushPrefs,
  draftKey,
  loadPrefs,
  savePrefs,
  switchEndpointPrefs,
  type Prefs,
} from "./prefs";

class Store {
  state: AppState = initialState(typeof localStorage !== "undefined" ? loadPrefs() : { ...DEFAULT_PREFS });
  /**
   * The OpenCode workspace backend. Pi conversations use a lazily created
   * backend through the same neutral `AgentBackend` contract.
   */
  backend: AgentBackend = createBackend(
    DEFAULT_BACKEND_ID,
    this.state.prefs.endpoint,
  );

  /**
   * OpenCode-only transport for the surfaces outside the neutral contract: the PTY
   * terminal, the `/mcp` inventory and the JSONC config editor. Callers that can be
   * reached with another backend must gate on `backend.capabilities` first.
   */
  get client(): OpenCodeClient {
    const client = asOpenCodeClient(this.backend);
    if (!client)
      throw new Error(
        "Эта возможность доступна только при подключении к OpenCode.",
      );
    return client;
  }

  /**
   * Second engine. Created lazily so a user who never selects Pi never pays for
   * detection, and so the browser preview stays functional without a native host.
   */
  private piEngine: PiBackend | null = null;
  piInstalled = false;

  // ---------- engines ----------
  //
  // `backend` above is the *workspace* backend: connection, projects, folders and
  // the sidebar always come from OpenCode. A conversation, however, runs on the
  // engine chosen for its chat, which may be Pi.

  /** The Pi engine, created on first use and wired to this store. */
  pi(): PiBackend {
    if (!this.piEngine) {
      this.piEngine = new PiBackend({
        choice: (directory) => {
          const settings = this.state.prefs.pi ?? {};
          const model = this.getModelChoice(PI_BACKEND_ID, directory);
          return {
            program: settings.program,
            nodeProgram: settings.nodeProgram,
            browserEnabled: browserEnabled(this.state.prefs),
            provider: model?.providerID ?? settings.provider,
            model: model ? `${model.providerID}/${model.modelID}` : settings.model,
            thinking: model?.variant ?? settings.thinking,
            extensions: settings.lspEnabled === false ? [] : settings.extensions,
            // Absent means "ask": a missing preference must never read as
            // blanket approval for Pi's file and shell tools.
            toolPolicy: settings.toolPolicy === "full" ? "full" : "ask",
          };
        },
        meta: {
          all: () => this.state.prefs.piSessions ?? {},
          save: (meta) => {
            this.mutate((x) => ({
              prefs: {
                ...x.prefs,
                piSessions: { ...x.prefs.piSessions, [meta.id]: meta },
              },
            }));
            this.persistPrefs();
          },
          remove: (id) => {
            this.mutate((x) => {
              const piSessions = { ...x.prefs.piSessions };
              delete piSessions[id];
              return { prefs: { ...x.prefs, piSessions } };
            });
            this.persistPrefs();
          },
        },
        onActivity: (directory, sessionId, status) => {
          if (isLocalComputer(this.state.prefs.endpoint, !!this.currentHost()) && directory !== this.state.directory)
            this.observeSessionStatus(sessionId, status, directory);
        },
        onQueueCleared: (directory, sessionId, messages) => {
          if (!messages.length) return;
          const key = draftKey(sessionId, directory);
          this.mutate(s => {
            const workspace = s.prefs.localEndpoint ?? DEFAULT_BASE_URL;
            const current = (s.prefs.workspaceKey ?? s.prefs.endpoint) === workspace;
            const target = current ? s.prefs : s.prefs.endpointState?.[workspace] ?? {};
            const drafts = { ...target.drafts, [key]: [target.drafts?.[key], ...messages].filter(Boolean).join("\n\n") };
            return { prefs: current ? { ...s.prefs, drafts } : { ...s.prefs, endpointState: {
              ...s.prefs.endpointState, [workspace]: { ...target, drafts },
            } } };
          });
          savePrefs(this.state.prefs);
          if (!flushPrefs()) throw Error("Не удалось сохранить остановленные уточнения.");
        },
        onNotice: (_directory, _session, notice) =>
          this.patchUi({ toast: notice.text }),
        onDialog: (request) => {
          if (!this.piDialogs.some(d => d.key === request.key && d.request.id === request.request.id)) this.piDialogs.push(request);
          this.patchUi({ piDialog: this.piDialogs[0] ?? null });
        },
        onDialogExpired: (key, id) => {
          this.piDialogs = this.piDialogs.filter(d => d.key !== key || d.request.id !== id);
          this.patchUi({ piDialog: this.piDialogs[0] ?? null, toast: "Запрос Pi истёк. Действие не выполнено." });
        },
        onHistoryStale: (directory, sessionId) => {
          // Streaming used provisional ids; re-read Pi's durable transcript.
          if (this.state.activeSessionId === sessionId && this.state.directory === directory)
            void this.loadHistory(sessionId, directory);
        },
      });
    }
    return this.piEngine;
  }

  /** Engine id for a chat, honouring the per-chat override then the folder. */
  engineIdFor(
    sessionId: string | null = this.state.activeSessionId,
    directory: string | null = this.state.directory,
  ): EngineId {
    return engineForSession(this.state.prefs, sessionId, directory);
  }

  engineIdForDirectory(directory: string | null): EngineId {
    return engineForDirectory(this.state.prefs, directory);
  }

  /** Backend for an engine id. Unknown ids fall back to the workspace backend. */
  engine(id: EngineId = this.engineIdFor()): AgentBackend {
    return id === PI_BACKEND_ID ? this.pi() : this.backend;
  }

  /** Engine driving the chat that is open right now. */
  conversation(): AgentBackend {
    return this.engine(this.engineIdFor());
  }

  /** A Pi chat is identified by app-owned metadata, not by the OpenCode server. */
  isPiSession(sessionId: string): boolean {
    return Boolean(this.state.prefs.piSessions?.[sessionId]) || this.state.prefs.sessionEngine?.[sessionId] === PI_BACKEND_ID;
  }

  setProjectEngine(directory: string, engine: EngineId): void {
    if (!this.state.activeSessionId && directory === this.state.directory && this.engineIdFor() !== engine)
      this.invalidateSelection();
    this.mutate((x) => ({
      prefs: {
        ...x.prefs,
        projectEngine: { ...x.prefs.projectEngine, [directory]: engine },
      },
    }));
    this.persistPrefs();
  }

  /**
   * Choose the engine for the chat being composed. An existing chat keeps the
   * engine that produced its transcript: switching would silently hand another
   * agent a conversation it never had.
   */
  setSessionEngine(sessionId: string | null, engine: EngineId): void {
    if (sessionId) {
      const current = this.engineIdFor(sessionId, this.state.directory);
      if (current !== engine) {
        // A finished transcript cannot move between engines: they do not share
        // a format or a store. Offer the handoff rather than dead-ending.
        const session =
          this.state.sessions.find((x) => x.id === sessionId) ??
          this.state.archivedSessions.find((x) => x.id === sessionId) ??
          null;
        if (!session) {
          this.patchUi({ toast: "Чат недоступен для переноса." });
          return;
        }
        this.patchUi({ engineSwitch: { session, from: current, to: engine } });
        return;
      }
      this.mutate((x) => ({
        prefs: {
          ...x.prefs,
          sessionEngine: { ...x.prefs.sessionEngine, [sessionId]: engine },
        },
      }));
    } else if (this.state.directory) {
      this.setProjectEngine(this.state.directory, engine);
      return;
    } else {
      if (this.engineIdFor() !== engine) this.invalidateSelection();
      this.mutate((x) => ({ prefs: { ...x.prefs, newChatEngine: engine } }));
    }
    this.persistPrefs();
  }

  /**
   * Whether an engine can accept work right now. Pi is a local process and does
   * not depend on the OpenCode server being reachable — gating it behind
   * another engine's health would be plainly wrong.
   */
  engineReady(id: EngineId = this.engineIdFor()): boolean {
    return id === PI_BACKEND_ID
      ? this.piInstalled && piAvailability(this.state.prefs).available
      : this.state.connection.phase === "connected";
  }

  /** Engine for a brand-new chat in the current folder. */
  newChatEngine(): EngineId {
    return this.state.directory
      ? this.engineIdForDirectory(this.state.directory)
      : (this.state.prefs.newChatEngine ?? DEFAULT_ENGINE);
  }

  /**
   * A request is still valid when the engine it used is the one still in charge.
   * The Pi engine instance is stable for the process; OpenCode's is replaced on
   * every reconnect, which is exactly the staleness this guards.
   */
  private engineStillActive(backend: AgentBackend): boolean {
    return backend === this.backend || backend === this.piEngine;
  }

  /** Pi chats for a folder; empty when Pi is not installed or not selected. */
  private async piListFor(directory: string): Promise<Session[]> {
    if (!piAvailability(this.state.prefs).available) return [];
    const anyPiHere =
      this.engineIdForDirectory(directory) === PI_BACKEND_ID ||
      Object.values(this.state.prefs.piSessions ?? {}).some(
        (m) => m.directory === directory,
      );
    if (!anyPiHere) return [];
    try {
      return await this.pi().listSessions(directory);
    } catch {
      // Pi being unavailable must never break the OpenCode session list.
      return [];
    }
  }

  /**
   * Continue an existing chat on the other engine, honestly.
   *
   * The source conversation is never moved or rewritten: a new chat is created
   * on the target engine, seeded with a labelled transcript, and its metadata
   * records where it came from so the UI can show the provenance. Nothing is
   * sent until the user presses Send — the transcript lands in the draft.
   */
  async continueOnEngine(session: Session, engine: EngineId): Promise<boolean> {
    const directory = session.directory;
    const from = this.engineIdFor(session.id, directory);
    if (from === engine) return false;
    if (engine === PI_BACKEND_ID && !this.engineReady(PI_BACKEND_ID)) {
      this.patchUi({ toast: "Pi недоступен: проверьте «Настройки → Движок Pi»." });
      return false;
    }
    if (engine !== PI_BACKEND_ID && this.state.connection.phase !== "connected") {
      this.patchUi({ toast: "OpenCode недоступен: подключитесь и повторите." });
      return false;
    }
    if (!this.state.chat.sessions[session.id]) {
      await this.loadHistory(session.id, directory);
      if (this.state.ui.historyError) {
        this.patchUi({ toast: "Не удалось прочитать историю для переноса." });
        return false;
      }
    }
    const label = (id: EngineId) => (id === PI_BACKEND_ID ? "Pi" : "OpenCode");
    const transcript = buildHandoffTranscript(this.state.chat, session.id, {
      sourceLabel: label(from),
      sourceTitle: session.title,
    });
    if (!transcript.included) {
      this.patchUi({ toast: "В этом чате нечего переносить." });
      return false;
    }
    try {
      // The target engine creates its own chat; the source is never moved,
      // rewritten or archived.
      const created = await this.engine(engine).createSession({
        directory,
        title: `${session.title} · ${label(engine)}`,
        permission: accessRules(this.state.prefs.newAccess ?? "inherit"),
        ...(engine === PI_BACKEND_ID
          ? {}
          : {
              agent: this.getAgentChoice() ?? undefined,
            }),
      });
      this.mutate((x) => ({
        prefs: {
          ...x.prefs,
          sessionEngine: { ...x.prefs.sessionEngine, [created.id]: engine },
          // Provenance is engine-neutral, so the banner works both ways.
          handoffOrigins: {
            ...x.prefs.handoffOrigins,
            [created.id]: {
              from: session.id,
              fromEngine: from,
              title: session.title,
              directory,
              omitted: transcript.omitted,
            },
          },
          ...(engine === PI_BACKEND_ID
            ? {
                piSessions: {
                  ...x.prefs.piSessions,
                  [created.id]: {
                    ...(x.prefs.piSessions?.[created.id] ?? {
                      id: created.id,
                      directory,
                      title: created.title,
                      created: Date.now(),
                      updated: Date.now(),
                    }),
                    handoffFrom: session.id,
                  },
                },
              }
            : {}),
          // The transcript lands in the draft: the user reviews and edits it,
          // and nothing is sent until they press Send.
          drafts: { ...x.prefs.drafts, [created.id]: transcript.text },
        },
        sessions: [created, ...x.sessions.filter((y) => y.id !== created.id)],
      }));
      this.persistPrefs();
      this.rememberActivitySession(created);
      this.updateSidebarSession(created);
      await this.selectSession(created.id);
      this.patchUi({
        engineSwitch: null,
        toast: transcript.omitted
          ? `Контекст перенесён в новый чат ${label(engine)}; ранние ${transcript.omitted} реплик(и) опущены. Проверьте черновик и отправьте.`
          : `Контекст перенесён в новый чат ${label(engine)}. Проверьте черновик и отправьте.`,
      });
      return true;
    } catch (e) {
      this.patchUi({ toast: `Не удалось создать чат ${label(engine)}: ${errText(e)}` });
      return false;
    }
  }

  /** Where this chat's context came from, for either engine. */
  handoffOrigin(sessionId: string | null): {
    id: string;
    title: string;
    engine: EngineId;
    directory: string;
    omitted: number;
    session: Session | null;
  } | null {
    if (!sessionId) return null;
    const record = this.state.prefs.handoffOrigins?.[sessionId];
    const legacy = this.state.prefs.piSessions?.[sessionId]?.handoffFrom;
    const from = record?.from ?? legacy;
    if (!from) return null;
    const session =
      this.state.sessions.find((x) => x.id === from) ??
      this.state.archivedSessions.find((x) => x.id === from) ??
      null;
    return {
      id: from,
      title: record?.title ?? session?.title ?? from,
      engine: record?.fromEngine ?? DEFAULT_ENGINE,
      directory: record?.directory ?? session?.directory ?? "",
      omitted: record?.omitted ?? 0,
      session,
    };
  }

  /**
   * Materialize the app's own Pi LSP extension and its server list, then record
   * the extension path so new Pi sessions load it. The user's own `~/.pi`
   * configuration is never touched.
   */
  async setupPiLsp(): Promise<{ servers: string[]; missing: string[] }> {
    const setup = await piBridge().setupLsp(this.state.prefs.pi?.lspServerPaths ?? []);
    this.setPiSettings({
      extensions: [setup.extensionPath],
      lspEnabled: true,
    });
    return {
      servers: setup.servers.map((s) => `${s.id} · ${s.command}`),
      missing: setup.missing,
    };
  }

  /**
   * Background browser setup for the local engines. `force` restarts setup;
   * `keepAttachments` is for engine-path/Pi changes that cannot affect an
   * already confirmed OpenCode MCP connection, which must not be restarted
   * under a running browser call. `backgroundDirectory` attaches a directory other
   * than the open one; `null` prepares the runtime only (Pi loads it itself).
   */
  configureBrowser(force = false, keepAttachments = false, backgroundDirectory?: string | null): Promise<unknown> {
    if (force) invalidateBrowserSetup({ keepAttachments });
    const endpoint = this.state.prefs.endpoint;
    const client = this.client, generation = this.connectionGeneration;
    const enabled = this.state.prefs.browser?.enabled;
    const node = this.state.prefs.browser?.nodeProgram;
    const background = backgroundDirectory !== undefined;
    return configureLocalBrowser({
      endpoint, directory: background ? backgroundDirectory : this.state.directory, remote: !!this.currentHost(),
      preferences: this.state.prefs.browser,
      openCodeProgram: this.state.prefs.localOpenCodeProgram,
      piProgram: this.state.prefs.pi?.program, piNodeProgram: this.state.prefs.pi?.nodeProgram,
      current: () => generation === this.connectionGeneration && !this.currentHost() && this.state.prefs.endpoint === endpoint
        && this.state.prefs.browser?.enabled === enabled && this.state.prefs.browser?.nodeProgram === node,
      activeDirectory: background ? undefined : () => this.state.directory,
      request: (method, path, options) => client.request(method, path, options),
    });
  }

  private mcpNotices=new McpNotices();
  async configureSharedTools(directory = this.state.directory, signal?:AbortSignal): Promise<void> {
    if (!directory || !isNative() || !isLocalComputer(this.state.prefs.endpoint, !!this.currentHost())) return;
    const endpoint=this.state.prefs.endpoint, client=this.client, generation=this.connectionGeneration;
    const current=()=>!signal?.aborted&&generation===this.connectionGeneration&&this.state.prefs.endpoint===endpoint&&!this.currentHost();
    const report = await configureShared({endpoint,directory,current,
      request:(method,path,options)=>client.request(method,path,options),
      refreshGlobal:paths=>refreshGlobalPolicy({endpoint,directory,paths,current,
        request:(method,path,options)=>client.request(method,path,options),invoke:capabilityNative,
        apply:plugins=>applyGlobalPlugins(client,plugins,current)}),
    });
    if(report.reloaded){invalidateBrowserSetup();if(browserEnabled(this.state.prefs))await this.configureBrowser(false,false,directory);}
    if (current()) {
      const toast=this.mcpNotices.update(JSON.stringify([endpoint,directory]),report.unavailable,this.state.ui.toast);
      if(toast!==undefined)this.patchUi({toast});
    }
  }
  browserTaskActive(): boolean {
    const id = this.state.activeSessionId;
    return !!id && !!this.state.prefs.browserTasks?.[browserTaskKey(this.state.prefs.workspaceKey ?? this.state.prefs.endpoint, this.engineIdFor(), id)];
  }
  effortOptions(): string[] {
    const choice = this.getModelChoice(); if (!choice) return [];
    const engine = this.engineIdFor();
    const info = engine === PI_BACKEND_ID ? piModelInfo(this.state.piHealth, choice) : this.modelInfo(choice.providerID, choice.modelID);
    const reasoning = engine === PI_BACKEND_ID
      ? !!this.state.piHealth?.models.find(m => m.provider === choice.providerID && m.id === choice.modelID)?.reasoning
      : !!info?.capabilities?.reasoning;
    return browserEfforts(engine, info?.variants ?? undefined, reasoning, engine === PI_BACKEND_ID
      ? this.state.piHealth?.models.find(m => m.provider === choice.providerID && m.id === choice.modelID)?.thinkingLevelMap : undefined);
  }
  setBrowserTask(enabled: boolean): void {
    const id = this.state.activeSessionId, choice = this.getModelChoice();
    if (!id || !choice || this.state.ui.sending || ['busy', 'retry'].includes(this.activityStatus(id)?.type ?? '')) return;
    const key = browserTaskKey(this.state.prefs.workspaceKey ?? this.state.prefs.endpoint, this.engineIdFor(), id);
    const previous = this.state.prefs.browserTasks?.[key];
    if (!!previous === enabled) return;
    const effort = browserDefaultEffort(this.effortOptions(), this.state.prefs.browser?.taskEffort ?? 'low');
    this.mutate(s => { const profiles = { ...s.prefs.browserTasks };
      if (enabled) profiles[key] = { providerID: choice.providerID, modelID: choice.modelID, previousVariant: choice.variant, appliedVariant: effort };
      else delete profiles[key]; return { prefs: { ...s.prefs, browserTasks: profiles } }; });
    if (enabled && effort) this.setModelChoice(choice.providerID, choice.modelID, effort, true);
    else if (!enabled && previous && previous.providerID === choice.providerID && previous.modelID === choice.modelID
      && previous.appliedVariant && choice.variant === previous.appliedVariant) this.setModelChoice(choice.providerID, choice.modelID, previous.previousVariant, true);
    this.persistPrefs();
  }
  async newBrowserTask(): Promise<void> {
    if (this.state.ui.sending || this.state.ui.workspacePreparing || !browserEnabled(this.state.prefs) || !isLocalComputer(this.state.prefs.endpoint, !!this.currentHost())) return;
    const expected = this.directoryGeneration + 1;
    await this.newSession();
    if (this.directoryGeneration !== expected || this.state.directory !== null) return;
    if (!await this.ensureChatWorkspace()) return;
    const created = await this.createSessionNow('Браузерная задача');
    if (created && this.state.activeSessionId === created.id) {
      const browserGeneration = this.directoryGeneration;
      this.setBrowserTask(true); this.setUi({ settingsOpen: false });
      await this.configureBrowser(browserSetupSnapshot().phase === 'error');
      if (this.state.activeSessionId !== created.id || browserSetupSnapshot().phase === 'error' || !browserEnabled(this.state.prefs)) return;
      try {
        await openSessionBrowser({directory:this.state.directory,engine:this.engineIdFor(),sessionId:created.id},
          () => this.state.activeSessionId === created.id && this.directoryGeneration === browserGeneration,null,browserNodeProgram(this.state.prefs));
        if (this.state.activeSessionId === created.id) this.setUi({ browserOpen: true });
      } catch (error) { if (this.state.activeSessionId === created.id) this.patchUi({ toast: `Браузер: ${errText(error)}` }); }
    }
  }
  setBrowserSettings(patch: Partial<NonNullable<Prefs["browser"]>>): void {
    this.mutate(x => ({ prefs: { ...x.prefs, browser: { ...x.prefs.browser, ...patch } } }));
    this.persistPrefs();
    // Mode is applied by the browser UI to the live daemon. Never restart a
    // connected MCP during an agent task just to persist this preference.
    if (patch.enabled !== undefined || Object.prototype.hasOwnProperty.call(patch, "nodeProgram")) void this.configureBrowser(true);
    else if (patch.mode !== undefined) invalidateBrowserSetup({ keepAttachments: true });
  }

  setPiSettings(patch: Partial<NonNullable<Prefs["pi"]>>): void {
    this.mutate((x) => ({ prefs: { ...x.prefs, pi: { ...x.prefs.pi, ...patch } } }));
    this.persistPrefs();
    void this.configureBrowser(true, true);
  }

  setLocalOpenCodeProgram(program?: string): void {
    this.mutate((x) => ({ prefs: { ...x.prefs, localOpenCodeProgram: program } }));
    this.persistPrefs();
    void this.configureBrowser(true, true);
  }

  /**
   * Ask the installed Pi what it can actually do. This starts a short-lived Pi
   * process, so it is only ever triggered by an explicit user action or by
   * opening the Pi settings section — never on a timer.
   */
  async refreshPiHealth(): Promise<void> {
    // Global metadata never depends on project access or project extensions.
    const directory = await piBridge().probeDirectory().catch(() => "");
    const health = await this.pi().describe(directory);
    this.piInstalled = health.install.installed;
    this.mutate({ piHealth: health });
    // Pi may have just been installed: rerun setup, keep OpenCode attachments.
    void this.configureBrowser(true, true);
  }

  async refreshPiInstall(): Promise<void> {
    try {
      const install = await piBridge().detect(this.state.prefs.pi?.program, this.state.prefs.pi?.nodeProgram);
      if (this.piInstalled !== install.installed) {
        this.piInstalled = install.installed;
        this.mutate({});
      }
      // A restored Pi chat or projectless Pi composer needs its model catalog
      // immediately. A version-only probe leaves the picker empty until the
      // user happens to visit Settings. This is a no-session metadata read,
      // not a model request or an inference job.
      if (install.installed) await this.refreshPiHealth();
    } catch {
      this.piInstalled = false;
      this.mutate({});
    }
  }

  private piDialogs: import("../agent/pi/backend").PiDialogRequest[] = [];
  private piAnswering = new Set<string>();
  async restorePiRuntime(): Promise<void> {
    if (!isLocalComputer(this.state.prefs.endpoint, !!this.currentHost())) return;
    await this.pi().restoreRunning();
  }
  async refreshPiActivity(): Promise<void> { await this.piEngine?.refreshRunning(); }
  restartInterface(): void {
    savePrefs(this.state.prefs);
    if (!flushPrefs()) { this.patchUi({toast: "Не удалось сохранить состояние. Перезапуск отменён."}); return; }
    window.location.reload();
  }
  async answerPiDialog(
    answer: { value?: string; confirmed?: boolean; cancelled?: boolean },
    expected?: { key: string; id: string },
  ): Promise<void> {
    const dialog = this.state.ui.piDialog;
    if (!dialog || (expected && (dialog.key !== expected.key || dialog.request.id !== expected.id))) return;
    const token = `${dialog.key}:${dialog.request.id}`;
    if (this.piAnswering.has(token)) return;
    this.piAnswering.add(token);
    try {
      await this.pi().answerDialog(dialog.key, dialog.request.id, answer);
      this.piDialogs = this.piDialogs.filter(d => d.key !== dialog.key || d.request.id !== dialog.request.id);
      if (this.state.ui.piDialog?.request.id === dialog.request.id && this.state.ui.piDialog?.key === dialog.key)
        this.patchUi({ piDialog: this.piDialogs[0] ?? null });
    } catch (error) {
      this.patchUi({ toast: `Ответ Pi не доставлен: ${error instanceof Error ? error.message : String(error)}` });
      throw error;
    } finally { this.piAnswering.delete(token); }
  }

  private listeners = new Set<() => void>();
  private notifications = new StreamNotifications(() => {for(const listener of this.listeners)listener();});
  private streamAbort: AbortController | null = null;
  private piStreamAbort: AbortController | null = null;
  private globalAbort: AbortController | null = null;
  private activityDirectories = new Map<string, string>();
  private activitySessions = new Map<string, Session>();
  private activityRevisions = new Map<string, number>();
  private activityLookups = new Map<string, Promise<Session | undefined>>();
  private editBranchBusy = false;
  private conversationAtBottom = true;
  private directoryGeneration = 0;
  private selectionGeneration = 0;
  private submissions = new SubmissionLifecycle();
  private saveTimerQueued = false;
  private connectionGeneration = 0;
  private statusSequence = 0;
  private statusVersions = new Map<string, number>();
  private historyGeneration = 0;
  private historyAbort: AbortController | null = null;
  private hostGeneration = 0;
  private workspacePromise: Promise<boolean> | null = null;
  private promptQueue = new PromptQueueController({
    snapshot: () => this.state,
    generation: () => this.selectionGeneration,
    mutate: patch => this.mutate(patch),
    patchUi: patch => this.patchUi(patch),
    persistPrefs: () => this.persistPrefs(),
    getModelChoice: () => this.getModelChoice(),
    getAgentChoice: () => this.getAgentChoice(),
    getDraft: () => this.getDraft(),
    setDraft: text => this.setDraft(text),
    conversation: () => this.conversation(),
    engineReady: () => this.engineReady(),
    engineIdFor: () => this.engineIdFor(),
    isRunning: id => this.isRunning(id),
    externalLock: id => this.scheduledLocks.has(id) || this.compactLocks.has(id) || this.modelTransitionLocks.has(id),
    pendingInteraction: id => this.pendingInteraction(id),
    dispatchQueued: (item, steer) => this.dispatchQueued(item, steer),
    beginSending: () => this.beginSending(),
    finishSending: operation => this.finishSending(operation),
  });
  private get queueArmed() { return this.promptQueue.queueArmed; }
  private get queueLocks() { return this.promptQueue.queueLocks; }
  private get queueStops() { return this.promptQueue.queueStops; }
  private accessChanging = false;
  private compactLocks = new Set<string>();
  private modelTransitionLocks = new Set<string>();
  private historyJournals = new Set<ServerEvent[]>();
  private sidebarJournals = new Set<Map<string, Session | null>>();
  private sidebarRequests = new Map<string, number>();
  private recentRequest = 0;

  private beginSending(): Submission {
    const operation = this.submissions.begin(this.state.activeSessionId);
    this.patchUi({ sending: true, sendError: null });
    return operation;
  }

  private finishSending(operation: Submission): boolean {
    if (!this.submissions.finish(operation)) return false;
    this.patchUi({ sending: false });
    return true;
  }

  private invalidateSelection(): void {
    this.selectionGeneration++;
    this.historyGeneration++;
    this.historyAbort?.abort();
    this.historyAbort = null;
    if (this.submissions.cancel()) this.patchUi({ sending: false });
  }

  dispose(): void {
    this.notifications.cancel();
    this.invalidateSelection();
    this.connectionGeneration++;
    this.directoryGeneration++;
    this.streamAbort?.abort();
    this.piStreamAbort?.abort();
    this.globalAbort?.abort();
    this.queueArmed.clear();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): AppState => this.state;

  private mutate(
    patch: Partial<AppState> | ((s: AppState) => Partial<AppState>),
  ): void {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...p, rev: this.state.rev + 1 };
    if (p.providers) modelServices.setSources("opencode", (isLocalComputer(this.state.prefs.endpoint, !!this.currentHost()) ? p.providers : []).flatMap(provider =>
      Object.values(provider.models).map(model => ({ providerID: provider.id, modelID: model.id,
        remoteID: model.api?.id, baseURL: model.api?.url || provider.options?.baseURL }))));
    if ("piHealth" in p) modelServices.setSources(PI_BACKEND_ID, (p.piHealth?.models ?? []).map(model =>
      ({ providerID: model.provider, modelID: model.id, baseURL: model.baseUrl })));
    if (p.sessions || p.archivedSessions) {
      const managed = new Set(this.state.prefs.projectlessDirectories ?? []);
      const index = new Map(
        (this.state.prefs.projectlessSessions ?? []).map((x) => [x.id, x]),
      );
      for (const x of [...(p.sessions ?? []), ...(p.archivedSessions ?? [])]) {
        if (managed.has(x.directory)) index.set(x.id, x);
      }
      this.state.prefs = {
        ...this.state.prefs,
        projectlessSessions: [...index.values()],
      };
      this.persistPrefs();
    }
    modelServices.observeActivity();
    this.notifications.notify();
  }

  private patchUi(patch: Partial<UiState>): void {
    this.mutate((s) => ({ ui: { ...s.ui, ...patch } }));
  }

  persistPrefs(): void {
    if (this.saveTimerQueued) return;
    this.saveTimerQueued = true;
    queueMicrotask(() => {
      this.saveTimerQueued = false;
      savePrefs(this.state.prefs);
    });
  }

  // ---------- connection ----------

  private connectPromise: Promise<boolean> | null = null;

  /** Idempotent: concurrent calls (e.g. React StrictMode double-mount) share one attempt. */
  connect(endpoint?: string): Promise<boolean> {
    if (!endpoint && this.connectPromise) return this.connectPromise;
    const p = endpoint
      ? this.connectLocal(endpoint)
      : this.connectHost(this.state.prefs.activeHost ?? "local");
    if (!endpoint) {
      this.connectPromise = p;
      void p.finally(() => {
        if (this.connectPromise === p) this.connectPromise = null;
      });
    }
    return p;
  }

  currentHost(): RemoteHost | undefined {
    return this.state.prefs.remoteHosts?.find(
      (h) => h.id === this.state.prefs.activeHost,
    );
  }
  hostLabel(): string {
    return this.currentHost()?.name ?? "Этот компьютер";
  }
  async connectLocal(endpoint: string): Promise<boolean> {
    this.hostGeneration++;
    this.mutate((s) => ({
      prefs: { ...s.prefs, activeHost: "local", localEndpoint: endpoint },
    }));
    return this.doConnect(endpoint, endpoint);
  }
  async connectHost(id: string): Promise<boolean> {
    const request = ++this.hostGeneration;
    const host = this.state.prefs.remoteHosts?.find((h) => h.id === id);
    if (id !== "local" && !host) {
      this.patchUi({ toast: "Подключение не найдено." });
      return false;
    }
    this.invalidateSelection();
    this.connectionGeneration++;
    this.directoryGeneration++;
    this.streamAbort?.abort();
    this.piStreamAbort?.abort();
    this.globalAbort?.abort();
    this.queueArmed.clear();
    this.mutate((s) => ({
      prefs: {
        ...s.prefs,
        activeHost: id,
        localEndpoint:
          s.prefs.localEndpoint ??
          (s.prefs.workspaceKey?.startsWith("ssh:")
            ? DEFAULT_PREFS.endpoint
            : s.prefs.endpoint),
      },
      connection: {
        ...s.connection,
        phase: "connecting",
        error: null,
        streamState: "idle",
      },
      ui: { ...s.ui, sending: false, workspacePreparing: false },
    }));
    this.persistPrefs();
    try {
      const endpoint = host
        ? await connectSsh(host)
        : (this.state.prefs.localEndpoint ?? DEFAULT_PREFS.endpoint);
      if (request !== this.hostGeneration) return false;
      return await this.doConnect(endpoint, host ? remoteKey(host) : endpoint);
    } catch (e) {
      if (request === this.hostGeneration)
        this.mutate((s) => ({
          connection: {
            ...s.connection,
            phase: "disconnected",
            error: errText(e),
          },
        }));
      return false;
    }
  }
  saveRemoteHost(host: RemoteHost): void {
    if (!validRemote(host)) throw new Error("Некорректный SSH-адрес или порт.");
    this.mutate((s) => ({
      prefs: {
        ...s.prefs,
        remoteHosts: [
          ...(s.prefs.remoteHosts ?? []).filter((h) => h.id !== host.id),
          host,
        ],
      },
    }));
    this.persistPrefs();
  }
  removeRemoteHost(id: string): void {
    if (id === this.state.prefs.activeHost) return;
    this.mutate((s) => ({
      prefs: {
        ...s.prefs,
        remoteHosts: s.prefs.remoteHosts?.filter((h) => h.id !== id),
      },
    }));
    this.persistPrefs();
  }

  private async doConnect(
    endpoint?: string,
    workspaceKey?: string,
  ): Promise<boolean> {
    const requested =
      endpoint?.trim().replace(/\/+$/, "") ?? this.backend.endpoint;
    // Strict lookup: re-creating the active backend from a *fallback* descriptor
    // would quietly move the workspace onto a different agent runtime.
    const descriptor = findBackendDescriptor(this.backend.id);
    if (!descriptor) {
      this.patchUi({
        toast: `Агент «${this.backend.id}» не зарегистрирован в этой сборке.`,
      });
      return false;
    }
    if (!descriptor.isAllowedEndpoint(requested)) {
      this.patchUi({
        toast:
          "Use a plain HTTP loopback origin, such as http://127.0.0.1:4096 (no path, credentials or query).",
      });
      return false;
    }
    this.queueArmed.clear();
    this.invalidateSelection();
    const gen = ++this.connectionGeneration;
    this.patchUi({ handoffSource: null });
    this.mutate({ projectSessionLists: {}, recentSessionList: emptyRecentList() });
    this.directoryGeneration++;
    this.streamAbort?.abort();
    this.streamAbort = null;
    this.piStreamAbort?.abort();
    this.piStreamAbort = null;
    this.globalAbort?.abort();
    this.globalAbort = null;
    const key = workspaceKey ?? requested;
    if (
      requested !== this.backend.endpoint ||
      key !== (this.state.prefs.workspaceKey ?? this.state.prefs.endpoint)
    ) {
      const prefs =
        key === (this.state.prefs.workspaceKey ?? this.state.prefs.endpoint)
          ? { ...this.state.prefs, endpoint: requested }
          : switchEndpointPrefs(this.state.prefs, requested, key);
      if (key !== (this.state.prefs.workspaceKey ?? this.state.prefs.endpoint))
        this.activityDirectories.clear();
      // Revalidate persisted attention on every connection, including the same server.
      this.activitySessions.clear();
      this.activityRevisions.clear();
      this.activityLookups.clear();
      this.backend = descriptor.create(requested);
      this.mutate({
        prefs,
        directory: prefs.selectedDirectory,
        activeSessionId: null,
        projects: [],
        sessions: [],
        archivedSessions: [],
        projectSessionLists: {},
        recentSessionList: emptyRecentList(),
        statuses: {},
        activityStatuses: {},
        chat: emptyChatRoot(),
        providers: [],
        connectedProviderIds: [],
        agents: [],
        olderExhausted: {},
        historyCursors: {},
        configModel: null,
        compaction: {},
        configDefaultAgent: null,
      });
      this.patchUi({
        sending: false,
        sendError: null,
        historyError: null,
        vcs: null,
      });
      this.persistPrefs();
    }
    this.backend.setAuthHeaders(hostHeaders(key));
    const backend = this.backend;
    this.mutate((s) => ({
      connection: {
        ...s.connection,
        phase: "connecting",
        streamState: "idle",
        globalStreamState: "idle",
        statusError: null,
        error: null,
        endpoint: requested,
      },
    }));
    try {
      let health;
      try {
        health = await backend.health();
      } catch (error) {
        if (gen !== this.connectionGeneration) return false;
        // A local network failure may mean that no engine is running. The
        // native side double-checks health/port under an interprocess lock
        // before launching the separately installed CLI. SSH forwards have a
        // different workspace key and must never fall back to a local engine.
        if (
          !(error instanceof ConnectionError) ||
          key !== requested ||
          !(await startLocalServerIfNative(requested, this.state.prefs.localOpenCodeProgram))
        ) throw error;
        if (gen !== this.connectionGeneration) return false;
        health = await backend.health();
      }
      if (gen !== this.connectionGeneration) return false;
      if (!health.healthy) throw new Error("Server reports unhealthy");
      if (Number(health.version.split(".")[0]) !== 1)
        throw new Error(
          `OpenCode ${health.version}: this adapter is tested with 1.18.18.`,
        );
      this.mutate((s) => ({
        connection: {
          ...s.connection,
          phase: "connected",
          version: health.version,
          error: null,
        },
      }));
      await Promise.all([this.refreshProjects(), this.loadRuntimeMetadata()]);
      if (gen !== this.connectionGeneration) return false;
      if (this.state.directory)
        await this.setDirectory(this.state.directory, { restoreSession: true });
      else await this.setDirectory(null);
      if (gen !== this.connectionGeneration) return false;
      invalidateBrowserSetup();
      void this.configureBrowser();
      this.startGlobalStream(backend, gen);
      void this.reconcileUnreadSessions();
      return true;
    } catch (e) {
      if (gen === this.connectionGeneration)
        this.mutate((s) => ({
          connection: {
            ...s.connection,
            phase: "disconnected",
            version: null,
            error: errText(e),
          },
        }));
      return false;
    }
  }

  private async loadRuntimeMetadata(): Promise<void> {
    const gen = this.directoryGeneration,
      backend = this.backend,
      directory = this.state.directory;
    this.patchUi({ runtimeLoading: true });
    try {
      const [prov, agents, config] = await Promise.all([
        backend.providers(undefined, directory),
        backend.agents(undefined, directory),
        backend.config(directory),
      ]);
      if (gen !== this.directoryGeneration || backend !== this.backend) return;
      this.mutate({
        providers: prov.all ?? [],
        connectedProviderIds: prov.connected ?? [],
        providerDefaults: prov.default ?? null,
        configDefaultAgent: config.default_agent ?? null,
        configModel: config.model ?? null,
        compaction: config.compaction ?? {},
        agents: (agents ?? []).filter((a) => !a.hidden),
      });
    } catch (e) {
      if (gen === this.directoryGeneration && backend === this.backend) {
        if (directory && e instanceof ApiError && (e.filesystemDenied || e.status >= 500))
          this.noteProjectFailure(e);
        this.patchUi({ toast: `Не удалось загрузить модели и агентов: ${errText(e)}` });
      }
    } finally {
      if (gen === this.directoryGeneration && backend === this.backend)
        this.patchUi({ runtimeLoading: false });
    }
  }

  /** Primary (non-subagent) agents are the only ones selectable as the main conversation agent. */
  primaryAgentNames(): string[] {
    return this.state.agents
      .filter((a) => a.mode !== "subagent")
      .map((a) => a.name);
  }

  async retryConnection(): Promise<void> {
    await this.connect();
  }

  private noteProjectFailure(error: unknown): void {
    // A recovered read must not silently release work paused by a project failure.
    for (const id of this.queueArmed) {
      if (this.engineIdFor(id, this.state.directory ?? undefined) !== PI_BACKEND_ID &&
          this.getQueue(id).some(item => item.directory === this.state.directory))
        this.queueArmed.delete(id);
    }
    this.mutate(s => ({ connection: { ...s.connection, statusError: projectErrorText(error) } }));
  }

  /** Read-only project recovery: preserves selection, draft, queue and history.
   * It never dispatches queued work or restarts an external server. */
  async retryProjectAccess(): Promise<void> {
    const directory = this.state.directory, gen = this.directoryGeneration;
    if (!directory || this.state.connection.phase !== "connected") return;
    await this.resyncAfterReconnect(directory, gen, false);
    if (gen === this.directoryGeneration && !this.state.connection.statusError)
      await this.loadRuntimeMetadata();
  }

  /** Stores the typed value; validation/normalization happens on connect. */
  setEndpoint(endpoint: string): void {
    this.mutate((s) => ({ prefs: { ...s.prefs, endpoint } }));
    this.persistPrefs();
  }

  // ---------- projects / directories ----------

  isProjectExpanded(directory: string): boolean {
    return this.state.prefs.expandedProjects?.[directory] ?? this.state.directory === directory;
  }

  toggleProject(directory: string): void {
    const expanded = !this.isProjectExpanded(directory);
    this.mutate((s) => ({ prefs: { ...s.prefs,
      expandedProjects: { ...s.prefs.expandedProjects, [directory]: expanded },
    } }));
    this.persistPrefs();
    // Expanding the tree must not change the conversation, draft or event stream.
    if (expanded) void this.loadProjectSessions(directory);
  }

  async loadProjectSessions(directory: string, opts: { force?: boolean; more?: boolean } = {}): Promise<void> {
    const openCodeUp = this.state.connection.phase === "connected";
    const localPi = this.piInstalled && piAvailability(this.state.prefs).available;
    if (!openCodeUp && !localPi) return;
    const previous = this.state.projectSessionLists[directory] ?? emptySidebarList();
    if (!opts.force && (previous.loading || (previous.loaded && !opts.more))) return;
    const request = (this.sidebarRequests.get(directory) ?? 0) + 1;
    this.sidebarRequests.set(directory, request);
    const generation = this.connectionGeneration;
    const limit = previous.limit + (opts.more ? 50 : 0);
    const journal = new Map<string, Session | null>();
    this.sidebarJournals.add(journal);
    const current = () => generation === this.connectionGeneration &&
      this.sidebarRequests.get(directory) === request;
    this.mutate((s) => ({ projectSessionLists: { ...s.projectSessionLists,
      [directory]: { ...previous, loading: true, error: null, limit },
    } }));
    try {
      const [openCodeSessions, statuses, piSessions] = await Promise.all([
        openCodeUp ? this.engine(DEFAULT_ENGINE).listSessions(directory, { limit }) : Promise.resolve([]),
        openCodeUp ? this.engine(DEFAULT_ENGINE).sessionStatuses(directory) : Promise.resolve({} as Record<string, SessionStatus>),
        this.piListFor(directory),
      ]);
      const sessions = [...openCodeSessions, ...piSessions];
      if (!current()) return;
      for (const session of sessions) {
        const latest = journal.has(session.id) ? journal.get(session.id) : session;
        if (latest) this.rememberActivitySession(latest);
      }
      if (openCodeUp) await this.reconcileUnreadSessions(directory);
      if (!current()) return;
      const attention = [...this.activitySessions.values()].filter(x => this.isUnread(x.id) && x.directory === directory);
      const scoped = mergeSidebarSessions([...attention, ...sessions], journal).filter((s) => s.directory === directory);
      for (const [id, status] of Object.entries(statuses))
        if (!this.activityStatus(id)) this.observeSessionStatus(id, status, directory);
      this.mutate((s) => ({ projectSessionLists: { ...s.projectSessionLists,
        [directory]: { sessions: scoped, loaded: true, loading: false, error: null, limit,
          hasMore: openCodeSessions.length >= limit },
      } }));
    } catch (e) {
      if (current()) this.mutate((s) => ({ projectSessionLists: { ...s.projectSessionLists,
        [directory]: { ...s.projectSessionLists[directory], loading: false, error: errText(e) },
      } }));
    } finally { this.sidebarJournals.delete(journal); }
  }

  async loadRecentSessions(archived = false, more = false): Promise<void> {
    const openCodeUp = this.state.connection.phase === "connected";
    const localPi = this.piInstalled && piAvailability(this.state.prefs).available;
    if (!openCodeUp && !localPi) return;
    const previous = this.state.recentSessionList;
    if (more && (!previous.cursor || previous.loading || previous.archived !== archived)) return;
    const generation = this.connectionGeneration, request = ++this.recentRequest;
    const journal = new Map<string, Session | null>();
    this.sidebarJournals.add(journal);
    const current = () => generation === this.connectionGeneration && request === this.recentRequest;
    this.mutate({ recentSessionList: { ...(previous.archived === archived ? previous : emptyRecentList()),
      archived, loading: true, error: null },
    });
    try {
      const [page, piPage] = await Promise.all([
        openCodeUp
          ? this.engine(DEFAULT_ENGINE).recentSessions(archived, more ? previous.cursor ?? undefined : undefined)
          : Promise.resolve({ sessions: [] as Session[], cursor: null }),
        localPi
          ? this.pi().recentSessions(archived)
          : Promise.resolve({ sessions: [] as Session[], cursor: null }),
      ]);
      if (!current()) return;
      for (const session of [...page.sessions, ...piPage.sessions]) this.rememberActivitySession(session);
      const sessions = mergeSidebarSessions([...(more ? previous.sessions : []), ...page.sessions, ...piPage.sessions], journal)
        .filter((s) => Boolean(s.time.archived) === archived);
      this.mutate({ recentSessionList: { ...this.state.recentSessionList, sessions, loaded: true,
        loading: false, cursor: page.cursor, hasMore: page.cursor !== null },
      });
    } catch (e) {
      if (current()) this.mutate({ recentSessionList: { ...this.state.recentSessionList,
        loading: false, error: errText(e) },
      });
    } finally { this.sidebarJournals.delete(journal); }
  }

  private updateSidebarSession(session: Session | null, id = session?.id): void {
    if (!id) return;
    for (const journal of this.sidebarJournals) journal.set(id, session);
    const change = new Map([[id, session]]);
    this.mutate((s) => ({
      projectSessionLists: Object.fromEntries(Object.entries(s.projectSessionLists).map(([dir, list]) => [dir, {
        ...list, sessions: mergeSidebarSessions(list.sessions, change).filter((x) => x.directory === dir),
      }])),
      recentSessionList: { ...s.recentSessionList,
        sessions: mergeSidebarSessions(s.recentSessionList.sessions, change)
          .filter((x) => Boolean(x.time.archived) === s.recentSessionList.archived),
      },
    }));
  }

  private indexSidebarEvent(event: ServerEvent): void {
    if (["session.created", "session.updated"].includes(event.type)) {
      const info = event.properties?.info as Session | undefined;
      if (info?.id && info.directory && info.time) {
        this.rememberActivitySession(info);
        this.updateSidebarSession(info);
        if (info.time.archived) this.clearUnread(info.id);
      }
    }
    if (event.type === "session.deleted") {
      const id = event.properties?.sessionID ?? (event.properties?.info as Session | undefined)?.id;
      if (typeof id === "string") this.updateSidebarSession(null, id);
    }
  }

  private workshopFlights = new Map<string, Promise<WorkshopRecord>>();
  isWorkshopSession(session: Pick<Session, "id" | "directory">): boolean {
    return isWorkshopSession(this.state.prefs.workshop, session);
  }
  isWorkshopDirectory(directory: string): boolean { return this.state.prefs.workshop?.directory === directory; }
  async ensureWorkshop(): Promise<WorkshopRecord> {
    if (!isNative() || !isLocalComputer(this.state.prefs.endpoint, !!this.currentHost()))
      throw new Error("Выберите «Этот компьютер», чтобы открыть мастерскую.");
    if (this.state.connection.phase !== "connected") throw new Error("Подключите OpenCode, чтобы открыть мастерскую.");
    const key = this.state.prefs.workspaceKey ?? this.state.prefs.endpoint;
    const pending = this.workshopFlights.get(key); if (pending) return pending;
    const backend = this.backend, previous = this.state.prefs.workshop, permission = accessRules(this.state.prefs.newAccess ?? "inherit");
    const work = (async () => {
      const paths = await backend.paths(null);
      const workspace = await prepareWorkshop(paths.home);
      const record = await resolveWorkshop(backend, workspace, previous, permission);
      this.mutate(s => {
        const current = (s.prefs.workspaceKey ?? s.prefs.endpoint) === key;
        return {prefs:current ? {...s.prefs,workshop:record,
          sessionEngine:{...s.prefs.sessionEngine,[record.session.id]:DEFAULT_BACKEND_ID}}
          : {...s.prefs,endpointState:{...s.prefs.endpointState,[key]:{
            ...s.prefs.endpointState?.[key],workshop:record,
          }}}};
      });
      this.persistPrefs();
      return record;
    })();
    this.workshopFlights.set(key,work);
    try { return await work; } finally { if (this.workshopFlights.get(key) === work) this.workshopFlights.delete(key); }
  }
  async openWorkshop(): Promise<void> {
    const selection = this.directoryGeneration, session = this.state.activeSessionId;
    const key = this.state.prefs.workspaceKey ?? this.state.prefs.endpoint;
    try {
      const record = await this.ensureWorkshop();
      if ((this.state.prefs.workspaceKey ?? this.state.prefs.endpoint) !== key || selection !== this.directoryGeneration || session !== this.state.activeSessionId) return;
      await this.openChat(record.session);
    } catch (e) { if ((this.state.prefs.workspaceKey ?? this.state.prefs.endpoint) === key) this.patchUi({toast:errText(e)}); }
  }

  async refreshProjects(): Promise<void> {
    if (this.state.connection.phase !== "connected") return;
    try {
      const backend = this.backend,
        gen = this.connectionGeneration;
      const projects = await backend.projects();
      if (backend === this.backend && gen === this.connectionGeneration)
        this.mutate({ projects });
    } catch (e) {
      this.patchUi({ toast: `Could not load projects: ${errText(e)}` });
    }
  }

  isProjectHidden(directory: string): boolean {
    return this.state.prefs.hiddenProjects?.includes(directory) ?? false;
  }

  removeProject(directory: string): void {
    if (this.isWorkshopDirectory(directory)) return;
    // This is a workspace-list operation, never a filesystem/session deletion.
    this.mutate((s) => ({ prefs: { ...s.prefs,
      hiddenProjects: [...new Set([...(s.prefs.hiddenProjects ?? []), directory])],
      pinnedProjects: s.prefs.pinnedProjects?.filter((dir) => dir !== directory),
      expandedProjects: { ...s.prefs.expandedProjects, [directory]: false },
    } }));
    this.persistPrefs();
  }

  restoreProject(directory: string): void {
    this.mutate((s) => ({ prefs: { ...s.prefs,
      hiddenProjects: s.prefs.hiddenProjects?.filter((dir) => dir !== directory),
      pinnedProjects: [...new Set([...(s.prefs.pinnedProjects ?? []), directory])],
    } }));
    this.persistPrefs();
  }

  async addProjectDirectory(dir: string): Promise<void> {
    const trimmed = dir.trim();
    if (!trimmed) return;
    this.mutate((s) => ({
      prefs: {
        ...s.prefs,
        hiddenProjects: s.prefs.hiddenProjects?.filter((path) => path !== trimmed),
        pinnedProjects: [
          ...new Set([...(s.prefs.pinnedProjects ?? []), trimmed]),
        ],
      },
      projects: [
        ...s.projects.filter((p) => p.worktree !== trimmed),
        { id: `local:${trimmed}`, worktree: trimmed, vcs: null, sandboxes: [] },
      ],
    }));
    await this.setDirectory(trimmed);
  }

  async setDirectory(
    directory: string | null,
    opts: { restoreSession?: boolean; sessionId?: string } = {},
  ): Promise<void> {
    this.invalidateSelection();
    const gen = ++this.directoryGeneration;
    this.listGeneration++; // in-flight list requests belong to the previous project
    this.streamAbort?.abort();
    this.streamAbort = null;
    this.piStreamAbort?.abort();
    this.piStreamAbort = null;
    this.mutate((s) => ({
      directory,
      sessions: [],
      archivedSessions: [],
      activeSessionId: directory
        ? opts.sessionId ?? (opts.restoreSession ? s.prefs.lastSessionByDir[directory] || null : null)
        : null,
      statuses: {},
      connection: { ...s.connection, statusError: null },
      prefs: {
        ...s.prefs,
        selectedDirectory: directory,
        lastSessionByDir: directory && opts.sessionId
          ? { ...s.prefs.lastSessionByDir, [directory]: opts.sessionId }
          : s.prefs.lastSessionByDir,
        expandedProjects: directory && !this.isProjectlessDirectory(directory) && !opts.restoreSession
          ? { ...s.prefs.expandedProjects, [directory]: true } : s.prefs.expandedProjects,
        newChatMode:
          !directory || this.isProjectlessDirectory(directory)
            ? "projectless"
            : "project",
      },
      ui: {
        ...s.ui,
        vcs: null,
        sessionListError: null,
        sendError: null,
        historyError: null,
        historyLoading: false,
        sessionListLoading: false,
      },
    }));
    this.persistPrefs();
    const metadata = this.state.connection.phase === "connected"
      ? this.loadRuntimeMetadata()
      : Promise.resolve();
    if (!directory) {
      await metadata;
      return;
    }

    if (this.state.connection.phase === "connected")
      void this.backend.vcs(directory).then((vcs) => {
        if (gen === this.directoryGeneration) this.patchUi({ vcs });
      });
    await Promise.all([this.refreshSessions(), metadata]);
    if (gen !== this.directoryGeneration) return;
    if (
      !opts.restoreSession &&
      !this.state.activeSessionId &&
      this.state.sessions.length > 0
    ) {
      // keep "new conversation" state by default; do not auto-open old sessions
    }
    void this.configureBrowser();
    void this.configureSharedTools().catch(error=>{if(gen===this.directoryGeneration)this.patchUi({toast:errText(error)});});
    this.startEventStream(directory, gen);
    this.startPiStream(directory, gen);
    if ((opts.restoreSession || opts.sessionId) && this.state.activeSessionId) {
      const restored = this.state.activeSessionId;
      if (!this.state.chat.sessions[restored])
        await this.loadHistory(restored, directory);
      if (gen !== this.directoryGeneration) return;
      if (!this.state.ui.historyError) this.markReadIfViewing();
    }
  }

  /**
   * Session list refresh. Uses its own request generation, never the project/stream
   * generation: a list refresh must not invalidate the live event stream (R1).
   */
  private listGeneration = 0;

  async refreshSessions(): Promise<void> {
    const directory = this.state.directory;
    const dirGen = this.directoryGeneration;
    const openCodeUp = this.state.connection.phase === "connected";
    if (!directory || (!openCodeUp && !this.piInstalled)) return;
    const myGen = ++this.listGeneration;
    const current = () =>
      myGen === this.listGeneration && dirGen === this.directoryGeneration;
    this.patchUi({ sessionListLoading: true, sessionListError: null });
    const readOpenCode = <T,>(request: Promise<T>): Promise<T> => request.catch(error => {
      if (current()) this.noteProjectFailure(error);
      throw error;
    });
    try {
      const [sessions, statuses, piSessions, piStatuses] = await Promise.all([
        openCodeUp ? readOpenCode(this.backend.listSessions(directory)) : Promise.resolve([]),
        openCodeUp
          ? readOpenCode(this.backend.sessionStatuses(directory))
          : Promise.resolve({} as Record<string, SessionStatus>),
        // A folder can hold chats from both engines; the sidebar shows both.
        this.piListFor(directory),
        this.piEngine
          ? this.pi().sessionStatuses(directory)
          : Promise.resolve({} as Record<string, SessionStatus>),
      ]);
      if (!current()) return;
      for (const session of [...sessions, ...piSessions])
        this.rememberActivitySession(session);
      const visible = [...sessions, ...piSessions].filter((s) => !s.parentID);
      for (const [id, status] of Object.entries(piStatuses))
        statuses[id] = status;
      for (const [id, status] of Object.entries(statuses))
        this.observeSessionStatus(id, status, directory);
      this.rememberChatListing(directory, visible);
      this.mutate({
        sessions: visible.filter((s) => !s.time.archived),
        archivedSessions: visible.filter((s) => s.time.archived),
        statuses,
      });
    } catch (e) {
      if (current()) this.patchUi({ sessionListError: errText(e) });
    } finally {
      if (current()) this.patchUi({ sessionListLoading: false });
    }
  }

  // ---------- session selection / history ----------

  async selectSession(sessionId: string | null): Promise<void> {
    if (!sessionId && this.state.directory && this.isWorkshopDirectory(this.state.directory))
      sessionId = this.state.prefs.workshop!.session.id;
    if (sessionId === this.state.activeSessionId) {
      this.markReadIfViewing();
      return;
    }
    this.invalidateSelection();
    const directory = this.state.directory;
    this.mutate((s) => ({
      activeSessionId: sessionId,
      ui: { ...s.ui, sendError: null, historyError: null, historyLoading: false },
      prefs: {
        ...s.prefs,
        lastSessionByDir: directory
          ? { ...s.prefs.lastSessionByDir, [directory]: sessionId ?? "" }
          : s.prefs.lastSessionByDir,
      },
    }));
    this.persistPrefs();
    if (!sessionId || !directory) return;
    if (!this.state.chat.sessions[sessionId]) {
      await this.loadHistory(sessionId, directory);
    }
    if (!this.state.ui.historyError) this.markReadIfViewing();
    void this.drainQueue();
  }

  async loadHistory(sessionId: string, directory: string): Promise<void> {
    this.historyAbort?.abort();
    const controller = new AbortController();
    this.historyAbort = controller;
    const gen = this.directoryGeneration,
      request = ++this.historyGeneration;
    const journal: ServerEvent[] = [];
    this.historyJournals.add(journal);
    this.patchUi({ historyLoading: true, historyError: null });
    try {
      const { messages, before } = await this.engine(
        this.engineIdFor(sessionId, directory),
      ).messages(sessionId, {
        directory,
        limit: 200,
        signal: controller.signal,
      });
      if (
        gen !== this.directoryGeneration ||
        this.state.activeSessionId !== sessionId ||
        request !== this.historyGeneration ||
        journal.length >= 20000
      )
        return;
      this.mutate((s) => {
        const chat: ChatRootState = {
          ...s.chat,
          sessions: { ...s.chat.sessions },
        };
        const previous = chat.sessions[sessionId];
        // Retain previously paginated history; replay post-request events over the snapshot.
        applyHistory(chat, sessionId, messages);
        if (previous && messages.length) {
          const first = messages[0].info.id;
          prependHistory(
            chat,
            sessionId,
            previous.messageOrder
              .filter((id) => id < first)
              .map((id) => ({
                info: previous.messages[id],
                parts: (previous.partsByMessage[id] ?? []).map(
                  (p) => previous.parts[p],
                ),
              })),
          );
        }
        reconcileHistoryEvents(chat, sessionId, previous, journal);
        return {
          chat,
          historyCursors: {
            ...s.historyCursors,
            [sessionId]:
              previous && previous.messageOrder.length > messages.length
                ? s.historyCursors[sessionId]
                : (before ?? null),
          },
          olderExhausted: {
            ...s.olderExhausted,
            [sessionId]:
              previous && previous.messageOrder.length > messages.length
                ? s.olderExhausted[sessionId]
                : !before,
          },
        };
      });
    } catch (e) {
      if (
        gen === this.directoryGeneration &&
        request === this.historyGeneration
      ) {
        if (!this.isPiSession(sessionId) && e instanceof ApiError && (e.filesystemDenied || e.status >= 500))
          this.noteProjectFailure(e);
        this.patchUi({ historyError: errText(e) });
      }
    } finally {
      this.historyJournals.delete(journal);
      if (this.historyAbort === controller) this.historyAbort = null;
      if (
        gen === this.directoryGeneration &&
        request === this.historyGeneration
      )
        this.patchUi({ historyLoading: false });
    }
  }

  isProjectlessDirectory(dir: string): boolean {
    const root = this.state.prefs.projectlessRoot;
    return (
      (this.state.prefs.projectlessDirectories ?? []).includes(dir) ||
      (!!root && pathIsWithin(dir, root))
    );
  }
  isProjectless(): boolean {
    return (
      !this.state.directory || this.isProjectlessDirectory(this.state.directory)
    );
  }
  projectDirectories(): string[] {
    return [
      ...new Set([
        ...this.state.projects.map((p) => p.worktree),
        ...(this.state.prefs.pinnedProjects ?? []),
        ...(this.state.directory ? [this.state.directory] : []),
      ]),
    ].filter((p) => p && p !== "/" && !this.isProjectlessDirectory(p) && !this.isWorkshopDirectory(p) && !this.isProjectHidden(p));
  }
  chatSessions(archived = false): Session[] {
    return (this.state.prefs.projectlessSessions ?? [])
      .filter((x) => Boolean(x.time.archived) === archived)
      .sort((a, b) => b.time.updated - a.time.updated);
  }
  saveHandoffDraft(key: string, session: Session, text: string): void {
    this.mutate((s) => {
      const append = (prefs: Partial<Prefs>) => ({ ...prefs, drafts: { ...prefs.drafts,
        [session.id]: [prefs.drafts?.[session.id], text].filter(Boolean).join("\n\n"),
      } });
      const prefs = key === (s.prefs.workspaceKey ?? s.prefs.endpoint)
        ? { ...s.prefs, ...append(s.prefs) }
        : { ...s.prefs, endpointState: { ...s.prefs.endpointState,
          [key]: append(s.prefs.endpointState?.[key] ?? {}),
        } };
      return { prefs };
    });
    this.persistPrefs();
  }

  /** Metadata of the open chat also includes children hidden from root listings. */
  activeSession(): Session | undefined {
    const id = this.state.activeSessionId;
    if (!id) return;
    // The root list already belongs to the open directory; cached children need
    // an explicit directory check because activity spans several projects.
    const listed = this.state.sessions.find(s => s.id === id);
    if (listed) return listed;
    const cached = this.activitySessions.get(id);
    return cached?.directory === this.state.directory ? cached : undefined;
  }

  async openChat(session: Session): Promise<void> {
    const generation = this.connectionGeneration;
    let selection = this.selectionGeneration;
    if (session.directory !== this.state.directory) {
      const switching = this.setDirectory(session.directory, { sessionId: session.id });
      selection = this.selectionGeneration;
      await switching;
    }
    // setDirectory may have been superseded by a user's later selection.
    if (generation === this.connectionGeneration && selection === this.selectionGeneration
      && this.state.directory === session.directory) {
      this.rememberActivitySession(session);
      await this.selectSession(session.id);
    }
  }
  private rememberChatListing(directory: string, sessions: Session[]): void {
    if (!this.isProjectlessDirectory(directory)) return;
    this.mutate((s) => ({
      prefs: {
        ...s.prefs,
        projectlessSessions: [
          ...(s.prefs.projectlessSessions ?? []).filter(
            (x) => x.directory !== directory,
          ),
          ...sessions,
        ],
      },
    }));
    this.persistPrefs();
  }
  async ensureChatWorkspace(): Promise<boolean> {
    if (this.state.directory) return true;
    const desiredEngine = this.newChatEngine();
    if (!this.engineReady(desiredEngine)) return false;
    if (desiredEngine === PI_BACKEND_ID && this.currentHost()) {
      this.patchUi({ sendError: "Pi работает только на этом компьютере. Выберите локальное выполнение." });
      return false;
    }
    if (!this.engine(desiredEngine).capabilities.projectlessChat) {
      this.patchUi({ sendError: "Этот агент требует выбранного проекта." });
      return false;
    }
    if (this.workspacePromise) return this.workspacePromise;
    const gen = this.directoryGeneration,
      backend = this.backend,
      host = this.currentHost();
    this.patchUi({ workspacePreparing: true, sendError: null });
    const p = (async () => {
      try {
        const workspace = desiredEngine === PI_BACKEND_ID
          ? await piBridge().prepareChatWorkspace()
          : await (async () => {
              const paths = await backend.paths();
              if (gen !== this.directoryGeneration || backend !== this.backend)
                throw new Error("Выбор рабочего места изменился.");
              return prepareChat(host, paths.home);
            })();
        if (gen !== this.directoryGeneration || backend !== this.backend)
          return false;
        const draft = this.getDraft();
        this.mutate((s) => ({
          prefs: {
            ...s.prefs,
            projectlessRoot: workspace.root,
            projectEngine: desiredEngine === PI_BACKEND_ID
              ? { ...s.prefs.projectEngine, [workspace.directory]: PI_BACKEND_ID }
              : s.prefs.projectEngine,
            projectlessDirectories: [
              ...new Set([
                ...(s.prefs.projectlessDirectories ?? []),
                workspace.directory,
              ]),
            ],
            drafts: {
              ...s.prefs.drafts,
              [draftKey(null, workspace.directory)]: draft,
            },
          },
        }));
        const nextGen = this.directoryGeneration + 1;
        // Selecting the new directory updates state synchronously, while its
        // session index, runtime metadata and event streams hydrate in the
        // background. Browser-first chat must not wait for those unrelated
        // reads before it can create its scoped agent session.
        void this.setDirectory(workspace.directory).catch((error) => {
          if (nextGen === this.directoryGeneration && backend === this.backend)
            this.patchUi({ sendError: errText(error) });
        });
        return nextGen === this.directoryGeneration && backend === this.backend;
      } catch (e) {
        if (gen === this.directoryGeneration && backend === this.backend)
          this.patchUi({ sendError: errText(e) });
        return false;
      } finally {
        if (backend === this.backend) this.patchUi({ workspacePreparing: false });
      }
    })();
    this.workspacePromise = p;
    try {
      return await p;
    } finally {
      if (this.workspacePromise === p) this.workspacePromise = null;
    }
  }

  async newSession(): Promise<void> {
    // Composer targets the "new conversation" slot; the session is created lazily on first send.
    await this.setDirectory(null);
  }

  async createSessionNow(title?: string): Promise<Session | null> {
    const directory = this.state.directory;
    if (!directory) return null;
    if (this.isWorkshopDirectory(directory)) { await this.openWorkshop(); return this.state.prefs.workshop?.session ?? null; }
    const gen = this.directoryGeneration;
    const endpoint = this.backend.endpoint;
    const choice = this.getModelChoice();
    try {
      const engineId = this.engineIdForDirectory(directory);
      const session = await this.engine(engineId).createSession({
        directory,
        title,
        permission: accessRules(this.state.prefs.newAccess ?? "inherit"),
        agent: this.getAgentChoice() ?? undefined,
        model: choice
          ? {
              id: choice.modelID,
              providerID: choice.providerID,
              variant: choice.variant ?? undefined,
            }
          : undefined,
      });
      // Identity guard: the session belongs to the project it was requested for. If the
      // user already switched projects, never inject/select it here (R3).
      if (
        gen !== this.directoryGeneration ||
        this.state.directory !== directory ||
        this.backend.endpoint !== endpoint
      ) {
        return session;
      }
      this.rememberActivitySession(session);
      this.mutate((s) => ({
        sessions: [session, ...s.sessions.filter((x) => x.id !== session.id)],
      }));
      this.updateSidebarSession(session);
      await this.selectSession(session.id);
      return session;
    } catch (e) {
      if (gen === this.directoryGeneration)
        this.patchUi({ toast: `Could not create session: ${errText(e)}` });
      return null;
    }
  }

  async renameSession(session: Session, title: string): Promise<void> {
    if (this.isWorkshopSession(session)) { this.patchUi({toast:"Мастерская защищена от удаления и архивирования."}); return; }
    const gen = this.connectionGeneration;
    const backend = this.engine(this.engineIdFor(session.id, session.directory));
    try {
      const updated = await backend.updateSession(
        session.id,
        { title },
        session.directory,
      );
      if (gen !== this.connectionGeneration || !this.engineStillActive(backend))
        return;
      this.updateSidebarSession(updated);
      this.mutate((s) => ({
        sessions: s.sessions.map((x) => (x.id === updated.id ? updated : x)),
        prefs: {
          ...s.prefs,
          projectlessSessions: s.prefs.projectlessSessions?.map((x) =>
            x.id === updated.id ? updated : x,
          ),
        },
      }));
    } catch (e) {
      if (gen !== this.connectionGeneration || !this.engineStillActive(backend))
        return;
      this.patchUi({ toast: `Rename failed: ${errText(e)}` });
    }
  }

  async archiveSession(session: Session): Promise<void> {
    if (this.isWorkshopSession(session)) { this.patchUi({toast:"Мастерская защищена от удаления и архивирования."}); return; }
    const gen = this.connectionGeneration;
    const backend = this.engine(this.engineIdFor(session.id, session.directory));
    try {
      const updated = await backend.updateSession(
        session.id,
        { time: { archived: Date.now() } },
        session.directory,
      );
      if (gen !== this.connectionGeneration || !this.engineStillActive(backend))
        return;
      this.clearUnread(session.id);
      this.updateSidebarSession(updated);
      this.mutate((s) => ({
        sessions: s.sessions.filter((x) => x.id !== session.id),
        archivedSessions:
          updated.directory === s.directory
            ? [
                updated,
                ...s.archivedSessions.filter((x) => x.id !== session.id),
              ]
            : s.archivedSessions,
        activeSessionId:
          s.activeSessionId === session.id ? null : s.activeSessionId,
        prefs: {
          ...s.prefs,
          projectlessSessions: s.prefs.projectlessSessions?.map((x) =>
            x.id === updated.id ? updated : x,
          ),
          lastSessionByDir:
            s.prefs.lastSessionByDir[session.directory] === session.id
              ? { ...s.prefs.lastSessionByDir, [session.directory]: "" }
              : s.prefs.lastSessionByDir,
        },
      }));
      this.persistPrefs();
      this.patchUi({ toast: "Session archived" });
    } catch (e) {
      if (gen !== this.connectionGeneration || !this.engineStillActive(backend))
        return;
      this.patchUi({ toast: `Archive failed: ${errText(e)}` });
    }
  }

  async unarchiveSession(session: Session): Promise<void> {
    const gen = this.connectionGeneration;
    const backend = this.engine(this.engineIdFor(session.id, session.directory));
    try {
      const updated = await backend.updateSession(
        session.id,
        { time: { archived: 0 } },
        session.directory,
      );
      if (gen !== this.connectionGeneration || !this.engineStillActive(backend))
        return;
      this.updateSidebarSession(updated);
      this.mutate((s) => ({
        archivedSessions: s.archivedSessions.filter((x) => x.id !== session.id),
        prefs: {
          ...s.prefs,
          projectlessSessions: s.prefs.projectlessSessions?.map((x) =>
            x.id === updated.id
              ? { ...updated, time: { ...updated.time, archived: undefined } }
              : x,
          ),
        },
        sessions:
          updated.directory !== s.directory ||
          s.sessions.some((x) => x.id === session.id)
            ? s.sessions
            : [
                { ...updated, time: { ...updated.time, archived: undefined } },
                ...s.sessions,
              ],
      }));
      this.patchUi({ toast: "Session restored" });
    } catch (e) {
      if (gen !== this.connectionGeneration || !this.engineStillActive(backend))
        return;
      this.patchUi({ toast: `Restore failed: ${errText(e)}` });
    }
  }

  async deleteSession(session: Session): Promise<void> {
    if (this.isWorkshopSession(session)) { this.patchUi({toast:"Мастерская защищена от удаления и архивирования."}); return; }
    const gen = this.connectionGeneration;
    const backend = this.engine(this.engineIdFor(session.id, session.directory));
    try {
      await backend.deleteSession(session.id, session.directory);
      if (gen !== this.connectionGeneration || !this.engineStillActive(backend))
        return;
      this.forgetActivity(session.id);
      this.mutate((s) => ({
        sessions: s.sessions.filter((x) => x.id !== session.id),
        archivedSessions: s.archivedSessions.filter((x) => x.id !== session.id),
        activeSessionId:
          s.activeSessionId === session.id ? null : s.activeSessionId,
        ui: { ...s.ui, confirmDelete: null },
        prefs: {
          ...s.prefs,
          projectlessSessions: s.prefs.projectlessSessions?.filter(
            (x) => x.id !== session.id,
          ),
          lastSessionByDir:
            s.prefs.lastSessionByDir[session.directory] === session.id
              ? { ...s.prefs.lastSessionByDir, [session.directory]: "" }
              : s.prefs.lastSessionByDir,
        },
      }));
      this.persistPrefs();
      this.patchUi({ toast: "Session deleted permanently" });
    } catch (e) {
      if (gen !== this.connectionGeneration || !this.engineStillActive(backend))
        return;
      this.patchUi({ toast: `Delete failed: ${errText(e)}` });
    }
  }

  // ---------- model / agent selection ----------

  /**
   * Model preferences are scoped per engine: Pi and OpenCode have different
   * catalogs, so switching engines must never reuse the other one's model.
   * OpenCode keeps the historic unprefixed keys, so existing preferences and
   * per-session choices continue to resolve unchanged.
   */
  getModelChoice(
    engine: EngineId = this.engineIdFor(),
    directoryOverride?: string | null,
  ): {
    providerID: string;
    modelID: string;
    variant?: string | null;
  } | null {
    if (engine === PI_BACKEND_ID)
      return this.piModelChoice(directoryOverride ?? this.state.directory);
    return chooseOpenCodeModel(this.state, {
      projectless: this.isProjectless(), activeModel: this.activeSession()?.model,
      agentName: this.getAgentChoice(), defaultVariant: (p, m) => this.defaultVariant(p, m),
    });
  }

  /** Pi's catalog comes from the engine itself, not from OpenCode providers. */
  /**
   * Pi's model resolution.
   *
   * Pi's bundled catalog is *not* the list of models an account can use: it can
   * both miss accessible custom models and list models the account cannot reach.
   * A successful short request is access evidence for defaults. Configured
   * picker rows remain visible offline; selecting one checks readiness:
   *
   *   per-chat / per-folder choice  →  explicit custom model  →  configured
   *   default  →  first catalog entry
   *
   * `checkPiModelAccess` records that evidence per model.
   */
  private piModelChoice(directory: string | null): ModelChoice | null {
    return choosePiModel(this.state, directory);
  }

  /** Configured models remain visible; access evidence is a badge, not a filter. */
  piModelOptions(): {
    providerID: string;
    modelID: string;
    label: string;
    source: "catalog" | "custom";
    verified: boolean;
  }[] {
    const verified = this.state.prefs.pi?.verifiedModel;
    const verifiedModels = this.state.prefs.pi?.verifiedModels ?? {};
    type Option = {
      providerID: string;
      modelID: string;
      label: string;
      source: "catalog" | "custom";
      verified: boolean;
    };
    const out: Option[] = (this.state.piHealth?.models ?? []).map((m) => ({
      providerID: m.provider,
      modelID: m.id,
      label: m.name ?? m.id,
      source: "catalog",
      verified: verified === `${m.provider}/${m.id}` || Boolean(verifiedModels[`${m.provider}/${m.id}`]),
    }));
    const custom = parseModelId(this.state.prefs.pi?.customModel);
    if (custom && !out.some((m) => m.providerID === custom.providerID && m.modelID === custom.modelID))
      out.unshift({
        ...custom,
        label: custom.modelID,
        source: "custom",
        verified: verified === `${custom.providerID}/${custom.modelID}` || Boolean(verifiedModels[`${custom.providerID}/${custom.modelID}`]),
      });
    return out;
  }

  setPiCustomModel(value: string): void {
    const parsed = parseModelId(value);
    this.setPiSettings({
      customModel: parsed ? `${parsed.providerID}/${parsed.modelID}` : undefined,
      // Preserve evidence for other models when changing the custom id.
    });
  }

  /**
   * The only honest readiness check: send the smallest possible real prompt and
   * see whether the provider answers. A configured model proves nothing about
   * credentials, endpoint or entitlement.
   */
  async checkPiModelAccess(modelId?: string, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
    const choice = modelId ? parseModelId(modelId) : this.getModelChoice(PI_BACKEND_ID);
    if (!choice)
      return { ok: false, detail: "Модель для Pi не выбрана." };
    const id = `${choice.providerID}/${choice.modelID}`;
    try {
      await modelServices.ensure(choice.providerID, choice.modelID, PI_BACKEND_ID, {signal});
      signal?.throwIfAborted();
      const detail = await this.pi().checkAccess(
        await piBridge().probeDirectory().catch(() => ""),
        choice,
      );
      this.setPiSettings({
        verifiedModel: id,
        verifiedModels: { ...this.state.prefs.pi?.verifiedModels, [id]: Date.now() },
      });
      return { ok: true, detail };
    } catch (e) {
      const verifiedModels = { ...this.state.prefs.pi?.verifiedModels };
      delete verifiedModels[id];
      this.setPiSettings({
        verifiedModel: this.state.prefs.pi?.verifiedModel === id ? undefined : this.state.prefs.pi?.verifiedModel,
        verifiedModels,
      });
      return { ok: false, detail: errText(e) };
    }
  }

  private defaultVariant(providerID: string, modelID: string): string | null {
    return this.modelInfo(providerID, modelID)?.variants?.medium
      ? "medium"
      : null;
  }

  setModelChoice(
    providerID: string,
    modelID: string,
    variant?: string | null,
    automaticBrowser = false,
  ): void {
    this.modelSelectionRevision++;
    const engine = this.engineIdFor();
    if (!modelServices.allowed(providerID, modelID, engine)) {
      this.patchUi({ sendError: "Эта модель недоступна выбранному агенту. Проверьте сервис моделей." });
      return;
    }
    const session = this.state.activeSessionId, directory = this.state.directory, backend = this.backend;
    void modelServices.ensure(providerID, modelID, engine).catch(error => {
      if (session === this.state.activeSessionId && directory === this.state.directory && backend === this.backend && engine === this.engineIdFor())
        this.patchUi({ sendError: errText(error) });
    });
    this.commitModelChoice(providerID, modelID, variant, automaticBrowser);
  }

  private assertContextReady(session: string | null, providerID: string, modelID: string, engine: string): void {
    if (engine !== PI_BACKEND_ID && session && this.transferNeeded(session, providerID, modelID))
      throw new Error('История не помещается в выбранную модель. Выберите её повторно для переноса через предыдущую большую модель или нажмите «Сжать сейчас». Черновик и очередь сохранены.');
  }

  private transferNeeded(session: string, providerID: string, modelID: string) {
    const target = this.modelInfo(providerID, modelID), chat = this.state.chat.sessions[session];
    return target && chat ? transferSource(chat.messageOrder.map(id => chat.messages[id]), target) : undefined;
  }

  /** One native compaction with the history's previous model, before unloading it.
   * No prompt replay, source mutation, truncation or automatic continuation. */
  private async transferContext(session: string, directory: string, targetProvider: string, targetModel: string,
    current: () => boolean, progress?: (message: string) => void): Promise<void> {
    const target = this.modelInfo(targetProvider, targetModel);
    if (!target || !inputBudget(target)) return;
    if (this.isRunning(session) || this.compactLocks.has(session) || this.state.ui.sending || this.scheduledLocks.has(session) || this.queueLocks.has(session))
      throw new Error('Дождитесь завершения текущей работы перед переносом контекста в меньшую модель.');
    this.compactLocks.add(session);
    const backend = this.conversation();
    try {
      const before = await backend.messages(session, {directory, limit: 100});
      if (!current()) throw new Error('Переход отменён: выбран другой чат или модель.');
      const source = transferSource(before.messages.map(r => r.info), target);
      if (!source) return;
      if (!source.providerID || !source.modelID) throw new Error('Не удалось определить предыдущую модель для сжатия. История сохранена.');
      const previous = this.modelInfo(source.providerID, source.modelID);
      const used = source.tokens?.total || (source.tokens?.input ?? 0) + (source.tokens?.output ?? 0) + (source.tokens?.cache?.read ?? 0) + (source.tokens?.cache?.write ?? 0);
      if (!previous || inputBudget(previous) <= used || source.providerID === targetProvider && source.modelID === targetModel)
        throw new Error('История превышает контекст модели для сжатия. Выберите предыдущую модель с большим контекстом; история сохранена.');
      if (!modelServices.manages(source.providerID, source.modelID) && !this.state.connectedProviderIds.includes(source.providerID))
        throw new Error('Предыдущая модель недоступна. Подключите её для сжатия; новая модель пока не выбрана.');
      const config = await backend.config(directory);
      const agent = (await backend.agents(undefined, directory)).find(a => a.name === 'compaction');
      if (agent?.model && (agent.model.providerID !== source.providerID || agent.model.modelID !== source.modelID))
        throw new Error('В настройках роли compaction закреплена другая модель. Для переноса нужна предыдущая модель с большим контекстом.');
      if (!current() || this.isRunning(session) || this.state.ui.sending) throw new Error('Состояние чата изменилось; перенос отменён.');
      progress?.(`Сжимаем историю моделью ${previous.name || previous.id}. Затем загрузим выбранную модель. Полная история останется в чате.`);
      await modelServices.ensure(source.providerID, source.modelID, this.engineIdFor(session, directory), {context: session});
      if (!current() || this.isRunning(session) || this.state.ui.sending) throw new Error('Состояние чата изменилось; перенос отменён.');
      const [statuses, permissions, questions] = await Promise.all([
        backend.sessionStatuses(directory), backend.pendingPermissions(directory), backend.pendingQuestions(directory),
      ]);
      if (!current() || statuses[session]?.type === 'busy' || statuses[session]?.type === 'retry' || permissions.some(p => p.sessionID === session) || questions.some(q => q.sessionID === session))
        throw new Error('Агент занят или ожидает разрешения. Перенос не начат; дождитесь завершения работы.');
      const deadline = Date.now() + 900000;
      await backend.summarize(session, directory, source.providerID, source.modelID);
      const summary = await waitForSummary(async () => (await backend.messages(session, {directory, limit: 100})).messages,
        new Set(before.messages.map(r => r.info.id)), target, config.compaction?.preserve_recent_tokens ?? 16000, deadline);
      if (!current()) throw new Error('Сжатие завершено, но переход отменён: выбран другой чат или модель.');
      // Merge only the authoritative completed summary. Do not replace paginated
      // history or replay stale snapshots over unrelated live tool messages.
      this.handleEvent({type: 'message.updated', properties: {info: summary.info}});
      for (const part of summary.parts) this.handleEvent({type: 'message.part.updated', properties: {part}});
      progress?.('Выжимка сохранена. Подготавливаем выбранную модель…');
    } finally {
      this.compactLocks.delete(session);
    }
  }

  private modelSelectionRevision = 0;
  /** Do not write the choice until the selected target passes its readiness check. */
  async selectModel(providerID: string, modelID: string, variant?: string | null, signal?: AbortSignal, progress?: (message: string) => void): Promise<boolean> {
    const revision = ++this.modelSelectionRevision;
    const engine = this.engineIdFor(), directory = this.state.directory, session = this.state.activeSessionId;
    const generation = this.directoryGeneration, backend = this.backend;
    const current = () => !signal?.aborted && revision === this.modelSelectionRevision && generation === this.directoryGeneration &&
      engine === this.engineIdFor() && directory === this.state.directory && session === this.state.activeSessionId && backend === this.backend;
    const locked = engine !== PI_BACKEND_ID && session && directory && inputBudget(this.modelInfo(providerID, modelID) ?? {id: modelID, providerID}) > 0 ? session : null;
    if (locked && (this.modelTransitionLocks.has(locked) || this.compactLocks.has(locked)))
      throw new Error('Дождитесь завершения перехода или сжатия контекста.');
    if (locked) this.modelTransitionLocks.add(locked);
    let committed = false;
    try {
      if (engine === PI_BACKEND_ID) {
        const result = await this.checkPiModelAccess(`${providerID}/${modelID}`, signal);
        if (!current()) return false;
        if (!result.ok) throw new Error(result.detail);
      } else {
        if (!this.configuredProvidersWithModels().some(p => p.id === providerID && Boolean(p.models[modelID])))
          throw new Error("Эта модель не настроена в OpenCode. Обновите список или проверьте настройки провайдера.");
        const health = await backend.health();
        if (!current()) return false;
        if (!health.healthy) throw new Error("Нет связи с OpenCode.");
        if (!modelServices.manages(providerID, modelID) && !this.state.connectedProviderIds.includes(providerID))
          throw new Error("Провайдер сейчас недоступен. Проверьте его настройки подключения.");
        if (session && directory) await this.transferContext(session, directory, providerID, modelID, current, progress);
        if (!current()) return false;
        await modelServices.ensure(providerID, modelID, engine, {signal});
        if (!current()) return false;
      }
      this.commitModelChoice(providerID, modelID, variant);
      committed = true;
      return true;
    } finally {
      if (locked) this.modelTransitionLocks.delete(locked);
      if (committed) void this.drainQueue();
    }
  }

  private commitModelChoice(providerID: string, modelID: string, variant?: string | null, automaticBrowser = false): void {
    const engine = this.engineIdFor();
    const dir =
      engine === PI_BACKEND_ID
        ? (this.state.directory ?? "@chats")
        : this.isProjectless()
          ? "@chats"
          : (this.state.directory ?? "");
    const key = modelScope(
      engine,
      this.state.activeSessionId
        ? `session:${this.state.activeSessionId}`
        : dir || "*",
    );
    const profileKey = this.state.activeSessionId ? browserTaskKey(this.state.prefs.workspaceKey ?? this.state.prefs.endpoint, engine, this.state.activeSessionId) : null;
    this.mutate((s) => ({
      prefs: {
        ...s.prefs,
        browserTasks: !automaticBrowser && profileKey && s.prefs.browserTasks?.[profileKey]
          ? { ...s.prefs.browserTasks, [profileKey]: { ...s.prefs.browserTasks[profileKey], appliedVariant: null } }
          : s.prefs.browserTasks,
        modelChoice: {
          ...s.prefs.modelChoice,
          [key]: { providerID, modelID, variant: variant ?? null },
        },
      },
    }));
    this.persistPrefs();
  }

  /** Explicit selection in this session wins, without changing other sessions. */
  getAgentChoice(): string | null {
    const dir = this.isProjectless() ? "@chats" : (this.state.directory ?? "*");
    const sessionId = this.state.activeSessionId;
    if (sessionId) {
      const selected = this.state.prefs.agentChoice[`session:${sessionId}`];
      if (selected) return selected;
      const active = this.activeSession()?.agent;
      if (active) return active;
    }
    const explicit =
      this.state.prefs.agentChoice[dir] ?? this.state.prefs.agentChoice["*"];
    if (explicit) return explicit;
    if (this.state.configDefaultAgent) return this.state.configDefaultAgent;
    return this.primaryAgentNames()[0] ?? null;
  }

  setAgentOverride(dir: string, name: string): void {
    const key = this.state.activeSessionId
      ? `session:${this.state.activeSessionId}`
      : this.isProjectless() ? "@chats" : dir || "*";
    this.mutate((s) => ({
      prefs: {
        ...s.prefs,
        agentChoice: { ...s.prefs.agentChoice, [key]: name },
      },
    }));
    this.persistPrefs();
  }

  connectedProvidersWithModels(): ProviderInfo[] {
    return this.state.providers.filter((p) =>
      this.state.connectedProviderIds.includes(p.id),
    );
  }

  configuredProvidersWithModels(): ProviderInfo[] {
    return this.state.providers.filter(p => p.source === "config" || this.state.connectedProviderIds.includes(p.id));
  }

  async refreshModelCatalog(): Promise<void> {
    const engine = this.engineIdFor(), gen = this.directoryGeneration, backend = this.backend, directory = this.state.directory;
    const discovery = engine === PI_BACKEND_ID
      ? this.pi().describe(await piBridge().probeDirectory().catch(() => "")).then(health => {
        if (health.error) throw new Error(health.error);
        if (gen === this.directoryGeneration && engine === this.engineIdFor()) { this.piInstalled = health.install.installed; this.mutate({ piHealth: health }); }
      })
      : backend.providers(undefined, directory).then(prov => {
        if (gen === this.directoryGeneration && backend === this.backend && engine === this.engineIdFor())
          this.mutate({ providers: prov.all ?? [], connectedProviderIds: prov.connected ?? [], providerDefaults: prov.default ?? null });
      });
    const results = await Promise.allSettled([discovery, modelServices.refreshAll()]);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length) throw new Error(failures.map(r => errText(r.reason)).join("\n"));
  }

  syncModelServiceCatalogs(): void {
    const services = modelServices.configuredServices();
    if (JSON.stringify(services) === JSON.stringify(this.state.prefs.modelServices ?? [])) return;
    this.mutate(s => ({ prefs: { ...s.prefs, modelServices: services } }));
    this.persistPrefs();
  }

  modelInfo(providerID: string, modelID: string): ModelInfo | null {
    return (
      this.state.providers.find((p) => p.id === providerID)?.models[modelID] ??
      null
    );
  }

  // ---------- drafts ----------

  getDraft(): string {
    return (
      this.state.prefs.drafts[
        draftKey(this.state.activeSessionId, this.state.directory)
      ] ?? ""
    );
  }

  setDraft(text: string): void {
    const key = draftKey(this.state.activeSessionId, this.state.directory);
    this.mutate((s) => ({
      prefs: { ...s.prefs, drafts: { ...s.prefs.drafts, [key]: text } },
    }));
    this.persistPrefs();
  }

  async removeDraftAttachment(id: string): Promise<void> {
    if (this.state.ui.sending) return;
    const scope = attachmentScope(this.state.prefs.workspaceKey ?? this.state.prefs.endpoint, this.state.directory, this.state.activeSessionId);
    await attachmentDrafts.remove(scope, [id]);
    if (scope === attachmentScope(this.state.prefs.workspaceKey ?? this.state.prefs.endpoint, this.state.directory, this.state.activeSessionId))
      this.patchUi({sendError: null});
  }

  private archiveStager(backend: AgentBackend): ArchiveStager {
    const host = backend.id === PI_BACKEND_ID ? undefined : this.currentHost(), endpoint = backend.endpoint;
    let paths: ReturnType<AgentBackend['paths']> | undefined;
    return async file => stageArchive(file, {serverHome: (await (paths ??= backend.paths())).home,
      sshTarget: host?.target, endpoint});
  }

  /** Editing preserves the original conversation and never starts inference implicitly. */
  async prepareEditedBranch(messageID: string, text: string): Promise<void> {
    if (this.editBranchBusy) throw new Error("Ветка уже создаётся.");
    if (!this.conversation().capabilities.fork)
      throw new Error("Этот агент не поддерживает ветвление разговора.");
    const id = this.state.activeSessionId, directory = this.state.directory, engine = this.engineIdFor(), backend = this.engine(engine);
    const generation = this.connectionGeneration, directoryGeneration = this.directoryGeneration;
    const message = id ? this.state.chat.sessions[id]?.messages[messageID] : undefined;
    if (!id || !directory || !text.trim() || message?.role !== "user" || !this.engineReady(engine))
      throw new Error("Откройте исходное сообщение и проверьте подключение.");
    const parts = this.state.chat.sessions[id]?.partsByMessage[messageID] ?? [];
    if (attachmentParts(parts.map(p => this.state.chat.sessions[id].parts[p]).filter((p): p is MessagePart => !!p)).length)
      throw new Error("Сообщение содержит вложения. Отправьте уточнение новым сообщением, чтобы сохранить их.");
    const model = this.getModelChoice(), agent = this.getAgentChoice();
    const current = () => backend === this.engine(engine) && generation === this.connectionGeneration &&
      directoryGeneration === this.directoryGeneration && this.state.activeSessionId === id;
    this.editBranchBusy = true;
    try {
      const [source, statuses, permissions, questions] = await Promise.all([
        backend.getSession(id, directory), backend.sessionStatuses(directory),
        backend.pendingPermissions(directory), backend.pendingQuestions(directory),
      ]);
      if (!current()) throw new Error("Выбран другой чат. Вернитесь к сообщению, чтобы повторить.");
      if (source.directory !== directory || source.time.archived || source.parentID)
        throw new Error("Исходная сессия больше недоступна для редактирования.");
      if ((statuses[id] && statuses[id].type !== "idle") || permissions.some(p => p.sessionID === id) || questions.some(q => q.sessionID === id))
        throw new Error("Дождитесь завершения задачи или ответьте на её вопрос.");
      const fork = await backend.forkSession(id, directory, messageID);
      // OpenCode forks exclude the selected message, but do NOT inherit permission rules.
      const branch = await backend.updateSession(fork.id, {
        title: `${source.title} · правка`, permission: source.permission ?? [],
      }, directory);
      if (backend !== this.engine(engine) || generation !== this.connectionGeneration)
        throw new Error("Подключение изменилось. Ветка сохранена у исходного агента; сообщение не отправлено.");
      this.rememberActivitySession(branch);
      this.updateSidebarSession(branch);
      this.mutate(s => ({ sessions: s.directory === directory ? [...s.sessions.filter(x => x.id !== branch.id), branch] : s.sessions, prefs: { ...s.prefs,
        drafts: { ...s.prefs.drafts, [branch.id]: text },
        modelChoice: { ...s.prefs.modelChoice, ...(model ? { [modelScope(engine, `session:${branch.id}`)]: model } : {}) },
        agentChoice: { ...s.prefs.agentChoice, ...(agent ? { [`session:${branch.id}`]: agent } : {}) },
      } }));
      this.persistPrefs();
      if (current()) {
        await this.selectSession(branch.id);
        this.patchUi({ toast: "Правка в черновике новой ветки. Проверьте её и нажмите «Отправить»." });
      } else this.patchUi({ toast: "Новая ветка с черновиком сохранена. Сообщение ещё не отправлено." });
    } finally { this.editBranchBusy = false; }
  }

  // ---------- execution ----------

  private scheduledLocks = new Set<string>();
  /**
   * One scheduled prompt under the same guards as a manual send. It never consumes
   * the user's draft, files or queue, never answers a permission or question and
   * never substitutes the saved server, chat, model or agent. Read-only checks stop
   * when `signal` aborts; once the prompt is being sent it is neither aborted nor
   * repeated. Throws `ScheduleBlocked` for definite "not sent, needs the user"
   * outcomes; any other throw is uncertain delivery.
   */
  async runScheduledTask(task: ScheduledTask, signal: AbortSignal = new AbortController().signal): Promise<DispatchResult> {
    const waiting = (detail: string): DispatchResult => ({ kind: "waiting", detail });
    const server = this.state.prefs.workspaceKey ?? this.state.prefs.endpoint;
    const pi = task.engine === PI_BACKEND_ID;
    if (task.server !== server) return waiting("Ожидает подключения к исходному серверу");
    if (!pi && (this.state.connection.phase !== "connected" || this.state.connection.streamState !== "open"))
      return waiting("Ожидает подключения к серверу OpenCode");
    if (this.state.ui.sending || this.scheduledLocks.size || this.accessChanging || this.state.ui.workspacePreparing || this.state.ui.runtimeLoading)
      return waiting("Ожидает завершения текущей отправки");
    if (this.engineIdFor(task.sessionID, task.directory) !== task.engine)
      throw new ScheduleBlocked("Агент этого чата изменился. Создайте задание заново для текущего агента.");
    if (!this.engineReady(task.engine as EngineId)) return waiting(pi ? "Pi сейчас недоступен" : "Агент недоступен");
    const backend = this.engine(task.engine as EngineId), gen = this.connectionGeneration;
    const current = () => gen === this.connectionGeneration && this.engineStillActive(backend)
      && server === (this.state.prefs.workspaceKey ?? this.state.prefs.endpoint)
      && this.engineIdFor(task.sessionID, task.directory) === task.engine;
    const blocker = (status: SessionStatus | undefined, permissions: PermissionRequest[], questions: QuestionRequest[]) =>
      chatBlocker(task.sessionID, {
        status, permissions, questions,
        queued: this.getQueue(task.sessionID).length,
        running: this.isRunning(task.sessionID),
        locked: this.queueLocks.has(task.sessionID) || this.compactLocks.has(task.sessionID) || this.modelTransitionLocks.has(task.sessionID),
        dialog: this.state.ui.piDialog?.sessionId === task.sessionID,
      });
    const preparationStarted = Date.now();
    const stopped = this.queueStops.get(task.sessionID) ?? 0;
    let sending = false;
    this.scheduledLocks.add(task.sessionID);
    try {
      const [session, statuses, permissions, questions, providers, agents] = await untilAborted(Promise.all([
        backend.getSession(task.sessionID, task.directory, signal).catch((error: unknown) => {
          // A missing chat is a fact, not a hiccup: OpenCode answers 404; Pi has no record of it.
          if (pi || (error instanceof ApiError && error.status === 404))
            throw new ScheduleBlocked("Чат удалён или больше недоступен. Задание приостановлено.");
          throw error;
        }),
        backend.sessionStatuses(task.directory, signal),
        backend.pendingPermissions(task.directory, signal),
        backend.pendingQuestions(task.directory, signal),
        pi ? null : backend.providers(signal, task.directory),
        pi ? null : backend.agents(signal, task.directory),
      ]), signal);
      if (!current()) return waiting("Подключение изменилось");
      if (session.directory !== task.directory || session.time.archived)
        throw new ScheduleBlocked("Чат архивирован или перенесён в другую папку. Задание приостановлено.");
      const busy = blocker(statuses[task.sessionID], permissions, questions);
      if (busy) return waiting(busy);
      const unavailable = modelProblem(task, providers, agents);
      if (unavailable) throw new ScheduleBlocked(unavailable);
      if (pi) {
        const live = await untilAborted(this.pi().liveModel(task.sessionID), signal);
        const mismatch = live.running ? liveModelProblem(task, live.model) : null;
        if (mismatch) throw new ScheduleBlocked(mismatch);
      }
      if (isNative() && isLocalComputer(this.state.prefs.endpoint, !!this.currentHost()) && browserEnabled(this.state.prefs)) {
        // OpenCode needs this directory's MCP attachment; Pi only the installed runtime it loads itself.
        const status = await untilAborted(this.configureBrowser(false, false, pi ? null : task.directory), signal);

        if (pi ? !status : browserSetupSnapshot().phase === "error")
          throw new ScheduleBlocked("Браузерные инструменты не подключились; запрос не отправлен. Проверьте «Настройки → Браузер» и возобновите задание.");
      }
      // Browser setup can take time. Re-check authoritative interaction state before dispatch.
      if (!pi) await untilAborted(this.configureSharedTools(task.directory, signal), signal);
      this.assertContextReady(task.sessionID, task.model.providerID, task.model.modelID, task.engine);
      await untilAborted(modelServices.ensure(task.model.providerID, task.model.modelID, task.engine, {signal, context: task.sessionID}), signal);
      const [freshStatus, freshPermissions, freshQuestions] = await untilAborted(Promise.all([
        backend.sessionStatuses(task.directory, signal), backend.pendingPermissions(task.directory, signal), backend.pendingQuestions(task.directory, signal),
      ]), signal);
      if (!current() || this.state.ui.sending) return waiting("Подключение или текущая отправка изменились");
      const late = blocker(freshStatus[task.sessionID], freshPermissions, freshQuestions);
      if (late) return waiting(late);
      if (signal.aborted || (this.queueStops.get(task.sessionID) ?? 0) !== stopped) return { kind: "cancelled" };
      // Use the model/agent the user explicitly saved with this task, including its reasoning variant.
      // No signal: a prompt that may have been delivered is never abandoned as if it was not.
      const seq = this.statusSequence;
      try {
        await untilAborted(modelServices.reserve(task.model.providerID, task.model.modelID, task.engine, task.sessionID, signal), signal);
        if (!current() || signal.aborted || (this.queueStops.get(task.sessionID) ?? 0) !== stopped) return { kind: "cancelled" };
        const messageID = newMessageId(), dispatchAt = Date.now();
        (this.state.chat.sessions[task.sessionID] ??= emptySessionChat()).pendingTiming = {
          ...(pi ? {} : {messageID}), dispatchAt, preparationMs: dispatchAt - preparationStarted, queueMs: null,
        };
        await operationJournal.dispatch({ id: messageID, workspace: server, engine: task.engine, sessionId: task.sessionID, directory: task.directory, source: "schedule", sourceId: task.id, text: task.prompt, model: `${task.model.providerID}/${task.model.modelID}`, attachments: null },
          () => current() && !signal.aborted && (this.queueStops.get(task.sessionID) ?? 0) === stopped, async () => {
        if (!pi) await ownWork(backend.endpoint, task.directory, task.sessionID, messageID, this.client.headers.Authorization);
        if (!current() || signal.aborted || (this.queueStops.get(task.sessionID) ?? 0) !== stopped) throw new NotDispatched("Отправка отменена.");
        await stageImagePromptContext({engine:task.engine,sessionId:task.sessionID,directory:task.directory,messageId:messageID,parts:[],automatic:true,
          supportsVision:!!(pi ? piModelInfo(this.state.piHealth,task.model) : this.modelInfo(task.model.providerID,task.model.modelID))?.capabilities?.input?.image,
          local:pi || isLocalComputer(this.state.prefs.endpoint,!!this.currentHost())});
        if (!current() || signal.aborted || (this.queueStops.get(task.sessionID) ?? 0) !== stopped) throw new NotDispatched("Отправка отменена.");
        sending = true;
        await backend.prompt(task.sessionID, task.directory, {
          messageID, model: { providerID: task.model.providerID, modelID: task.model.modelID },
          variant: task.model.variant ?? undefined, agent: task.agent, parts: agentParts(this.state.prefs.workshop, task.sessionID, task.directory, [{ type: "text", text: task.prompt }, {type:"text",text:scheduleWakeReminder(task.sessionID,task.id),synthetic:true,metadata:{enkiScheduleWake:1}}]),
        });
        });
      } catch (error) {
        // The server answered with a refusal, so it accepted nothing. Its body is not kept.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408)
          throw new ScheduleBlocked(`OpenCode отклонил запрос (HTTP ${error.status}). Проверьте чат, модель и агента; затем возобновите задание.`);
        throw error;
      }
      if (current() && (this.statusVersions.get(task.sessionID) ?? 0) <= seq)
        this.observeSessionStatus(task.sessionID, { type: "busy" }, task.directory);
      return { kind: "sent" };
    } catch (error) {
      if (sending || error instanceof ScheduleBlocked) throw error;
      // A read-only check failed or was withdrawn: nothing was sent, so trying later is safe.
      return signal.aborted ? { kind: "cancelled" } : waiting("Не удалось проверить состояние чата; запрос не отправлен. Повторная проверка позже.");
    } finally {
      this.scheduledLocks.delete(task.sessionID);
      // A user prompt queued meanwhile must not wait for the next status event.
      if (task.sessionID === this.state.activeSessionId) void this.drainQueue();
    }
  }

  async sendPrompt(text: string, attachments: DraftAttachment[] = [], onProgress: (label: string) => void = () => {}): Promise<boolean> {
    if (
      !this.engineReady() ||
      (this.engineIdFor() !== PI_BACKEND_ID && !!this.state.connection.statusError) ||
      (!text.trim() && !attachments.length) ||
      this.state.ui.sending ||
      this.state.ui.workspacePreparing ||
      this.state.ui.runtimeLoading
    )
      return false;
    if (this.compactLocks.has(this.state.activeSessionId ?? "") || this.modelTransitionLocks.has(this.state.activeSessionId ?? "")) {
      this.patchUi({ sendError: "Дождитесь завершения сжатия контекста. Черновик сохранён." });
      return false;
    }
    if (this.scheduledLocks.has(this.state.activeSessionId ?? "")) {
      // Never interleave with a scheduled prompt for the same chat; the draft stays as typed.
      this.patchUi({ sendError: "Сейчас проверяется или отправляется запланированное задание этого чата. Черновик сохранён — отправьте его через несколько секунд." });
      return false;
    }
    const initialScope = attachmentScope(this.state.prefs.workspaceKey ?? this.state.prefs.endpoint, this.state.directory, this.state.activeSessionId);
    if (!this.state.directory && !(await this.ensureChatWorkspace()))
      return false;
    const directory = this.state.directory;
    if (
      !directory ||
      (!text.trim() && !attachments.length) ||
      this.state.ui.sending ||
      this.accessChanging
    )
      return false;
    // Capture the full request identity before any await: it must never be re-read after
    // the user switched project/session mid-flight (R3), and the draft slot is revision-bound (R5).
    const preparationStarted = Date.now();
    const gen = this.directoryGeneration;
    const endpoint = this.backend.endpoint;
    // The engine is resolved once, from the chat being composed: a folder switch
    // mid-flight must not redirect an accepted prompt to a different agent.
    const engineId = this.engineIdFor();
    const backend = this.engine(engineId);
    const referenceImages = isNative() && (engineId === PI_BACKEND_ID || isLocalComputer(this.state.prefs.endpoint, !!this.currentHost()));
    const selected = this.state.activeSessionId;
    const sentAtStatus = this.statusSequence;
    const status = selected ? this.activityStatus(selected) : null;
    if (status?.type === "busy" || status?.type === "retry") return false;
    const slotKey = draftKey(this.state.activeSessionId, directory);
    const model = this.getModelChoice(engineId);
    if (!model) {
      this.patchUi({
        sendError:
          engineId === PI_BACKEND_ID
            ? "У Pi нет настроенной модели. Откройте «Настройки → Pi» и проверьте каталог моделей."
            : "No connected model is available. Check provider configuration in OpenCode.",
      });
      return false;
    }
    const agent = this.getAgentChoice();
    const trimmed = text.trim() || "Проанализируй приложенные файлы.";
    const modelInfo =
      engineId === PI_BACKEND_ID
        ? piModelInfo(this.state.piHealth, model)
        : this.modelInfo(model.providerID, model.modelID);
    if (attachments.length && !this.conversation().capabilities.attachments) {
      this.patchUi({ sendError: "Этот агент не принимает вложения." });
      return false;
    }
    if (attachments.length && !modelInfo) { this.patchUi({ sendError: "Выбранная модель больше не доступна." }); return false; }
    let scope = attachmentScope(this.state.prefs.workspaceKey ?? this.state.prefs.endpoint, directory, selected);
    const operation = this.beginSending();
    const sameContext = () =>
      this.submissions.owns(operation) &&
      this.engineStillActive(backend) &&
      gen === this.directoryGeneration &&
      this.state.directory === directory &&
      this.backend.endpoint === endpoint;
    let sessionId = this.state.activeSessionId;
    try {
      if (attachments.length) attachments = await attachmentDrafts.selected(initialScope, attachments.map(file => file.id));
      if (!text.trim() && !attachments.length) return false;
      this.assertContextReady(selected, model.providerID, model.modelID, engineId);
      await untilAborted(modelServices.ensure(model.providerID, model.modelID, engineId, {signal: operation.signal, context: selected ?? `@draft:${directory}`}), operation.signal);
      if (!sameContext() || this.state.activeSessionId !== selected) return false;
      if (attachments.length && scope !== initialScope) await attachmentDrafts.move(initialScope, scope);
      // Do not submit the first prompt before its directory's MCP is attached.
      if (isNative() && isLocalComputer(this.state.prefs.endpoint, !!this.currentHost()) && browserEnabled(this.state.prefs)) {
        onProgress("Подключение браузерных инструментов…");
        await this.configureBrowser(browserSetupSnapshot().phase === "error");

        if (browserSetupSnapshot().phase === "error") throw new Error(browserSetupSnapshot().error || "Браузер не подключён.");
        if (!sameContext() || this.state.activeSessionId !== selected) return false;
      }
      if (engineId !== PI_BACKEND_ID) await this.configureSharedTools(directory);
      if (!sameContext() || this.state.activeSessionId !== selected) return false;
      const parts = attachments.length && modelInfo
        ? await prepareAttachments(attachments, engineId === PI_BACKEND_ID ? { ...modelInfo, capabilities: { ...modelInfo.capabilities, input: { ...modelInfo.capabilities?.input, pdf: false, audio: false, video: false } } } : modelInfo, this.state.prefs.helperEndpoint ?? DEFAULT_HELPER_ENDPOINT, this.state.prefs.asr ?? { endpoint: "", model: "", language: "" }, operation.signal, onProgress, this.archiveStager(backend), {imageReferences:referenceImages})
        : [];
      if (!sameContext() || this.state.activeSessionId !== selected)
        throw new Error("Чат изменился во время подготовки вложений. Вложения остались в черновике.");
      if (!sessionId) {
        const created = await backend.createSession({
          directory,
          title: trimmed.slice(0, 60),
          permission: accessRules(this.state.prefs.newAccess ?? "inherit"),
          ...(engineId === PI_BACKEND_ID
            ? {}
            : {
                agent: agent ?? undefined,
                model: {
                  id: model.modelID,
                  providerID: model.providerID,
                  variant: model.variant ?? undefined,
                },
              }),
        });
        if (!sameContext() || this.state.activeSessionId !== selected)
          return false; // selection changed during creation
        sessionId = created.id;
        operation.sessionID = created.id;
        this.rememberActivitySession(created);
        this.mutate((s) => {
          const drafts = { ...s.prefs.drafts };
          if (drafts[slotKey] !== undefined) { drafts[created.id] = drafts[slotKey]; delete drafts[slotKey]; }
          return {
            sessions: [created, ...s.sessions.filter((x) => x.id !== created.id)],
            activeSessionId: created.id,
            prefs: {
              ...s.prefs,
              drafts,
              // The chat's engine is pinned at creation and survives restarts.
              sessionEngine: { ...s.prefs.sessionEngine, [created.id]: engineId },
              lastSessionByDir: {
                ...s.prefs.lastSessionByDir,
                [directory]: created.id,
              },
            },
          };
        });
        this.persistPrefs();
        if (attachments.length) {
          const nextScope = attachmentScope(this.state.prefs.workspaceKey ?? this.state.prefs.endpoint, directory, created.id);
          await attachmentDrafts.move(scope, nextScope);
          scope = nextScope;
        }
      }
      if (!sameContext() || this.state.activeSessionId !== sessionId) return false;
      const target = sessionId;
      await untilAborted(modelServices.reserve(model.providerID, model.modelID, engineId, target, operation.signal), operation.signal);
      if (!sameContext() || operation.signal.aborted || this.state.activeSessionId !== target) return false;
      const messageID = newMessageId();
      const dispatchAt = Date.now();
      (this.state.chat.sessions[target] ??= emptySessionChat()).pendingTiming = {
        ...(engineId === PI_BACKEND_ID ? {} : {messageID}), dispatchAt,
        preparationMs: dispatchAt - preparationStarted, queueMs: 0,
      };
      await operationJournal.dispatch({ id: messageID, workspace: this.state.prefs.workspaceKey ?? endpoint, engine: engineId, sessionId: target, directory, source: "manual", sourceId: null, text: trimmed, model: `${model.providerID}/${model.modelID}`, attachments: attachments.length ? { scope, files: attachments.map(({id,name,mime,size}) => ({id,name,mime,size})) } : null },
        () => sameContext() && this.state.activeSessionId === target && !operation.signal.aborted, async () => {
      if (engineId !== PI_BACKEND_ID) await ownWork(backend.endpoint, directory, target, messageID, this.client.headers.Authorization);
      if (!sameContext() || operation.signal.aborted) throw new NotDispatched("Отправка отменена.");
      await stageImagePromptContext({engine:engineId,sessionId:target,directory,messageId:messageID,parts,supportsVision:!!modelInfo?.capabilities?.input?.image,
        local:referenceImages});
      if (!sameContext() || operation.signal.aborted) throw new NotDispatched("Отправка отменена.");
      this.submissions.dispatched(operation);
      await backend.prompt(target, directory, {
        messageID,
        model: { providerID: model.providerID, modelID: model.modelID },
        agent: agent ?? undefined,
        variant: model.variant ?? undefined,
        parts: agentParts(this.state.prefs.workshop, target, directory, [{ type: "text", text: trimmed }, ...imagePromptParts(parts,!!modelInfo?.capabilities?.input?.image,referenceImages)]),
      });
      });
      if (attachments.length) {
        try { await attachmentDrafts.remove(scope, attachments.map(file => file.id)); }
        catch { if (sameContext()) this.patchUi({ toast: "Запрос отправлен, но вложения не удалось убрать из черновика. Удалите их вручную перед следующим запросом." }); }
      }
      if (!sameContext()) return true;
      // Accepted: clear only the exact draft revision we submitted, in its original slot.
      // Anything typed while awaiting acknowledgement stays untouched (R5).
      this.mutate((s) => {
        const drafts = { ...s.prefs.drafts };
        if (drafts[slotKey] === text) delete drafts[slotKey];
        if (!selected && drafts[target] === text) delete drafts[target];
        if (
          this.isProjectlessDirectory(directory) &&
          drafts[draftKey(null, null)] === text
        )
          delete drafts[draftKey(null, null)];
        const prev = s.chat.sessions[target] ?? emptySessionChat();
        const chat: ChatRootState = {
          ...s.chat,
          sessions: {
            ...s.chat.sessions,
            [target]: {
              ...prev,
              status:
                (this.statusVersions.get(target) ?? 0) > sentAtStatus
                  ? prev.status
                  : { type: "busy" },
            },
          },
        };
        return { prefs: { ...s.prefs, drafts }, chat };
      });
      this.persistPrefs();
      return true;
    } catch (e) {
      // Ambiguous outcome: never auto-resend. The draft was never cleared, so the user decides.
      if (sameContext() && this.state.activeSessionId === sessionId) this.patchUi({ sendError: errText(e) });
      return false;
    } finally {
      if (this.finishSending(operation)) {
        onProgress("");
        void this.drainQueue();
      }
    }
  }

  /** Pagination uses the server-provided opaque X-Next-Cursor, never a message ID. */
  async loadOlderMessages(sessionId: string): Promise<void> {
    const directory = this.state.directory;
    if (!directory || this.state.ui.historyLoading) return;
    const cursor = this.state.historyCursors[sessionId];
    if (!cursor) return;
    const gen = this.directoryGeneration;
    this.patchUi({ historyLoading: true, historyError: null });
    try {
      const { messages, before } = await this.engine(
        this.engineIdFor(sessionId, directory),
      ).messages(sessionId, {
        directory,
        limit: 200,
        before: cursor,
      });
      if (
        gen !== this.directoryGeneration ||
        this.state.activeSessionId !== sessionId
      )
        return;
      this.mutate((s) => {
        const chat: ChatRootState = {
          ...s.chat,
          sessions: { ...s.chat.sessions },
        };
        prependHistory(chat, sessionId, messages);
        return {
          chat,
          historyCursors: { ...s.historyCursors, [sessionId]: before ?? null },
          olderExhausted: {
            ...s.olderExhausted,
            [sessionId]: !before || before === cursor,
          },
        };
      });
    } catch (e) {
      if (gen === this.directoryGeneration)
        this.patchUi({ historyError: errText(e) });
    } finally {
      if (gen === this.directoryGeneration)
        this.patchUi({ historyLoading: false });
    }
  }

  /** Remembers which shell this app created per project, so we never hijack a foreign PTY. */
  setPtyId(directory: string, id: string | null): void {
    this.mutate((s) => {
      const ptyIds = { ...s.prefs.ptyIds };
      if (id) ptyIds[directory] = id;
      else delete ptyIds[directory];
      return { prefs: { ...s.prefs, ptyIds } };
    });
    this.persistPrefs();
  }

  async stopSession(sessionId: string): Promise<void> {
    if (this.submissions.cancel(sessionId)) this.patchUi({ sending: false });
    this.queueStops.set(sessionId, (this.queueStops.get(sessionId) ?? 0) + 1);
    this.queueArmed.delete(sessionId);
    // Abort is directory-scoped: a session started in another project must be
    // stopped with *its* directory, not whichever project is open right now.
    const directory =
      this.activityDirectories.get(sessionId) ?? this.state.directory;
    if (!directory) return;
    try {
      if (this.state.ui.piDialog?.sessionId === sessionId)
        await this.answerPiDialog({ cancelled: true }).catch(() => {});
      await this.engine(this.engineIdFor(sessionId, directory)).abort(
        sessionId,
        directory,
      );
    } catch (e) {
      this.patchUi({ toast: `Stop failed: ${errText(e)}` });
    }
  }
  cancelPreparation(): void {
    if (this.submissions.cancelPreparing()) this.patchUi({ sending: false });
  }

  async compactSession(sessionId: string): Promise<void> {
    const directory = this.state.directory;
    const model = this.getModelChoice();
    if (
      !directory ||
      sessionId !== this.state.activeSessionId ||
      this.state.ui.sending ||
      !model ||
      !this.conversation().capabilities.compaction ||
      this.isRunning(sessionId) ||
      this.compactLocks.has(sessionId) || this.modelTransitionLocks.has(sessionId)
    )
      return;
    this.compactLocks.add(sessionId);
    const generation = this.connectionGeneration;
    try {
      const engine = this.engineIdFor(sessionId, directory), backend = this.conversation();
      if (engine !== PI_BACKEND_ID && this.transferNeeded(sessionId, model.providerID, model.modelID)) {
        // Release the outer guard: transferContext owns the same session lock.
        this.compactLocks.delete(sessionId);
        await this.transferContext(sessionId, directory, model.providerID, model.modelID,
          () => generation === this.connectionGeneration && directory === this.state.directory && sessionId === this.state.activeSessionId,
          message => this.patchUi({toast: message}));
        this.patchUi({toast: 'Контекст сжат предыдущей моделью. Можно продолжать работу.'});
        return;
      }
      await modelServices.ensure(model.providerID, model.modelID, engine, { context: sessionId });
      const current = this.getModelChoice();
      if (generation !== this.connectionGeneration || current?.providerID !== model.providerID || current?.modelID !== model.modelID
        || directory !== this.state.directory || sessionId !== this.state.activeSessionId
        || engine !== this.engineIdFor(sessionId, directory) || this.isRunning(sessionId) || this.state.ui.sending)
        throw new Error("Состояние сессии изменилось; сжатие отменено.");
      await backend.summarize(
        sessionId,
        directory,
        model.providerID,
        model.modelID,
      );
      this.patchUi({ toast: "Запрос на сжатие контекста отправлен." });
    } catch (e) {
      this.patchUi({ toast: `Не удалось сжать контекст: ${errText(e)}` });
    } finally {
      this.compactLocks.delete(sessionId);
    }
  }

  isRunning(id = this.state.activeSessionId): boolean {
    const status = id ? this.activityStatus(id) : null;
    return status?.type === "busy" || status?.type === "retry";
  }

  contextInfo() {
    const choice = this.getModelChoice();
    const isPi = this.engineIdFor() === PI_BACKEND_ID;
    const chat = this.state.activeSessionId
      ? this.state.chat.sessions[this.state.activeSessionId]
      : undefined;
    return contextUsage(
      chat,
      choice && (isPi
        ? piModelInfo(this.state.piHealth, choice)
        : this.modelInfo(choice.providerID, choice.modelID)),
      isPi ? { auto: false } : this.state.compaction,
    );
  }

  getAccessMode() {
    const session = this.activeSession();
    return session
      ? accessMode(session.permission)
      : (this.state.prefs.newAccess ?? "inherit");
  }
  async setAccessMode(mode: AccessMode) {
    if (this.isRunning() || this.state.ui.sending || this.accessChanging) {
      this.patchUi({ toast: "Остановите ответ, чтобы изменить режим доступа." });
      return;
    }
    const id = this.state.activeSessionId,
      directory = this.state.directory,
      backend = this.conversation(), generation = this.connectionGeneration;
    if (!id) {
      this.mutate((s) => ({ prefs: { ...s.prefs, newAccess: mode } }));
      this.persistPrefs();
      return;
    }
    this.accessChanging = true;
    try {
      const updated = await backend.updateSession(
        id,
        { permission: accessRules(mode) },
        directory,
      );
      if (generation === this.connectionGeneration && this.engineStillActive(backend) && directory === this.state.directory) {
        this.rememberActivitySession(updated);
        this.mutate((s) => ({
          sessions: s.sessions.map((x) => (x.id === id ? updated : x)),
        }));
      }
    } catch (e) {
      this.patchUi({ toast: `Не удалось изменить доступ: ${errText(e)}` });
    } finally {
      this.accessChanging = false;
    }
  }

  setAsr(settings: AsrSettings) {
    this.mutate((s) => ({ prefs: { ...s.prefs, asr: settings } }));
    this.persistPrefs();
  }
  setHubModels(state: import("../models/catalog").HubModelsPrefs) {
    this.mutate((s) => ({ prefs: { ...s.prefs, hubModels: state } }));
    this.persistPrefs();
  }
  setModelServices(services: ModelService[]) {
    modelServices.configure(services);
    this.mutate(s => ({ prefs: { ...s.prefs, modelServices: modelServices.configuredServices() } }));
    this.persistPrefs();
  }
  setHelperEndpoint(endpoint: string) {
    this.mutate((s) => ({ prefs: { ...s.prefs, helperEndpoint: endpoint } }));
    this.persistPrefs();
  }
  /** Dictation is bound to its original draft even if navigation occurs meanwhile. */
  appendDictation(workspace: string, key: string, text: string, receipt?: string) {
    if (receipt && this.state.prefs.dictationReceipts?.includes(receipt)) {
      savePrefs(this.state.prefs);
      if (!flushPrefs()) throw Error("Не удалось сохранить текст диктовки. Звук оставлен для восстановления.");
      return;
    }
    if (!text.trim() && !receipt) return;
    this.mutate((s) => {
      const prefs = receipt ? {...s.prefs,dictationReceipts:[...(s.prefs.dictationReceipts??[]).slice(-1999),receipt]} : s.prefs;
      if ((s.prefs.workspaceKey ?? s.prefs.endpoint) === workspace)
        return {
          prefs: {
            ...prefs,
            drafts: {
              ...s.prefs.drafts,
              [key]: [s.prefs.drafts[key], text].filter(Boolean).join(" "),
            },
          },
        };
      const old = s.prefs.endpointState?.[workspace];
      return {
        prefs: {
          ...prefs,
          endpointState: {
            ...s.prefs.endpointState,
            [workspace]: {
              ...old,
              drafts: {
                ...old?.drafts,
                [key]: [old?.drafts?.[key], text].filter(Boolean).join(" "),
              },
            },
          },
        },
      };
    });
    if (receipt) {
      savePrefs(this.state.prefs);
      if (!flushPrefs()) throw Error("Не удалось сохранить текст диктовки. Звук оставлен для восстановления.");
    } else this.persistPrefs();
  }

  getQueue(id = this.state.activeSessionId): QueuedPrompt[] { return this.promptQueue.getQueue(id); }
  isQueueArmed(id = this.state.activeSessionId): boolean { return this.promptQueue.isQueueArmed(id); }
  enqueuePrompt(text: string, attachments?: QueuedPrompt["attachments"], captured?: Pick<QueuedPrompt, "model" | "agent">): boolean {
    return this.promptQueue.enqueuePrompt(text, attachments, captured);
  }
  enqueueWithAttachments(text: string, files: DraftAttachment[]): Promise<boolean> { return this.promptQueue.enqueueWithAttachments(text, files); }
  reorderQueued(id: string, before: string | null): boolean { return this.promptQueue.reorderQueued(id, before); }
  removeQueued(id: string): Promise<void> { return this.promptQueue.removeQueued(id); }
  isQueueLocked(): boolean { return this.promptQueue.isQueueLocked(); }
  removeQueuedAttachment(id: string, fileID: string): Promise<void> { return this.promptQueue.removeQueuedAttachment(id, fileID); }
  getQueueEdit() { return this.promptQueue.getQueueEdit(); }
  editQueued(id: string) { return this.promptQueue.editQueued(id); }
  cancelQueueEdit(): Promise<void> { return this.promptQueue.cancelQueueEdit(); }
  applyQueueEdit(text: string, files: DraftAttachment[], drain = true): Promise<boolean> { return this.promptQueue.applyQueueEdit(text, files, drain); }
  resumeQueue(useSelectedModel = false): void { this.promptQueue.resumeQueue(useSelectedModel); }
  queueRecoveryReason(): string | null { return this.promptQueue.queueRecoveryReason(); }
  queueHasDifferentModel(): boolean { return this.promptQueue.queueHasDifferentModel(); }
  steerQueued(id: string): Promise<void> { return this.promptQueue.steerQueued(id); }
  attentionItems(): {id:string; directory:string; title:string; reason:string}[] {
    const out = new Map<string,{id:string;directory:string;title:string;reason:string}>();
    const add = (id:string, reason:string, directory?:string) => {
      const session = this.activitySessions.get(id) ?? this.state.sessions.find(s=>s.id===id);
      const dir = directory ?? session?.directory ?? this.state.prefs.piSessions?.[id]?.directory;
      if (!dir) return;
      const old=out.get(id);
      out.set(id,{id,directory:dir,title:session?.title ?? this.state.prefs.piSessions?.[id]?.title ?? id,reason:old?`${old.reason} · ${reason}`:reason});
    };
    for (const [id,chat] of Object.entries(this.state.chat.sessions)) if(chat.lastError) add(id,chat.lastError);
    const pending=new Set([...Object.values(this.state.chat.permissions),...Object.values(this.state.chat.questions)].map(p=>p.sessionID));
    for(const id of pending) add(id,'Требуется ваш ответ');
    for(const d of this.piDialogs) add(d.sessionId,'Разрешение Pi',d.directory);
    for(const [id,queue] of Object.entries(this.state.prefs.queues??{})) if(queue.length&&(!this.isRunning(id)||queue.some(q=>q.error||q.state==='uncertain')))
      add(id,queue.find(q=>q.error)?.error??`В очереди: ${queue.length}`,queue[0].directory);
    return [...out.values()];
  }
  async openAttentionChat(id:string,directory:string):Promise<void> {
    const workspace=this.state.prefs.workspaceKey??this.state.prefs.endpoint;
    const session=this.activitySessions.get(id)??this.state.sessions.find(s=>s.id===id)
      ?? await this.engine(this.engineIdFor(id,directory)).getSession(id,directory);
    if(workspace!==(this.state.prefs.workspaceKey??this.state.prefs.endpoint))throw Error('Компьютер изменился.');
    if(!session)throw Error('Чат не найден у агента.');
    await this.openChat(session);
  }
  async restoreOperationDraft(record:Operation):Promise<string> {
    if(record.workspace!==(this.state.prefs.workspaceKey??this.state.prefs.endpoint))throw Error('Подключитесь к исходному компьютеру.');
    if(!['prepared','cancelled','refused'].includes(record.state))throw Error('Сначала проверьте доставку.');
    if(this.state.prefs.recoveredOperations?.includes(record.id)){savePrefs(this.state.prefs);if(!flushPrefs())throw Error('Не удалось сохранить черновик.');return 'Запрос уже возвращён в черновик.';}
    const scope=attachmentScope(record.workspace,record.directory,record.sessionId);
    if(record.attachments)await attachmentDrafts.copy(record.attachments.scope,scope,record.attachments.files.map(f=>f.id));
    if(record.workspace!==(this.state.prefs.workspaceKey??this.state.prefs.endpoint))throw Error("Компьютер изменился. Вложения сохранены в исходном чате.");
    const key=draftKey(record.sessionId,record.directory);
    this.mutate(s=>({prefs:{...s.prefs,recoveredOperations:[...(s.prefs.recoveredOperations??[]),record.id],drafts:{...s.prefs.drafts,[key]:[s.prefs.drafts?.[key],record.text].filter(Boolean).join('\n\n')}}}));
    savePrefs(this.state.prefs);if(!flushPrefs())throw Error('Не удалось сохранить черновик.');
    if(record.state==='prepared')await operationJournal.cancelPrepared(record);
    return 'Запрос возвращён в черновик исходного чата. Он не отправлен.';
  }
  async reconcileOperation(record: Operation): Promise<string> {
    const workspace = this.state.prefs.workspaceKey ?? this.state.prefs.endpoint;
    if (workspace !== record.workspace) throw Error("Подключитесь к исходному компьютеру.");
    if (record.engine === PI_BACKEND_ID) return "Pi не подтверждает исходный ID отправки. Проверьте историю чата вручную; повторной отправки не было.";
    const backend = this.engine(this.engineIdFor(record.sessionId, record.directory));
    if (backend.id !== record.engine) throw Error("Агент чата изменился.");
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await backend.messages(record.sessionId, { directory: record.directory, limit: 200, before });
      if (workspace !== (this.state.prefs.workspaceKey ?? this.state.prefs.endpoint)) throw Error("Подключение изменилось.");
      if (result.messages.some(message => message.info.id === record.id && message.info.role === "user")) {
        await operationJournal.confirm(record, true);
        if (record.source === "queue" && record.sourceId) {
          this.writeQueue(record.sessionId, this.getQueue(record.sessionId).filter(item => item.id !== record.sourceId));
          savePrefs(this.state.prefs); flushPrefs();
        }
        return "Доставка подтверждена историей агента. Повторной отправки не было.";
      }
      if (!result.before || result.before === before) break;
      before = result.before;
    }
    return "Доставка не подтверждена. Проверьте историю чата; запрос не отправлялся повторно.";
  }

  private drainQueue(): Promise<void> { return this.promptQueue.drainQueue(); }
  private writeQueue(id: string, list: QueuedPrompt[]): void { this.promptQueue.writeQueue(id, list); }
  private releaseQueueLock(sid: string): void { this.promptQueue.releaseQueueLock(sid); }

  private async dispatchQueued(item: QueuedPrompt, steer: boolean) {
    const sid = item.sessionID, engineId = this.engineIdFor(sid, item.directory),
      backend = this.engine(engineId), workspaceBackend = this.backend,
      gen = this.selectionGeneration;
    const current = () => gen === this.selectionGeneration && workspaceBackend === this.backend
      && sid === this.state.activeSessionId && item.directory === this.state.directory
      && engineId === this.engineIdFor();
    if (
      this.queueLocks.has(sid) ||
      this.scheduledLocks.has(sid) ||
      this.compactLocks.has(sid) || this.modelTransitionLocks.has(sid) ||
      this.state.ui.sending ||
      this.accessChanging ||
      sid !== this.state.activeSessionId ||
      this.state.directory !== item.directory ||
      !this.engineReady(engineId) ||
      (engineId !== PI_BACKEND_ID && !!this.state.connection.statusError)
    ) {
      if (sid === this.state.activeSessionId && item.directory === this.state.directory)
        this.patchUi({toast: this.state.connection.statusError
          ? 'Не удалось проверить состояние чата. Восстановите подключение; запрос сохранён.'
          : 'В этом чате идёт другая операция. Запрос сохранён в очереди.'});
      return;
    }
    if (!steer && this.isRunning(sid)) return;
    const pending = this.pendingInteraction(sid);
    if (pending.permissions.length || pending.questions.length) {
      this.patchUi({ toast: "Сначала ответьте на запрос агента." });
      return;
    }
    this.queueLocks.add(sid);
    this.patchUi({sendError: null});
    this.writeQueue(
      sid,
      this.getQueue(sid).map((x) =>
        x.id === item.id ? { ...x, state: "sending", error: undefined } : x,
      ),
    );
    savePrefs(this.state.prefs);
    const preparationStarted = Date.now();
    const seq = this.statusSequence;
    const stopped = this.queueStops.get(sid) ?? 0;
    let posted = false;
    let waitingBeforePost = false;
    const defer = () => this.writeQueue(sid, this.getQueue(sid).map(q =>
      q.id === item.id ? { ...q, state: "ready", error: undefined } : q));
    const mustWait = () => {
      const pending = this.pendingInteraction(sid);
      return (!steer && this.isRunning(sid)) || pending.permissions.length > 0 || pending.questions.length > 0;
    };
    try {
      if (!flushPrefs()) throw new Error("Не удалось сохранить состояние очереди. Запрос не отправлен.");
      // OpenCode persists a new user message, then joins the existing run loop.
      // No abort: the correction is seen at the next model/tool boundary.
      this.assertContextReady(sid, item.model.providerID, item.model.modelID, this.engineIdFor(sid, item.directory));
      await modelServices.ensure(item.model.providerID, item.model.modelID, this.engineIdFor(sid, item.directory), {context: sid});
      if (!current()) throw new Error("Чат изменился; запрос не отправлен.");
      const parts: Awaited<ReturnType<typeof prepareAttachments>> = [];
      const imageModelInfo = engineId === PI_BACKEND_ID ? piModelInfo(this.state.piHealth,item.model) : this.modelInfo(item.model.providerID,item.model.modelID);
      const referenceImages = isNative() && (engineId === PI_BACKEND_ID || isLocalComputer(this.state.prefs.endpoint,!!this.currentHost()));
      if (item.attachments?.files.length) {
        if (!backend.capabilities.attachments) throw new Error("Этот агент не принимает вложения.");
        const info = engineId === PI_BACKEND_ID ? piModelInfo(this.state.piHealth, item.model) : this.modelInfo(item.model.providerID, item.model.modelID);
        if (!info) throw new Error("Выбранная модель больше не доступна.");
        await attachmentDrafts.ensure(item.attachments.scope);
        const stored = attachmentDrafts.snapshot(item.attachments.scope);
        const files = item.attachments.files.map(meta => stored.find(file => file.id === meta.id));
        if (files.some(file => !file)) throw new Error("Вложения очереди не найдены. Верните запрос в черновик и приложите файлы заново.");
        parts.push(...await prepareAttachments(files as DraftAttachment[], engineId === PI_BACKEND_ID
          ? { ...info, capabilities: { ...info.capabilities, input: { ...info.capabilities?.input, pdf: false, audio: false, video: false } } } : info,
          this.state.prefs.helperEndpoint ?? DEFAULT_HELPER_ENDPOINT, this.state.prefs.asr ?? { endpoint: "", model: "", language: "" }, new AbortController().signal, undefined, this.archiveStager(backend), {imageReferences:referenceImages}));
      }
      if (!current()) throw new Error("Чат изменился; запрос не отправлен.");
      // These are waits, not delivery failures: no POST has happened. Keep
      // the queue armed so the next idle/interaction event can dispatch once.
      if ((this.queueStops.get(sid) ?? 0) !== stopped) throw Error('Отправка отменена кнопкой «Стоп». Запрос остался в очереди.');
      if (mustWait()) { defer(); return; }
      const messageID = newMessageId(), dispatchAt = Date.now();
      await modelServices.reserve(item.model.providerID, item.model.modelID, engineId, sid);
      if (!current() || (this.queueStops.get(sid) ?? 0) !== stopped) throw new Error("Отправка отменена.");
      if (mustWait()) { defer(); return; }
      (this.state.chat.sessions[sid] ??= emptySessionChat()).pendingTiming = {
        ...(this.engineIdFor(sid, item.directory) === PI_BACKEND_ID ? {} : {messageID}), dispatchAt,
        preparationMs: dispatchAt - preparationStarted,
        queueMs: typeof item.queuedAt === 'number' && preparationStarted >= item.queuedAt ? preparationStarted - item.queuedAt : null,
      };
      const submit = steer && backend.steer ? backend.steer.bind(backend) : backend.prompt.bind(backend);
      await operationJournal.dispatch({ id: messageID, workspace: this.state.prefs.workspaceKey ?? this.state.prefs.endpoint, engine: engineId, sessionId: sid, directory: item.directory, source: "queue", sourceId: item.id, text: item.text, model: `${item.model.providerID}/${item.model.modelID}`, attachments: item.attachments ?? null },
        () => current() && (this.queueStops.get(sid) ?? 0) === stopped, async () => {
      if (engineId !== PI_BACKEND_ID) await ownWork(backend.endpoint, item.directory, sid, messageID, this.client.headers.Authorization);
      if (!current() || (this.queueStops.get(sid) ?? 0) !== stopped) throw new NotDispatched("Отправка отменена.");
      if (mustWait()) {
        waitingBeforePost = true;
        throw new NotDispatched("Ожидаем завершения текущего действия агента.");
      }
      await stageImagePromptContext({engine:engineId,sessionId:sid,directory:item.directory,messageId:messageID,parts,
        supportsVision:!!imageModelInfo?.capabilities?.input?.image,
        local:referenceImages});
      if (!current() || (this.queueStops.get(sid) ?? 0) !== stopped) throw new NotDispatched("Отправка отменена.");
      posted = true;
      await submit(sid, item.directory, {
        messageID,
        model: {
          providerID: item.model.providerID,
          modelID: item.model.modelID,
        },
        agent: item.agent,
        variant: item.model.variant ?? undefined,
        parts: agentParts(this.state.prefs.workshop, sid, item.directory, steer ? steeringParts(sid, [{ type: "text", text: item.text }, ...imagePromptParts(parts,!!imageModelInfo?.capabilities?.input?.image,referenceImages)]) : [{ type: "text", text: item.text }, ...imagePromptParts(parts,!!imageModelInfo?.capabilities?.input?.image,referenceImages)]),
      });
      });
      if (workspaceBackend !== this.backend) return;
      this.writeQueue(
        sid,
        this.getQueue(sid).filter((x) => x.id !== item.id),
      );
      savePrefs(this.state.prefs);
      if (flushPrefs() && item.attachments) await attachmentDrafts.remove(item.attachments.scope, item.attachments.files.map(file => file.id)).catch(() => {});
      if (!current()) return;
      if ((this.statusVersions.get(sid) ?? 0) <= seq) {
        this.observeSessionStatus(sid, { type: "busy" }, item.directory);
        const prev = this.state.chat.sessions[sid] ?? emptySessionChat();
        this.mutate((s) => ({
          chat: {
            ...s.chat,
            sessions: {
              ...s.chat.sessions,
              [sid]: { ...prev, status: { type: "busy" } },
            },
          },
        }));
      }
      if (steer)
        this.patchUi({
          toast:
            "Уточнение передано агенту. Он учтёт его на следующем шаге.",
        });
    } catch (e) {
      if (waitingBeforePost && !posted && current() && (this.queueStops.get(sid) ?? 0) === stopped) {
        defer(); return;
      }
      this.queueArmed.delete(sid);
      // Persist an ambiguous outcome; NEVER automatically retry and execute it twice.
      if (workspaceBackend === this.backend)
        this.writeQueue(
          sid,
          this.getQueue(sid).map((x) =>
            x.id === item.id
              ? { ...x, state: posted ? "uncertain" : "ready", error: errText(e) }
              : x,
          ),
        );
    } finally {
      this.releaseQueueLock(sid);
      if (current()) void this.drainQueue();
    }
  }

  // ---------- interaction ----------

  async replyPermission(
    req: PermissionRequest,
    reply: "once" | "always" | "reject",
  ): Promise<void> {
    const directory = this.state.directory;
    if (!directory) return;
    try {
      await this.backend.replyPermission(req.id, reply, directory);
      this.mutate((s) => {
        const permissions = { ...s.chat.permissions };
        delete permissions[req.id];
        return { chat: { ...s.chat, permissions } };
      });
    } catch (e) {
      this.patchUi({ toast: `Permission reply failed: ${errText(e)}` });
    }
  }

  async replyQuestion(
    req: QuestionRequest,
    answers: string[][],
  ): Promise<void> {
    const directory = this.state.directory;
    if (!directory) return;
    try {
      await this.backend.replyQuestion(req.id, answers, directory);
      this.mutate((s) => {
        const questions = { ...s.chat.questions };
        delete questions[req.id];
        return { chat: { ...s.chat, questions } };
      });
    } catch (e) {
      this.patchUi({ toast: `Answer failed: ${errText(e)}` });
    }
  }

  async rejectQuestion(req: QuestionRequest): Promise<void> {
    const directory = this.state.directory;
    if (!directory) return;
    try {
      await this.backend.rejectQuestion(req.id, directory);
      this.mutate((s) => {
        const questions = { ...s.chat.questions };
        delete questions[req.id];
        return { chat: { ...s.chat, questions } };
      });
    } catch (e) {
      this.patchUi({ toast: `Reject failed: ${errText(e)}` });
    }
  }

  // ---------- event stream ----------

  /**
   * Pi streams over the native bridge, independently of the OpenCode SSE stream:
   * a folder can hold chats from both engines at once, and neither stream may
   * stall or cancel the other.
   */
  private startPiStream(directory: string, gen: number): void {
    this.piStreamAbort?.abort();
    this.piStreamAbort = null;
    // A new Pi chat can be created after this subscription starts. Do not
    // require existing metadata, otherwise its first run has no UI events.
    if (!isLocalComputer(this.state.prefs.endpoint, !!this.currentHost())) return;
    const ctrl = new AbortController();
    this.piStreamAbort = ctrl;
    this.pi().subscribeDirectory(directory, {
      signal: ctrl.signal,
      onEvent: (event: ServerEvent) => {
        if (gen !== this.directoryGeneration) return;
        this.handleEvent(event);
      },
      onState: () => {},
    });
  }

  private startEventStream(directory: string, gen: number): void {
    const ctrl = new AbortController();
    this.streamAbort = ctrl;
    this.backend.subscribeDirectory(directory, {
      signal: ctrl.signal,
      onEvent: (event: ServerEvent) => {
        if (gen !== this.directoryGeneration) return; // stale project events must not leak
        this.handleEvent(event);
      },
      onState: (state, detail) => {
        if (gen !== this.directoryGeneration) return;
        this.mutate((s) => ({
          connection: {
            ...s.connection,
            streamState: state === "closed" ? "closed" : state,
          },
        }));
        if (state === "open") void this.resyncAfterReconnect(directory, gen);
        if (state === "error" && detail) {
          // Keep chat; report transport trouble without claiming the model is dead.
        }
      },
    });
  }

  private async resyncAfterReconnect(
    directory: string,
    gen: number,
    dispatchQueue = true,
  ): Promise<void> {
    const journal: ServerEvent[] = [];
    this.historyJournals.add(journal);
    try {
      // Permission/question polling is optional: a backend that does not ask is
      // not probed for endpoints it never implements.
      const capabilities = this.backend.capabilities;
      const [sessions, statuses, permissions, questions] = await Promise.all([
        this.backend.listSessions(directory),
        this.backend.sessionStatuses(directory),
        capabilities.permissions
          ? this.backend.pendingPermissions(directory)
          : Promise.resolve([]),
        capabilities.questions
          ? this.backend.pendingQuestions(directory)
          : Promise.resolve([]),
      ]);
      if (gen !== this.directoryGeneration || journal.length >= 20000) return;
      for (const session of sessions) this.rememberActivitySession(session);
      const visible = [...sessions.filter((s) => !s.parentID), ...this.state.sessions.filter(s => this.isPiSession(s.id) && s.directory === directory)];
      for (const [id, status] of Object.entries(statuses))
        this.observeSessionStatus(id, status, directory);
      this.rememberChatListing(directory, visible);
      this.mutate((s) => {
        // Authoritative reconciliation (R4): the server's status list replaces any
        // locally accumulated busy state; sessions absent from it are idle again.
        const chatSessions: ChatRootState["sessions"] = { ...s.chat.sessions };
        for (const id of Object.keys(chatSessions)) {
          // This response belongs to OpenCode in one directory. Pi and other
          // projects have independent status authorities and must survive it.
          if (this.isPiSession(id) || (this.activityDirectories.get(id) && this.activityDirectories.get(id) !== directory)) continue;
          chatSessions[id] = {
            ...chatSessions[id],
            status: statuses[id] ?? { type: "idle" },
          };
        }
        for (const [id, status] of Object.entries(statuses)) {
          if (!chatSessions[id])
            chatSessions[id] = { ...emptySessionChat(), status };
        }
        const chat: ChatRootState = {
          ...s.chat,
          sessions: chatSessions,
          permissions: Object.fromEntries(permissions.map((p) => [p.id, p])),
          questions: Object.fromEntries(questions.map((q) => [q.id, q])),
        };
        for (const event of journal) {
          if (
            event.type === "session.status" ||
            event.type.startsWith("permission.") ||
            event.type.startsWith("question.")
          )
            reduceEvent(chat, { ...event, id: undefined });
        }
        return {
          sessions: visible.filter((x) => !x.time.archived),
          archivedSessions: visible.filter((x) => x.time.archived),
          ui: { ...s.ui, sessionListError: null },
          statuses: { ...Object.fromEntries(Object.entries(s.statuses).filter(([id]) => this.isPiSession(id) || (this.activityDirectories.get(id) && this.activityDirectories.get(id) !== directory))), ...statuses },
          connection: { ...s.connection, statusError: null },
          chat,
        };
      });
      const active = this.state.activeSessionId;
      if (active) await this.loadHistory(active, directory);
      if (dispatchQueue) void this.drainQueue();
    } catch (error) {
      if (gen === this.directoryGeneration) this.noteProjectFailure(error);
    } finally {
      this.historyJournals.delete(journal);
    }
  }

  private handleEvent(event: ServerEvent): void {
    this.indexSidebarEvent(event);
    if ((event.type === "session.status" || event.type === "session.idle" || event.type === "session.error") &&
        typeof event.properties?.sessionID === "string") {
      this.observeSessionStatus(
        event.properties.sessionID,
        event.type === "session.status"
          ? ((event.properties.status as SessionStatus) ?? { type: "idle" })
          : { type: "idle" },
        this.state.directory ?? undefined,
      );
    }
    if (
      (event.type === "session.status" || event.type === "session.error" || event.type === "session.idle") &&
      typeof event.properties?.sessionID === "string"
    )
      this.statusVersions.set(
        event.properties.sessionID,
        ++this.statusSequence,
      );
    for (const journal of this.historyJournals)
      if (journal.length < 20000) journal.push(event);
    if (event.type === "session.updated" && event.properties?.info) {
      const info = event.properties.info as Session;
      this.mutate((s) => {
        const merged = s.sessions.some((x) => x.id === info.id)
          ? s.sessions.map((x) => (x.id === info.id ? { ...x, ...info } : x))
          : s.sessions;
        // keep the archived/live split consistent when the flag arrives via event
        return info.time?.archived
          ? { sessions: merged.filter((x) => x.id !== info.id) }
          : { sessions: merged };
      });
    }
    if (event.type === "session.created" || event.type === "session.deleted") {
      // List refresh only — must never touch the project/stream generation (R1).
      void this.refreshSessions();
      return;
    }
    const affected =
      typeof event.properties?.sessionID === "string"
        ? event.properties.sessionID
        : undefined;
    const info =
      event.type === "message.updated"
        ? (event.properties?.info as { sessionID?: string; error?: unknown })
        : undefined;
    if (event.type === "session.error" && affected && isQueuePausingError(describeMessageError(event.properties?.error)))
      this.queueArmed.delete(affected);
    if (info?.error && info.sessionID && isQueuePausingError(describeMessageError(info.error)))
      this.queueArmed.delete(info.sessionID);
    const changed = reduceEvent(this.state.chat, event);
    if (changed) {
      this.state = { ...this.state, rev: this.state.rev + 1 };
      const part = event.properties?.part as MessagePart | undefined;
      this.notifications.notify(event.type === 'message.part.delta' ||
        (event.type === 'message.part.updated' && (part?.type === 'text' || part?.type === 'reasoning')));
    }
    if (event.type === "session.status" || event.type === "session.idle" || /^(permission|question)(\.v2)?\.(replied|rejected)$/.test(event.type)) void this.drainQueue();
  }

  activityStatus(id: string): SessionStatus | undefined {
    return this.state.activityStatuses[id] ??
      this.state.chat.sessions[id]?.status ?? this.state.statuses[id];
  }

  isUnread(id: string): boolean {
    return Boolean(this.state.prefs.unreadSessions?.[id]);
  }

  hasUnreadInDirectory(directory: string): boolean {
    return Object.entries(this.state.prefs.unreadSessions ?? {})
      .some(([id, item]) => item.directory === directory && this.visibleActivity(id));
  }

  hasRunningInDirectory(directory: string): boolean {
    return Object.entries(this.state.activityStatuses).some(([id, status]) =>
      this.activityDirectories.get(id) === directory && this.visibleActivity(id) &&
      (status.type === "busy" || status.type === "retry"));
  }

  private isViewing(id: string): boolean {
    return this.state.activeSessionId === id &&
      this.conversationAtBottom && !this.state.ui.settingsOpen && !this.state.ui.historyLoading &&
      typeof document !== "undefined" && !document.hidden && document.hasFocus();
  }

  setConversationAtBottom(atBottom: boolean): void {
    if (this.conversationAtBottom === atBottom) return;
    this.conversationAtBottom = atBottom;
    if (atBottom) this.markReadIfViewing();
  }

  markReadIfViewing(): void {
    const id = this.state.activeSessionId;
    if (!id || !this.isViewing(id) || !this.isUnread(id)) return;
    this.clearUnread(id);
  }

  private clearUnread(id: string): void {
    if (!this.isUnread(id)) return;
    const unread = { ...this.state.prefs.unreadSessions };
    delete unread[id];
    this.mutate((s) => ({ prefs: { ...s.prefs, unreadSessions: unread } }));
    this.persistPrefs();
  }

  private visibleActivity(id: string): boolean {
    const session = this.activitySessions.get(id);
    return !session?.parentID && !session?.time?.archived;
  }

  private rememberActivitySession(session: Session): void {
    this.activityRevisions.set(session.id, (this.activityRevisions.get(session.id) ?? 0) + 1);
    this.activitySessions.set(session.id, session);
    this.activityDirectories.set(session.id, session.directory);
    if (session.parentID || session.time?.archived) this.clearUnread(session.id);
  }

  private resolveActivitySession(id: string, directory?: string): Promise<Session | undefined> {
    const known = this.activitySessions.get(id);
    if (known) { this.rememberActivitySession(known); return Promise.resolve(known); }
    const existing = this.activityLookups.get(id);
    if (existing) return existing;
    const backend = this.backend, generation = this.connectionGeneration;
    const current = () => backend === this.backend && generation === this.connectionGeneration;
    const revision = this.activityRevisions.get(id);
    const promise = backend.getSession(id, directory ?? null).then(session => {
      if (!current()) return;
      if (revision !== this.activityRevisions.get(id)) return this.activitySessions.get(id);
      this.rememberActivitySession(session);
      if (!session.parentID && !session.time.archived) this.updateSidebarSession(session);
      return session;
    }).catch(error => {
      // A failed connection is not evidence that a result has been read or deleted.
      if (current() && revision === this.activityRevisions.get(id) && error instanceof ApiError && error.status === 404) this.forgetActivity(id);
      return undefined;
    }).finally(() => { if (this.activityLookups.get(id) === promise) this.activityLookups.delete(id); });
    this.activityLookups.set(id, promise);
    return promise;
  }

  private async reconcileUnreadSessions(directory?: string): Promise<void> {
    const entries = Object.entries(this.state.prefs.unreadSessions ?? {})
      .filter(([, item]) => !directory || item.directory === directory);
    // Bound startup load; an old unread root outside the list's first page is resolved individually.
    for (let i = 0; i < entries.length; i += 8) {
      const backend = this.backend, generation = this.connectionGeneration;
      await Promise.all(entries.slice(i, i + 8).map(([id, item]) => this.resolveActivitySession(id, item.directory)));
      if (backend !== this.backend || generation !== this.connectionGeneration) return;
    }
  }

  private finishActivity(id: string, status: SessionStatus, directory?: string): void {
    if (this.state.activityStatuses[id] !== status || !this.visibleActivity(id) || this.isViewing(id)) return;
    let unread = { ...this.state.prefs.unreadSessions, [id]: {
      time: Date.now(), directory: this.activityDirectories.get(id) ?? directory,
    } };
    if (Object.keys(unread).length > 500) unread = Object.fromEntries(Object.entries(unread)
      .sort((a, b) => a[1].time - b[1].time).slice(-500));
    this.mutate(s => ({ prefs: { ...s.prefs, unreadSessions: unread } }));
    this.persistPrefs();
    void completionChime().catch(() => {});
  }

  private observeSessionStatus(id: string, status: SessionStatus, directory?: string): void {
    // A listing/stream directory is only a hint. Once the session itself has been
    // seen (`rememberActivitySession`), its own directory stays authoritative.
    if (directory && !this.activityDirectories.has(id))
      this.activityDirectories.set(id, directory);
    const previous = this.activityStatus(id);
    const wasRunning = previous?.type === "busy" || previous?.type === "retry";
    const running = status.type === "busy" || status.type === "retry";
    const finished = wasRunning && status.type === "idle";
    if (previous?.type === status.type && !running) return;
    if (running) this.clearUnread(id);
    this.mutate(s => ({ activityStatuses: { ...s.activityStatuses, [id]: status } }));
    const known = this.activitySessions.get(id) ?? this.state.sessions.find(x => x.id === id)
      ?? this.state.prefs.projectlessSessions?.find(x => x.id === id);
    if (known) {
      this.rememberActivitySession(known);
      if (finished) this.finishActivity(id, status, directory);
    } else {
      const backend = this.backend, generation = this.connectionGeneration;
      void this.resolveActivitySession(id, directory).then(session => {
        if (session && finished && backend === this.backend && generation === this.connectionGeneration)
          this.finishActivity(id, status, directory);
      });
    }
  }

  private startGlobalStream(backend: AgentBackend, generation: number): void {
    const ctrl = new AbortController();
    this.globalAbort = ctrl;
    let opened = false;
    backend.subscribeAll({
      signal: ctrl.signal,
      onEvent: ({ directory, payload }) => {
        if (generation !== this.connectionGeneration || backend !== this.backend ||
            !payload || typeof payload.type !== "string") return;
        if (payload.type === "global.disposed") {
          invalidateCapabilities();
          invalidateBrowserSetup();
          return;
        }
        this.indexSidebarEvent(payload);
        if (payload.type === "session.updated" && payload.properties?.info) {
          const info = payload.properties.info as Session;
          if (info.id && info.directory) this.activityDirectories.set(info.id, info.directory);
          if (info.id && info.time?.archived) this.clearUnread(info.id);
        }
        const id = payload.properties?.sessionID ?? (payload.properties?.info as Session | undefined)?.id;
        if (typeof id !== "string") return;
        if (payload.type === "session.deleted") {
          this.forgetActivity(id);
          return;
        }
        if (payload.type === "session.status" || payload.type === "session.idle" || payload.type === "session.error") {
          this.observeSessionStatus(id,
            payload.type === "session.status"
              ? ((payload.properties.status as SessionStatus) ?? { type: "idle" })
              : { type: "idle" },
            directory);
        }
      },
      onState: (state) => {
        if (generation !== this.connectionGeneration || backend !== this.backend) return;
        this.mutate(s => ({connection: {...s.connection, globalStreamState: state === "closed" ? "closed" : state}}));
        if (state === "open") {
          if (opened) {
            void this.reconcileBackgroundActivity(backend, generation);
            void this.loadRecentSessions(this.state.recentSessionList.archived);
            for (const dir of this.projectDirectories())
              if (this.isProjectExpanded(dir)) void this.loadProjectSessions(dir, { force: true });
          }
          opened = true;
        }
      },
    });
  }

  private forgetActivity(id: string): void {
    this.updateSidebarSession(null, id);
    this.activityDirectories.delete(id);
    this.activitySessions.delete(id);
    this.activityRevisions.set(id, (this.activityRevisions.get(id) ?? 0) + 1);
    const unreadSessions = { ...this.state.prefs.unreadSessions };
    delete unreadSessions[id];
    const activityStatuses = { ...this.state.activityStatuses };
    delete activityStatuses[id];
    this.mutate((s) => ({
      activityStatuses,
      sessions: s.sessions.filter((item) => item.id !== id),
      archivedSessions: s.archivedSessions.filter((item) => item.id !== id),
      prefs: {
        ...s.prefs,
        unreadSessions,
        projectlessSessions: s.prefs.projectlessSessions?.filter((item) => item.id !== id),
      },
    }));
    this.persistPrefs();
  }

  private async reconcileBackgroundActivity(backend: AgentBackend, generation: number) {
    const directories = new Set<string>();
    for (const [id, status] of Object.entries(this.state.activityStatuses))
      if (status.type === "busy" || status.type === "retry") {
        const dir = this.activityDirectories.get(id);
        if (dir) directories.add(dir);
      }
    for (const dir of directories) {
      try {
        const statuses = await backend.sessionStatuses(dir);
        if (generation !== this.connectionGeneration || backend !== this.backend) return;
        for (const [id, status] of Object.entries(this.state.activityStatuses))
          if (this.activityDirectories.get(id) === dir &&
              (status.type === "busy" || status.type === "retry"))
            this.observeSessionStatus(id, statuses[id] ?? { type: "idle" }, dir);
      } catch { /* Keep prior state until a confirmed server status arrives. */ }
    }
  }

  // ---------- ui helpers ----------

  setUi(patch: Partial<UiState>): void {
    this.patchUi(patch);
    if (patch.settingsOpen === false) this.markReadIfViewing();
  }

  /** Shell/Git belong to the connected workspace, independently of the chat's agent. */
  workspaceToolsAvailable(): boolean {
    return this.state.connection.phase === "connected" && this.backend.capabilities.pty;
  }

  async toggleTerminal(): Promise<void> {
    const next = !this.state.prefs.layout.bottomOpen;
    if (next && !this.workspaceToolsAvailable()) {
      this.patchUi({ toast: "Этот агент не предоставляет терминал." });
      return;
    }
    if (next && !(await this.ensureChatWorkspace())) return;
    this.setLayout({ bottomOpen: next });
  }

  setLayout(patch: Partial<Prefs["layout"]>): void {
    this.mutate((s) => ({
      prefs: { ...s.prefs, layout: { ...s.prefs.layout, ...patch } },
    }));
    this.persistPrefs();
  }

  setAppearance(patch: Partial<Appearance>): void {
    const appearance = normalizeAppearance({ ...this.state.prefs.appearance, ...patch });
    this.mutate(s => ({ prefs: { ...s.prefs, appearance } }));
    this.persistPrefs();
    applyAppearance(appearance);
  }

  setTheme(theme: Prefs["theme"]): void {
    this.mutate((s) => ({ prefs: { ...s.prefs, theme } }));
    this.persistPrefs();
    applyTheme(theme);
  }

  pendingInteraction(sessionId: string | null): {
    permissions: PermissionRequest[];
    questions: QuestionRequest[];
  } {
    if (!sessionId) return { permissions: [], questions: [] };
    return pendingForSession(this.state.chat, sessionId);
  }
}

export { errText } from "./errors";

export const store = new Store();
const stopCatalogPersistence = modelServices.subscribe(() => store.syncModelServiceCatalogs());
let hubModels: HubModelServices | undefined, stopHubModels: (() => void) | undefined, disposed = false;
if (isNative()) modelServices.waitForHub(import("../models/hub").then(({HubModelServices}) => {
  if (disposed) return;
  hubModels = new HubModelServices(undefined, id => store.isRunning(id));
  stopHubModels = modelServices.attachHub(hubModels);
  hubModels.start();
}));
const refreshHubModels = () => { hubModels?.connectionChanged(); void hubModels?.refresh().catch(() => {}); };
if (typeof window !== "undefined") window.addEventListener("arvela-hub-config-changed", refreshHubModels);
try {
  modelServices.configure(store.state.prefs.modelServices ?? []);
} catch (error) {
  store.state = { ...store.state, ui: { ...store.state.ui, toast: `Проверьте настройки сервисов моделей: ${errText(error)}` } };
}
// Both engines live in the registry, so `listBackendDescriptors()` is the honest
// list of what this build can drive.
registerBackendDescriptor(piDescriptor(() => store.pi()));
import.meta.hot?.dispose(() => { disposed = true; stopCatalogPersistence(); stopHubModels?.(); hubModels?.dispose(); window.removeEventListener("arvela-hub-config-changed", refreshHubModels); store.dispose(); });

export function useAppSelector<T extends object>(select: (state: AppState) => T): T {
  const snapshot=useMemo(()=>selectedSnapshot(store.getSnapshot,select,shallowEqual),[select]);
  return useSyncExternalStore(store.subscribe,snapshot);
}

export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

export function applyTheme(theme: Prefs["theme"]): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const effective =
    theme === "system" ? (mq.matches ? "dark" : "light") : theme;
  root.dataset.theme = effective;
  root.style.colorScheme = effective;
  applyAppearance(store.state.prefs.appearance);
}

if (typeof window !== "undefined") {
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => applyTheme(store.state.prefs.theme));
}
