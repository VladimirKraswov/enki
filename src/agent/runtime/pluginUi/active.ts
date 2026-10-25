// One plugin UI stream per window: the selected chat. Switching chats settles the
// pending draft mutation BEFORE the stream (and with it this window's UI
// authority) closes; the composer text itself is never cleared by switching.
import type { RuntimeClient } from "../client";
import { DraftCasSync } from "./draftSync";
import { PluginUiSession } from "./session";

export interface ChatDraftStore {
  draftFor(sessionId: string, directory: string): string;
  setDraftFor(sessionId: string, directory: string, text: string): void;
}
export interface ActiveUi { key: string; session: PluginUiSession; draft: DraftCasSync }

class ActivePluginUi {
  private current: (ActiveUi & { stop: () => void }) | null = null;
  private composingValue = false;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly get = (): ActiveUi | null => this.current;

  /** IME composition in the composer (a composition is never sent or overwritten). */
  setComposing(value: boolean): void {
    const ended = this.composingValue && !value;
    this.composingValue = value;
    if (ended) this.current?.draft.compositionEnded();
  }
  /** Composer text of the active chat changed. */
  localChanged(): void { this.current?.draft.localChanged(); }

  activate(client: RuntimeClient, sessionId: string, directory: string, drafts: ChatDraftStore): ActiveUi {
    const key = `${client.endpoint}\n${sessionId}\n${directory}`;
    if (this.current?.key === key && this.current.session.client === client) return this.current;
    void this.deactivate();
    const session = new PluginUiSession(client, sessionId, directory);
    const draft = new DraftCasSync(session, {
      read: () => drafts.draftFor(sessionId, directory),
      write: text => drafts.setDraftFor(sessionId, directory, text),
      composing: () => this.composingValue && this.current?.session === session,
    });
    let generation = -1, revision = -1;
    const stop = session.subscribe(() => {
      const view = session.getView();
      if (view.phase !== "live" || !view.snapshot) { if (generation !== -1) draft.offline(); generation = -1; return; }
      if (view.generation !== generation) { generation = view.generation; revision = view.draftRevision; draft.hydrate(view.snapshot.draft); return; }
      if (view.draftRevision > revision) { revision = view.draftRevision; void draft.remoteRevision(revision); }
    });
    this.current = { key, session, draft, stop };
    session.start();
    this.emit();
    return this.current;
  }

  async deactivate(): Promise<void> {
    const previous = this.current;
    if (!previous) return;
    this.current = null;
    this.emit();
    previous.stop();
    await previous.draft.settle().catch(() => undefined);
    previous.draft.dispose();
    previous.session.dispose();
  }

  private emit(): void { for (const listener of [...this.listeners]) listener(); }
}

export const activePluginUi = new ActivePluginUi();
