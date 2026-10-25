// The normal React composer and the plugin editor share ONE canonical draft: the
// runtime EditorDraftCas (revision + mutation id). The composer text is this
// window's pending local state on top of a known base revision:
// - one mutation in flight, sent in order; newer local text waits for its ACK;
// - a lost ACK is retried with the SAME id/base/text (the runtime replays it);
// - a stale base is an explicit conflict: nothing is overwritten silently and the
//   local text is kept (and offered back) whichever side the user chooses;
// - nothing is sent or applied during an IME composition;
// - attachments are not part of the text draft and are never touched here.
import type { RuntimeClient } from "../client";
import type { DraftSnapshot } from "./types";

/** What the draft sync needs from the session UI connection (PluginUiSession implements it). */
export interface DraftSessionPort {
  readonly sessionID: string;
  readonly directory: string;
  readonly client: Pick<RuntimeClient, "uiDraft">;
  /** Principal-specific snapshot re-read; null when the surface changed or is gone. */
  refresh(): Promise<{ draft: DraftSnapshot } | null>;
}

export interface DraftHost {
  /** Composer text of THIS chat (prefs draft), including unsent edits. */
  read(): string;
  /** Replace it with canonical text (never called while composing). */
  write(text: string): void;
  composing(): boolean;
}
export type DraftSyncState =
  | { kind: "offline" }
  | { kind: "synced"; revision: number }
  | { kind: "sending"; revision: number }
  | { kind: "retrying"; message: string }
  | { kind: "conflict"; local: string; canonical: DraftSnapshot; message: string };

interface Mutation { id: string; baseRevision: number; text: string }
/** Last acknowledged base per chat for this window, so a returning tab knows what it saw. */
const bases = new Map<string, { revision: number; text: string }>();

export class DraftCasSync {
  private base: { revision: number; text: string } | null;
  private inflight: Mutation | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deferred: DraftSnapshot | null = null;
  private stateValue: DraftSyncState = { kind: "offline" };
  private readonly listeners = new Set<() => void>();
  private live = false;
  private disposed = false;
  /** Text replaced by "take theirs", offered back to the user instead of being lost. */
  stash: string | null = null;

  constructor(private readonly session: DraftSessionPort, private readonly host: DraftHost, private readonly newId: () => string = () => crypto.randomUUID()) {
    this.base = bases.get(session.sessionID) ?? null;
  }

  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getState = (): DraftSyncState => this.stateValue;

  private set(state: DraftSyncState): void {
    this.stateValue = state;
    for (const listener of [...this.listeners]) listener();
  }
  private acknowledge(revision: number, text: string): void {
    this.base = { revision, text };
    bases.set(this.session.sessionID, this.base);
  }

  /** A live surface greeted this window (first time, reconnect or new epoch). */
  hydrate(snapshot: DraftSnapshot): void {
    if (this.disposed) return;
    this.live = true;
    if (this.inflight) { void this.send(this.inflight); return; } // same id after reconnect
    const local = this.host.read();
    if (local === snapshot.text) { this.acknowledge(snapshot.revision, snapshot.text); this.set({ kind: "synced", revision: snapshot.revision }); return; }
    if (this.base && snapshot.revision === this.base.revision) { this.acknowledge(snapshot.revision, snapshot.text); this.schedule(0); return; }
    if (this.base && snapshot.revision > this.base.revision) { this.remote(snapshot); return; }
    // First contact in this window: never discard either text silently.
    if (!local) { this.apply(snapshot); return; }
    if (!snapshot.text) { this.acknowledge(snapshot.revision, snapshot.text); this.schedule(0); return; }
    this.set({ kind: "conflict", local, canonical: snapshot, message: "В этом чате уже сохранён другой черновик (из редактора расширения)." });
  }

  /** The surface went away: keep local text, stop sending until the next hello. */
  offline(): void { this.live = false; this.clearTimer(); if (this.stateValue.kind !== "conflict") this.set({ kind: "offline" }); }

  /** Composer text changed (also during composition; sending waits for its end). */
  localChanged(): void { if (this.live && this.stateValue.kind !== "conflict") this.schedule(250); }
  compositionEnded(): void {
    if (this.deferred) { const remote = this.deferred; this.deferred = null; this.remote(remote); return; }
    this.localChanged();
  }

  /** The runtime announced a newer canonical revision. */
  async remoteRevision(revision: number): Promise<void> {
    if (!this.live || this.inflight || !this.base || revision <= this.base.revision) return;
    const snapshot = await this.session.refresh().catch(() => null);
    if (snapshot && !this.inflight) this.remote(snapshot.draft);
  }

  private remote(snapshot: DraftSnapshot): void {
    if (this.base && snapshot.revision <= this.base.revision) return;
    if (this.host.composing()) { this.deferred = snapshot; return; }
    const local = this.host.read();
    if (local === snapshot.text) { this.acknowledge(snapshot.revision, snapshot.text); this.set({ kind: "synced", revision: snapshot.revision }); return; }
    // No unsent local edit on top of the last base: follow the canonical draft.
    if (!this.base || local === this.base.text) { this.apply(snapshot); return; }
    this.clearTimer();
    this.set({ kind: "conflict", local, canonical: snapshot, message: "Черновик изменился в редакторе расширения, пока вы печатали." });
  }

  private apply(snapshot: DraftSnapshot): void {
    this.host.write(snapshot.text);
    this.acknowledge(snapshot.revision, snapshot.text);
    this.set({ kind: "synced", revision: snapshot.revision });
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, delay);
  }
  private clearTimer(): void { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }

  /** Sends the newest local text, one mutation at a time. */
  async flush(): Promise<void> {
    if (this.disposed || !this.live || this.inflight || !this.base || this.host.composing() || this.stateValue.kind === "conflict") return;
    const text = this.host.read();
    if (text === this.base.text) { this.set({ kind: "synced", revision: this.base.revision }); return; }
    this.inflight = { id: this.newId(), baseRevision: this.base.revision, text };
    await this.send(this.inflight);
  }

  private async send(mutation: Mutation, attempt = 0): Promise<void> {
    if (this.disposed || !this.live || this.inflight !== mutation) return;
    this.set({ kind: "sending", revision: mutation.baseRevision });
    let result: Awaited<ReturnType<RuntimeClient["uiDraft"]>>;
    try { result = await this.session.client.uiDraft(this.session.sessionID, this.session.directory, mutation); }
    catch (error) {
      if (this.disposed || this.inflight !== mutation) return;
      // Unknown outcome: the SAME mutation is retried; nothing newer is sent before it.
      this.set({ kind: "retrying", message: error instanceof Error ? error.message : "Нет связи с Enki Runtime." });
      if (this.live) this.timer = setTimeout(() => { this.timer = null; void this.send(mutation, attempt + 1); }, Math.min(10_000, 500 * 2 ** attempt));
      return;
    }
    if (this.inflight !== mutation) return;
    this.inflight = null;
    if (result.ok) {
      this.acknowledge(result.result.snapshot.revision, mutation.text);
      if (this.host.read() !== mutation.text) this.schedule(0);
      else this.set({ kind: "synced", revision: result.result.snapshot.revision });
      return;
    }
    const canonical = result.canonical;
    if (canonical) this.set({ kind: "conflict", local: this.host.read(), canonical, message: result.message });
    else this.set({ kind: "retrying", message: result.message });
  }

  /** Explicit choice: my composer text replaces the canonical draft (new id, current base). */
  async keepMine(): Promise<void> {
    const state = this.stateValue;
    if (state.kind !== "conflict") return;
    this.acknowledge(state.canonical.revision, state.canonical.text);
    this.inflight = { id: this.newId(), baseRevision: state.canonical.revision, text: this.host.read() };
    await this.send(this.inflight);
  }

  /** Explicit choice: take the canonical draft; my text stays available in `stash`. */
  takeTheirs(): void {
    const state = this.stateValue;
    if (state.kind !== "conflict" || this.host.composing()) return;
    const local = this.host.read();
    this.stash = local && local !== state.canonical.text ? local : this.stash;
    this.apply(state.canonical);
  }

  /** Restore the stashed text as a new local edit (sent through the normal CAS path). */
  restoreStash(): void {
    if (this.stash === null || this.host.composing()) return;
    const text = this.stash;
    this.stash = null;
    this.host.write(text);
    this.localChanged();
  }

  /** Before the stream (and this window's UI authority) closes: deliver pending text. */
  async settle(deadlineMs = 2_000): Promise<void> {
    this.clearTimer();
    const work = this.inflight ? this.send(this.inflight) : this.flush();
    await Promise.race([work, new Promise<void>(resolve => setTimeout(resolve, deadlineMs))]);
  }

  dispose(): void { this.disposed = true; this.live = false; this.clearTimer(); this.listeners.clear(); }
}
