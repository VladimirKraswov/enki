// Runtime plugin UI of one chat, as seen by this window.
//
// - `events` (default) watches without opening an SDK worker. The runtime holds
//   this window's UI authority for the stream lifetime, so a worker started by a
//   prompt or timer can show its session_start UI here. `open` is the explicit,
//   admission-gated start; during maintenance it degrades to watching.
// - Every surface message is fenced by host/session/epoch scope; VT frames are
//   additionally ordered by stream epoch + sequence in the frame consumer.
// - Detaching or disposing never stops the agent.
import { sameScope } from "../../../../src-tauri/resources/agent/src/plugin-ui/protocol";
import { SseDecoder } from "../../../api/sse";
import type { RuntimeClient } from "../client";
import type { SurfaceAttachmentHandle, SurfaceHandlers, SurfacePort } from "./surfaceController";
import { isUiSnapshot, parseUiMessage, type PendingDraftChange, type PendingSubmission, type UiScope, type UiSnapshot, type UiStreamMessage, type UiSurfaceState } from "./types";

export type UiPhase = "connecting" | "waiting" | "live" | "reconnecting" | "closed" | "error";
export interface UiMode { custom: boolean; terminalInput: boolean }
export interface UiNotice { at: number; level: string; text: string }
export interface PluginUiView {
  phase: UiPhase;
  detail: string;
  snapshot: UiSnapshot | null;
  mode: UiMode;
  /** Latest canonical draft revision announced by the runtime. */
  draftRevision: number;
  /** Increments on each hello: views re-attach after a reconnect or new epoch. */
  generation: number;
  notices: UiNotice[];
}

const MAX_FAILURES = 6;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export class PluginUiSession implements SurfacePort {
  private view: PluginUiView = { phase: "connecting", detail: "Подключаю интерфейс расширений…", snapshot: null, mode: { custom: false, terminalInput: false }, draftRevision: -1, generation: 0, notices: [] };
  private readonly listeners = new Set<() => void>();
  private readonly surfaces = new Set<{ scope: UiScope; handlers: SurfaceHandlers }>();
  private abort: AbortController | null = null;
  private runGeneration = 0;
  private wantOpen = false;
  private disposed = false;

  constructor(readonly client: RuntimeClient, readonly sessionID: string, readonly directory: string) {}

  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getView = (): PluginUiView => this.view;

  /** Watch (never opens a worker). Idempotent. */
  start(): void { if (!this.abort && !this.disposed) this.restart(); }
  /** Explicit user request: start or adopt the worker and show its UI. */
  open(): void { this.wantOpen = true; this.restart(); }
  /** "Подключиться снова" after an error. */
  retry(): void { this.restart(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.runGeneration++;
    this.abort?.abort(); this.abort = null;
    this.closeSurfaces("Интерфейс чата закрыт в этом окне.");
    this.listeners.clear();
  }

  // ------------------------------------------------------------ SurfacePort
  async attach(scope: UiScope, handlers: SurfaceHandlers): Promise<SurfaceAttachmentHandle> {
    const current = this.view.snapshot?.scope;
    if (!current || !sameScope(current, scope)) throw new Error("Интерфейс расширения сменил поколение. Переподключите его.");
    const entry = { scope, handlers };
    this.surfaces.add(entry);
    const { client, sessionID: id, directory: dir } = this;
    // A new view needs a full redraw: the runtime advances streamEpoch first.
    try { await client.uiResync(id, dir); } catch (error) { this.surfaces.delete(entry); throw error; }
    return {
      input: command => client.uiInput(id, dir, command),
      resize: command => client.uiResize(id, dir, command),
      resync: () => client.uiResync(id, dir),
      control: async () => { await client.uiControl(id, dir); await this.refresh(); },
      release: async () => { await client.uiRelease(id, dir); await this.refresh(); },
      detach: () => { this.surfaces.delete(entry); },
    };
  }

  /** Re-read the principal-specific snapshot (nativeScope, pending draft/submission). */
  async refresh(): Promise<UiSnapshot | null> {
    const scope = this.view.snapshot?.scope;
    if (!scope) return null;
    const snapshot = await this.client.uiSnapshot(this.sessionID, this.directory);
    if (!isUiSnapshot(snapshot) || !sameScope(snapshot.scope, scope) || this.disposed) return null;
    this.patch({ snapshot, draftRevision: Math.max(this.view.draftRevision, snapshot.draft.revision) });
    return snapshot;
  }

  retryDraft(): Promise<void> { return this.client.uiRetryDraft(this.sessionID, this.directory).then(() => { void this.refresh(); }); }
  retrySubmission(): Promise<void> { return this.client.uiRetrySubmission(this.sessionID, this.directory).then(() => { void this.refresh(); }); }
  discardPendingDraft(): Promise<void> { return this.client.uiResolveDraft(this.sessionID, this.directory, { kind: "discard" }).then(() => { void this.refresh(); }); }

  // ---------------------------------------------------------------- stream
  private patch(next: Partial<PluginUiView>): void {
    if (this.disposed) return;
    this.view = { ...this.view, ...next };
    for (const listener of [...this.listeners]) listener();
  }

  private closeSurfaces(reason: string): void {
    for (const entry of [...this.surfaces]) { this.surfaces.delete(entry); try { entry.handlers.onClosed(reason); } catch { /* view already gone */ } }
  }

  private restart(): void {
    if (this.disposed) return;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    const generation = ++this.runGeneration;
    this.patch({ phase: "connecting", detail: "Подключаю интерфейс расширений…" });
    void this.run(generation, abort.signal);
  }

  private async run(generation: number, signal: AbortSignal): Promise<void> {
    let failures = 0;
    const live = () => !this.disposed && generation === this.runGeneration && !signal.aborted;
    while (live()) {
      const mode = this.wantOpen ? "open" : "events";
      let greeted = false;
      try {
        const send = () => fetch(this.client.uiStreamUrl(this.sessionID, this.directory, mode), {
          headers: { ...this.client.authorization(), Accept: "text/event-stream" }, signal, cache: "no-store" });
        let response = await send();
        if (response.status === 401) { await response.body?.cancel(); await this.client.reconnect(); response = await send(); }
        if (response.status === 503 && mode === "open") {
          // Maintenance: keep watching an already-live surface read-only.
          await response.body?.cancel(); this.wantOpen = false;
          this.patch({ detail: "Enki обновляется: интерфейс расширения доступен только для просмотра." });
          continue;
        }
        if ([400, 403, 404, 409].includes(response.status)) {
          let message = `HTTP ${response.status}`;
          try { const body: unknown = await response.json(); if (record(body) && typeof body.message === "string") message = body.message; } catch { /* no body */ }
          this.patch({ phase: "error", detail: message });
          return;
        }
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
        const reader = response.body.getReader(), decoder = new TextDecoder(), frames = new SseDecoder();
        try {
          while (live()) {
            const { done, value } = await reader.read();
            if (done || !live()) break;
            frames.push(decoder.decode(value, { stream: true }), data => {
              if (!live()) return false;
              let parsed: unknown;
              try { parsed = JSON.parse(data); } catch { return true; }
              const message = parseUiMessage(parsed);
              if (message) { if (message.type === "ui.hello" || message.type === "ui.waiting") greeted = true; this.handle(message); }
              return live();
            });
          }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      } catch {
        if (!live()) return;
      }
      if (!live()) return;
      this.closeSurfaces("Связь с интерфейсом расширения прервана. Переподключаю…");
      failures = greeted ? 0 : failures + 1;
      if (failures >= MAX_FAILURES) { this.patch({ phase: "error", detail: "Не удалось подключить интерфейс расширений. Нажмите «Подключиться снова»." }); return; }
      this.patch({ phase: "reconnecting", detail: "Переподключаю интерфейс расширений…" });
      const delay = Math.min(15_000, 500 * 2 ** failures);
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, delay);
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }

  private handle(message: UiStreamMessage): void {
    const scope = this.view.snapshot?.scope ?? null;
    switch (message.type) {
      case "ui.waiting":
        this.closeSurfaces("Интерфейс расширения ещё не запущен.");
        this.patch({ phase: "waiting", detail: "Расширения запустятся вместе с агентом этого чата.", snapshot: null });
        return;
      case "ui.hello": {
        if (scope && !sameScope(scope, message.snapshot.scope)) this.closeSurfaces("Интерфейс расширения перезапущен.");
        this.patch({ phase: "live", detail: "", snapshot: message.snapshot, draftRevision: message.snapshot.draft.revision, generation: this.view.generation + 1 });
        return;
      }
      case "ui.reset":
        for (const entry of [...this.surfaces]) if (sameScope(entry.scope, message.attachment.scope)) entry.handlers.onReset(message.attachment);
        return;
      case "ui.vt":
        for (const entry of [...this.surfaces]) if (sameScope(entry.scope, message.frame)) entry.handlers.onFrame(message.frame);
        return;
      case "ui.invalid":
        for (const entry of [...this.surfaces]) entry.handlers.onInvalid();
        return;
      case "ui.closed":
        this.closeSurfaces(message.reason || "Интерфейс расширения закрыт.");
        this.patch({ phase: "closed", detail: message.reason || "Интерфейс расширения закрыт." });
        return;
      case "ui.event": this.event(message.event.type, message.event.properties, scope);
    }
  }

  /** Journal projections of this session; stale epochs are ignored. */
  private event(type: string, p: Record<string, unknown>, scope: UiScope | null): void {
    const snapshot = this.view.snapshot;
    if (record(p.scope) && scope && p.scope.sessionEpoch !== scope.sessionEpoch) return;
    if (type === "extension.notify" || type === "extension.ui.error") {
      const text = typeof p.message === "string" ? p.message : typeof p.error === "string" ? p.error : "";
      if (text) this.patch({ notices: [...this.view.notices, { at: Date.now(), level: typeof p.level === "string" ? p.level : type === "extension.ui.error" ? "error" : "info", text }].slice(-5) });
      return;
    }
    if (type === "extension.ui.mode") { this.patch({ mode: { custom: p.custom === true, terminalInput: p.terminalInput === true } }); return; }
    if (type === "extension.draft" && typeof p.revision === "number") { if (p.revision > this.view.draftRevision) this.patch({ draftRevision: p.revision }); return; }
    if (!snapshot) return;
    const s = p.snapshot;
    if (type === "extension.ui.state" && record(s) && Array.isArray(s.widgets) && record(s.statuses)) {
      const previous = snapshot.state, working = s.working;
      const state: UiSurfaceState = {
        revision: typeof s.revision === "number" ? s.revision : previous.revision,
        statuses: Object.fromEntries(Object.entries(s.statuses).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        working: record(working) ? { message: typeof working.message === "string" ? working.message : null, visible: working.visible === true, indicator: null } : previous.working,
        hiddenThinkingLabel: typeof s.hiddenThinkingLabel === "string" ? s.hiddenThinkingLabel : null,
        title: typeof s.title === "string" ? s.title : previous.title,
        toolsExpanded: typeof s.toolsExpanded === "boolean" ? s.toolsExpanded : previous.toolsExpanded,
        themeName: typeof s.themeName === "string" ? s.themeName : null,
        widgets: s.widgets.filter(record).map(widget => ({
          key: String(widget.key), placement: widget.placement === "belowEditor" ? "belowEditor" as const : "aboveEditor" as const,
          kind: widget.kind === "component" ? "component" as const : "text" as const,
          ...(Array.isArray(widget.lines) ? { lines: widget.lines.filter((line): line is string => typeof line === "string") } : {}) })),
      };
      this.patch({ snapshot: { ...snapshot, state } });
      return;
    }
    // Pending projections are re-read through the principal-specific snapshot.
    if (type === "extension.draft.pending" || type === "extension.draft.submission") void this.refresh().catch(() => undefined);
  }
}

export type { PendingDraftChange, PendingSubmission };
