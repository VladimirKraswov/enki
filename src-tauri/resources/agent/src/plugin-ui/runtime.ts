import { randomUUID } from "node:crypto";
import path from "node:path";
import { CombinedAutocompleteProvider, Text } from "@earendil-works/pi-tui";
import { getSelectListTheme, type ExtensionCommandContextActions, type Theme } from "@earendil-works/pi-coding-agent";
import { validateCommand, type CommandReceipt, type PromptCommand } from "../protocol.ts";
import type { Database } from "../store/db.ts";
import type { EventJournal } from "../store/events.ts";
import type { SessionRecord } from "../sessions/catalog.ts";
import { EditorDraftCas, isDraft, type DraftReceipt, type DraftSnapshot } from "./draft-cas.ts";
import { PluginSurfaceState, initialSurfaceState, validSurfaceState } from "./surface-state.ts";
import { EnkiVirtualTerminal } from "./virtual-terminal.ts";
import { SessionComponentHost } from "./component-host.ts";
import { loadSdkUiCompat, type SdkUiCompat } from "./sdk-ui-compat.ts";
import type { PluginHostPorts } from "./sdk-ports.ts";
import { isInput, isResize, sameScope, type SurfaceAttachment, type UiFrame, type UiScope } from "./protocol.ts";
import type { SubmitRequest } from "./host-ports.ts";

/** Native methods must validate the active window/user gesture before touching
 * clipboard or opening a URL. The runtime never falls back to shell/OSC52. */
export interface NativeUiScope extends UiScope { directory: string; principal: string }
export interface NativePluginUiPorts {
  copySelection(scope: NativeUiScope, text: string): Promise<boolean>;
  openUrl(scope: NativeUiScope, url: string): Promise<void>;
  requestPaste(scope: NativeUiScope): Promise<string>;
  readGitBranch(directory: string): Promise<string | undefined>;
}
export interface WorkerUiPorts {
  db: Database;
  hostId: string;
  native: NativePluginUiPorts;
  /** Trusted authenticated transport principal, checked again on every action. */
  authorize(principal: string, sessionID: string, directory: string): boolean;
  /** Runtime maintenance/admission gate; read-only snapshots remain available. */
  admit?(principal: string, sessionID: string, directory: string): boolean;
  /** Goes through the same durable Dispatcher/Hub gate as normal chat input. */
  submit(command: PromptCommand): Promise<CommandReceipt>;
}
export interface SurfaceListener {
  reset(attachment: SurfaceAttachment): void;
  frame(frame: UiFrame): void;
  closed(reason: string): void;
}
interface Listener { principal: string; handlers: SurfaceListener }
/** Draft mutation receipts kept for lost-ACK replay (most recent revisions). */
export const DRAFT_RECEIPTS = 64;
interface SharedCompat { sdk: SdkUiCompat; keybindings: ReturnType<SdkUiCompat["createKeybindings"]> }
const globalCompatibility = new Map<string, Promise<SharedCompat>>();
const globalViews = new Set<SessionUi>();
async function compatibility(agentDir: string): Promise<SharedCompat> {
  let pending = globalCompatibility.get(agentDir);
  if (!pending) {
    pending = (async () => {
      const sdk = await loadSdkUiCompat(new URL(import.meta.resolve("@earendil-works/pi-coding-agent")), { agentDir });
      const theme = sdk.themes.getTheme("dark"); if (!theme) throw new Error("В SDK отсутствует тема интерфейса.");
      sdk.initializeTheme(theme);
      return { sdk, keybindings: sdk.createKeybindings({}, path.join(agentDir, "keybindings.json")) };
    })();
    globalCompatibility.set(agentDir, pending);
    void pending.catch(() => { if (globalCompatibility.get(agentDir) === pending) globalCompatibility.delete(agentDir); });
  }
  return pending;
}
export async function shutdownPluginUi(): Promise<void> {
  const pending = [...globalCompatibility.values()]; globalCompatibility.clear();
  for (const value of pending) { const compat = await value.catch(() => null); compat?.sdk.stopThemeWatcher(); }
}

/** Runtime-owned UI lifetime. Detaching a client never aborts its AgentSession. */
export class SessionUi {
  readonly scope: UiScope;
  readonly draft: EditorDraftCas;
  readonly state: PluginSurfaceState;
  readonly terminal: EnkiVirtualTerminal;
  readonly host: SessionComponentHost;
  readonly themes: SdkUiCompat["themes"];
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<Listener>();
  private controller: { principal: string; lease: string } | null = null;
  private closed = false;
  private branch: string | undefined;
  private readonly branchListeners = new Set<() => void>();
  private readonly transcript = new Text("", 0, 0);
  private readonly key: string;
  private nativePending = 0;
  private stopping = false;

  static async create(record: SessionRecord, agentDir: string, privatePorts: WorkerUiPorts,
    journal: EventJournal, actions: ExtensionCommandContextActions,
    model: () => { providerID: string; modelID: string; variant?: string | null },
    availableProviderCount: () => number, themes: Theme[] = []): Promise<SessionUi> {
    const compat = await compatibility(agentDir);
    return new SessionUi(record, agentDir, privatePorts, journal, actions, model, availableProviderCount, compat, themes);
  }
  private constructor(private readonly record: SessionRecord, agentDir: string,
    private readonly ports: WorkerUiPorts, private readonly journal: EventJournal,
    readonly actions: ExtensionCommandContextActions,
    model: () => { providerID: string; modelID: string; variant?: string | null },
    availableProviderCount: () => number, private readonly compat: SharedCompat, private readonly resourceThemes: Theme[]) {
    this.key = `ui:v1:${record.id}:`;
    const epoch = ports.db.transaction(() => {
      const current = Number(this.readMeta("epoch") ?? "0");
      if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(current + 1)) throw new Error("Повреждена версия интерфейса сессии.");
      this.writeMeta("epoch", String(current + 1)); return current + 1;
    });
    this.scope = { hostId: ports.hostId, sessionId: record.id, sessionEpoch: epoch, surfaceId: "extensions" };
    const savedDraft: unknown = JSON.parse(this.readMeta("draft") ?? "null");
    if (savedDraft !== null && !isDraft(savedDraft)) throw new Error("Сохранённый черновик Enki повреждён.");
    const initial: DraftSnapshot = savedDraft === null ? { revision: 0, text: "", selection: { start: 0, end: 0 }, updatedAt: Date.now() } : savedDraft;
    this.draft = new EditorDraftCas(this.scope, initial, {
      lookup: (_scope, id) => {
        const raw = this.readMeta(`draft-receipt:${id}`); if (raw === null) return undefined;
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object" || !("digest" in value) || typeof value.digest !== "string"
          || !("snapshot" in value) || !isDraft(value.snapshot)) throw new Error("Квитанция черновика повреждена.");
        return { digest: value.digest, snapshot: value.snapshot };
      },
      commit: (_scope, expected, id, receipt) => ports.db.transaction(() => {
        const raw = this.readMeta("draft");
        const previous: unknown = raw ? JSON.parse(raw) : initial;
        if (!isDraft(previous) || previous.revision !== expected) throw new Error("Черновик уже изменился в другом клиенте.");
        this.writeMeta("draft", JSON.stringify(receipt.snapshot));
        this.writeMeta(`draft-receipt:${id}`, JSON.stringify(receipt));
        // Each receipt holds a full draft and the editor commits per change:
        // keep only the recent window. An evicted id's retry is then decided
        // by the revision CAS (an explicit conflict), never re-applied.
        const prefix = `${this.key}draft-receipt:`;
        ports.db.run("DELETE FROM meta WHERE key >= ? AND key < ? AND CAST(json_extract(value,'$.snapshot.revision') AS INTEGER) <= ?",
          prefix, prefix + String.fromCharCode(0xffff), receipt.snapshot.revision - DRAFT_RECEIPTS);
      }),
      // The durable draft is in meta. High-frequency journal events carry only
      // its revision, not another complete multi-megabyte text per keystroke.
      publish: (_scope, snapshot) => this.emit("extension.draft", { revision: snapshot.revision, updatedAt: snapshot.updatedAt }),
      projectionFailure: (_scope, error) => this.fault("draft-projection", error),
    });
    const savedState = this.readMeta("surface");
    const surface: unknown = savedState ? JSON.parse(savedState) : initialSurfaceState();
    if (!validSurfaceState(surface)) throw new Error("Сохранённый интерфейс сессии повреждён.");
    this.state = new PluginSurfaceState(this.scope, surface, {
      commit: (_scope, expected, next) => ports.db.transaction(() => {
        const stored = this.readMeta("surface");
        const revision: unknown = stored ? JSON.parse(stored).revision : 0;
        if (revision !== expected) throw new Error("Интерфейс изменился в другом клиенте.");
        this.writeMeta("surface", JSON.stringify(next));
      }),
      project: (_scope, snapshot) => {
        this.host?.applySnapshot(snapshot);
        this.emit("extension.ui.state", { snapshot });
      },
      projectionFailure: (_scope, error) => this.fault("surface-projection", error),
    });
    this.terminal = new EnkiVirtualTerminal(this.scope, {
      authorizeControl: (_scope, lease) => !!this.controller && this.controller.lease === lease
        && ports.authorize(this.controller.principal, record.id, record.directory)
        && ports.admit?.(this.controller.principal, record.id, record.directory) !== false,
      // VT frames are not persisted in the general event journal: full redraw
      // recovers the view, and the journal must not retain 20k large VT frames.
      publish: frame => this.forListeners(listener => listener.handlers.frame(frame)),
      reset: () => this.forListeners(listener => listener.handlers.reset(this.attachment(listener.principal))),
      metadata: (_scope, metadata) => this.emit("extension.ui.metadata", metadata),
      fault: (_scope, error) => this.fault("terminal", error),
    });
    this.themes = {
      get theme() { return compat.sdk.themes.theme; },
      getAllThemes: () => compat.sdk.themes.getAllThemes(), getTheme: name => compat.sdk.themes.getTheme(name),
      setTheme: value => {
        const result = compat.sdk.themes.setTheme(value);
        if (result.success) {
          const name = typeof value === "string" ? value : "custom";
          for (const view of globalViews) {
            try {
              view.ports.db.transaction(() => view.ports.db.run("INSERT INTO meta(key,value) VALUES('ui:v1:global:theme',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", name));
              // Surface CAS projects only after its own outer commit. Do not
              // nest it inside another transaction that could later roll back.
              view.state.setThemeName(name);
              view.host.refreshTheme();
            } catch (error) { view.fault("global-theme", error); }
          }
        }
        return result;
      },
    };
    this.host = new SessionComponentHost({ terminal: this.terminal, state: this.state, draft: this.draft,
      // Theme/keybindings are an explicit HOST-WIDE app preference. All session
      // renderers use the same real singleton; no claim of worker-realm isolation.
      compat: { sdk: compat.sdk,
        keybindings: compat.keybindings,
        editorTheme: { borderColor: text => compat.sdk.themes.theme.fg("border", text), selectList: getSelectListTheme() } },
      editorPorts: {
        nextMutationId: () => randomUUID(), readCommitted: () => this.readDraft(),
        pending: change => this.persistEvent("pending-draft", change, "extension.draft.pending"),
        pendingSubmission: request => this.persistEvent("pending-submit", request, "extension.draft.submission"),
        submit: async request => {
          // Full captured command is durable before Dispatcher admission, so the
          // same retry can never silently select a different current model.
          const key = `submit:${request.id}`;
          const existing = this.readMeta(key);
          const candidate: unknown = existing ? JSON.parse(existing) : { id: request.id, kind: "prompt",
            sessionID: record.id, directory: record.directory, payload: { parts: [{ type: "text", text: request.text }], model: model(), source: "manual" } };
          const command = validateCommand(candidate);
          if (typeof command === "string" || command.kind !== "prompt" || command.id !== request.id
            || command.sessionID !== record.id || command.directory !== record.directory
            || command.payload.parts.length !== 1 || command.payload.parts[0].type !== "text"
            || command.payload.parts[0].text !== request.text) throw new Error("Сохранённая отправка редактора повреждена или её ID использован повторно.");
          if (!existing) ports.db.transaction(() => this.writeMeta(key, JSON.stringify(command)));
          const receipt = await ports.submit(command);
          if (receipt.state === "uncertain") throw new Error("Доставка прежней команды не подтверждена после перезапуска. Проверьте её результат.");
          return { accepted: receipt.state !== "rejected", commandId: receipt.id };
        },
        fault: value => this.fault(value.operation, value.error),
        modeChanged: value => this.emit("extension.ui.mode", value),
      },
      resources: { autocomplete: new CombinedAutocompleteProvider([], record.directory), history: [] },
      native: {
        fault: value => this.fault(value.operation, value.error),
        copySelection: text => this.nativeAction(scope => ports.native.copySelection(scope, text)),
        openUrl: url => { void this.nativeAction(scope => ports.native.openUrl(scope, url)).catch(error => this.fault("open-url", error)); },
        requestPaste: () => { void this.nativeAction(scope => ports.native.requestPaste(scope)).then(text => {
          if (!this.closed) { this.nativeScope(); this.host.editor.api.pasteToEditor(text); }
        }).catch(error => this.fault("paste", error)); },
        applyPresentation: value => this.emit("extension.ui.presentation", value),
      },
      baseline: { header: () => new Text(record.title, 0, 0), transcript: this.transcript,
        footer: () => new Text(record.directory, 0, 0) },
      footerData: { getGitBranch: () => this.branch ?? null, getExtensionStatuses: () => new Map(Object.entries(this.state.current().statuses)),
        getAvailableProviderCount: availableProviderCount, onBranchChange: callback => { this.branchListeners.add(callback); return () => { this.branchListeners.delete(callback); }; } },
      signal: this.lifetime.signal, logDirectory: agentDir, customTimeoutMs: 15 * 60_000, defaultWorkingMessage: "Работаю…", ownsThemeWatcher: false,
    });
    try {
      const pendingDraft: unknown = JSON.parse(this.readMeta("pending-draft") ?? "null");
      if (pendingDraft !== null) this.host.editor.restorePendingChange(pendingDraft);
      const pendingSubmit: unknown = JSON.parse(this.readMeta("pending-submit") ?? "null");
      if (pendingSubmit !== null) this.host.editor.restorePendingSubmission(pendingSubmit);
      this.host.start();
      globalViews.add(this);
      this.registerThemes();
      const savedTheme = ports.db.get("SELECT value FROM meta WHERE key='ui:v1:global:theme'")?.value;
      if (typeof savedTheme === "string" && savedTheme !== "custom" && compat.sdk.themes.getTheme(savedTheme)) this.themes.setTheme(savedTheme);
    } catch (error) { globalViews.delete(this); this.host.dispose(); this.closed = true; throw error; }
    this.emit("extension.ui.available", { scope: this.scope });
    void ports.native.readGitBranch(record.directory).then(branch => {
      if (this.closed || branch === this.branch) return;
      this.branch = branch; for (const listener of this.branchListeners) listener();
    }).catch(error => this.fault("git-branch", error));
  }
  private readMeta(key: string): string | null { const value = this.ports.db.get("SELECT value FROM meta WHERE key=?", this.key + key)?.value; return typeof value === "string" ? value : null; }
  private registerThemes(): void {
    // SDK themes are host-wide. Keep themes of other live sessions registered
    // when one worker reloads; duplicate names use the first active selection.
    const byName = new Map<string | Theme, Theme>();
    for (const view of globalViews) for (const value of view.resourceThemes) {
      const key = value.name ?? value; if (!byName.has(key)) byName.set(key, value);
    }
    this.compat.sdk.registerThemes([...byName.values()]);
  }
  private writeMeta(key: string, value: string): void { this.ports.db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", this.key + key, value); }
  private persistEvent(key: string, value: unknown, type: string): void {
    this.ports.db.transaction(() => { this.writeMeta(key, JSON.stringify(value)); this.emit(type, { value }); });
  }
  private emit(type: string, properties: Record<string, unknown>): void { this.journal.append(this.record.directory, this.record.id, { type, properties: { sessionID: this.record.id, scope: this.scope, ...properties } }); }
  private fault(operation: string, error: unknown): void {
    if (this.closed) return;
    this.emit("extension.ui.error", { operation, message: error instanceof Error ? error.message.slice(0, 1000) : "Ошибка интерфейса расширения" });
  }
  private authorized(principal: string): void {
    if (this.closed || !principal || !this.ports.authorize(principal, this.record.id, this.record.directory)) {
      if (!this.closed && this.controller?.principal === principal) { this.controller = null; this.terminal.setController(null); }
      throw new Error("Доступ к интерфейсу сессии не подтверждён.");
    }
  }
  private nativeScope(): NativeUiScope {
    const principal = this.controller?.principal;
    if (!principal) throw new Error("Для системного действия требуется активный владелец интерфейса.");
    this.admitted(principal); return { ...this.scope, principal, directory: this.record.directory };
  }
  private async nativeAction<T>(action: (scope: NativeUiScope) => Promise<T>): Promise<T> {
    const scope = this.nativeScope(); this.nativePending++;
    try { return await action(scope); } finally { this.nativePending--; }
  }
  private admitted(principal: string): void {
    this.authorized(principal);
    if (this.stopping || this.ports.admit?.(principal, this.record.id, this.record.directory) === false)
      throw new Error("Интерфейс временно доступен только для чтения: выполняется обслуживание.");
  }
  activity(): number { return this.nativePending + (this.closed ? 0 : this.host.activity()); }
  private forListeners(callback: (listener: Listener) => void): void {
    for (const listener of [...this.listeners]) {
      try { this.authorized(listener.principal); callback(listener); }
      catch { this.listeners.delete(listener); try { listener.handlers.closed("Подключение интерфейса завершено."); } catch { /* failed transport detached */ } }
    }
  }
  readDraft(): DraftSnapshot {
    const raw = this.readMeta("draft"); const value: unknown = raw ? JSON.parse(raw) : this.draft.current();
    if (!isDraft(value)) throw new Error("Черновик повреждён."); return structuredClone(value);
  }
  attachment(principal: string): SurfaceAttachment {
    this.authorized(principal); const attachment = this.terminal.attachment();
    return { ...attachment, controllerLeaseId: this.controller?.principal === principal ? attachment.controllerLeaseId : null };
  }
  attach(principal: string, handlers: SurfaceListener): { attachment: SurfaceAttachment; detach(): void } {
    this.authorized(principal); const listener = { principal, handlers }; this.listeners.add(listener);
    return { attachment: this.attachment(principal), detach: () => { this.listeners.delete(listener); } };
  }
  control(principal: string): SurfaceAttachment {
    this.admitted(principal);
    if (this.controller?.principal !== principal) { this.controller = { principal, lease: randomUUID() }; this.terminal.setController(this.controller.lease); }
    this.host.snapshotFrame(); return this.attachment(principal);
  }
  release(principal: string): void {
    this.admitted(principal); if (this.controller?.principal !== principal) return;
    this.controller = null; this.terminal.setController(null); this.host.snapshotFrame();
  }
  input(principal: string, command: unknown) {
    this.admitted(principal);
    if (this.controller?.principal !== principal || !isInput(command) || !sameScope(command, this.scope)) throw new Error("Этот клиент не управляет интерфейсом.");
    return this.terminal.input(command);
  }
  resize(principal: string, command: unknown): void {
    this.admitted(principal);
    if (this.controller?.principal !== principal || !isResize(command) || !sameScope(command, this.scope)) throw new Error("Этот клиент не управляет интерфейсом.");
    this.terminal.resize(command);
  }
  resync(principal: string): void { this.authorized(principal); this.host.snapshotFrame(); }
  snapshot(principal: string) { this.authorized(principal); return { scope: this.scope, nativeScope: this.controller?.principal === principal ? { ...this.scope, principal, directory: this.record.directory } : null,
    draft: this.readDraft(), state: this.state.current(), attachment: this.attachment(principal),
    pendingDraft: JSON.parse(this.readMeta("pending-draft") ?? "null") as unknown,
    pendingSubmission: JSON.parse(this.readMeta("pending-submit") ?? "null") as unknown }; }
  replaceDraft(principal: string, mutation: Parameters<EditorDraftCas["replace"]>[0]) {
    this.admitted(principal); const result = this.draft.replace(mutation); this.host.editor.hydrate(this.readDraft()); return result;
  }
  retrySubmission(principal: string): void { this.admitted(principal); this.host.editor.retrySubmission(); }
  retryDraft(principal: string): void { this.admitted(principal); this.host.editor.retryPending(); }
  resolveDraft(principal: string, choice: Parameters<SessionComponentHost["editor"]["resolvePending"]>[0]): void {
    this.admitted(principal); this.host.editor.resolvePending(choice);
  }
  updateTranscript(lines: string[]): void { if (!this.closed) { this.transcript.setText(lines.slice(-80).join("\n")); this.host.tui.requestRender(); } }
  setRunning(value: boolean): void { if (!this.closed) this.host.setRunning(value); }
  beginShutdown(): void { if (!this.closed) { this.stopping = true; this.host.beginShutdown(); } }
  dispose(): void {
    if (this.closed) return;
    // Cancel factories before closing transport, then report close once.
    globalViews.delete(this);
    try { this.registerThemes(); } catch (error) { this.fault("theme-unregister", error); }
    this.lifetime.abort(); this.closed = true;
    for (const listener of this.listeners) try { listener.handlers.closed("Worker интерфейса закрыт."); } catch { /* transport already gone */ }
    this.listeners.clear(); this.branchListeners.clear();
  }
}
