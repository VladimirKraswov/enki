import type { AgentBackend } from '../agent/backend';
import type { EngineId } from './engines';
import type { ModelChoice } from './modelChoice';
import type { AppState, UiState } from './types';
import type { Submission } from './submission';
import { PI_BACKEND_ID } from '../agent/ids';
import { attachmentDrafts, attachmentScope, type DraftAttachment } from '../attachments/drafts';
import { newMessageId, type QueuedPrompt } from './queue';
import { savePrefs, flushPrefs } from './prefs';
import { errText } from './errors';

/** Errors that must pause the queue: a fatal provider/auth failure or an explicit stop.
 * Recoverable failures (output limit, context overflow, connection, tool errors) keep
 * the queue armed so the next item still runs, as the owner expects. */
export function isQueuePausingError(error: string | null | undefined): boolean {
  return !!error && /insufficient.?balance|insufficient.?credits|payment required|недостаточно средств|quota exceeded|unauthorized|invalid api key|authentication failed|\baborted\b|\bstopped\b/i.test(error);
}

/** Queue/editor orchestration; transport dispatch remains behind the host port. */
export interface PromptQueueHost {
  snapshot(): AppState;
  generation(): number;
  mutate(patch: Partial<AppState> | ((state: AppState) => Partial<AppState>)): void;
  patchUi(patch: Partial<UiState>): void;
  persistPrefs(): void;
  getModelChoice(): ModelChoice | null;
  getAgentChoice(): string | null;
  getDraft(): string;
  setDraft(text: string): void;
  conversation(): AgentBackend;
  engineReady(): boolean;
  engineIdFor(): EngineId;
  isRunning(sessionID: string): boolean;
  externalLock(sessionID: string): boolean;
  pendingInteraction(sessionID: string): { permissions: readonly unknown[]; questions: readonly unknown[] };
  dispatchQueued(item: QueuedPrompt, steer: boolean): Promise<void>;
  beginSending(): Submission;
  finishSending(operation: Submission): boolean;
}

export class PromptQueueController {
  readonly queueArmed = new Set<string>();
  readonly queueLocks = new Set<string>();
  readonly queueStops = new Map<string, number>();
  private queueEdits = new Map<string, { id: string; scope: string; directory: string }>();

  constructor(private readonly host: PromptQueueHost) {}
  private get state() { return this.host.snapshot(); }
  private get directoryGeneration() { return this.host.generation(); }

  getQueue(id = this.state.activeSessionId): QueuedPrompt[] {
    return id ? (this.state.prefs.queues?.[id] ?? []) : [];
  }
  isQueueArmed(id = this.state.activeSessionId) {
    return !!id && this.queueArmed.has(id);
  }
  writeQueue(id: string, list: QueuedPrompt[], durable = false): boolean {
    const previous = this.state.prefs;
    const prefs = { ...previous, queues: { ...previous.queues, [id]: list } };
    if (durable) {
      // Commit before publishing: observers must never dispatch an unsaved item.
      savePrefs(prefs);
      if (!flushPrefs()) {
        savePrefs(previous);
        this.host.patchUi({ sendError: 'Не удалось сохранить очередь. Черновик сохранён.' });
        return false;
      }
    }
    this.host.mutate({ prefs });
    this.host.persistPrefs();
    return true;
  }
  reorderQueued(id: string, before: string | null): boolean {
    const sid = this.state.activeSessionId, queue = this.getQueue();
    if (!sid || this.state.ui.sending || this.isQueueLocked() || this.getQueueEdit() || queue.some(item => item.state !== "ready")) return false;
    const item = queue.find(item => item.id === id);
    if (!item || before === id || (before !== null && !queue.some(item => item.id === before))) return false;
    const reordered = queue.filter(item => item.id !== id);
    reordered.splice(before === null ? reordered.length : reordered.findIndex(item => item.id === before), 0, item);
    if (reordered.every((item, i) => item === queue[i])) return false;
    return this.writeQueue(sid, reordered, true);
  }
  enqueuePrompt(text: string, attachments?: QueuedPrompt["attachments"], captured?: Pick<QueuedPrompt, "model" | "agent">): boolean {
    const id = this.state.activeSessionId,
      directory = this.state.directory,
      model = captured?.model ?? this.host.getModelChoice();
    if (
      !id ||
      !directory ||
      !model ||
      (!text.trim() && !attachments?.files.length) ||
      this.getQueue(id).length >= 20
    )
      return false;
    const item: QueuedPrompt = {
      id: newMessageId(),
      text: text.trim() || "Проанализируй приложенные файлы.",
      attachments,
      sessionID: id,
      directory,
      model: { ...model },
      agent: captured ? captured.agent : this.host.getAgentChoice() ?? undefined,
      state: "ready",
      queuedAt: Date.now(),
    };
    if (!this.writeQueue(id, [...this.getQueue(id), item], true)) return false;
    this.queueArmed.add(id);
    if (this.host.getDraft() === text) this.host.setDraft("");
    void this.drainQueue();
    return true;
  }
  async enqueueWithAttachments(text: string, files: DraftAttachment[]): Promise<boolean> {
    if (this.getQueueEdit()) return this.applyQueueEdit(text, files);
    if (!files.length) return this.enqueuePrompt(text);
    const sid = this.state.activeSessionId, directory = this.state.directory;
    if (!sid || !directory || this.state.ui.sending || this.getQueue(sid).length >= 20) return false;
    const workspace = this.state.prefs.workspaceKey ?? this.state.prefs.endpoint;
    const backend = this.host.conversation(), gen = this.directoryGeneration;
    const model = this.host.getModelChoice();
    if (!model) return false;
    const captured = { model: { ...model }, agent: this.host.getAgentChoice() ?? undefined };
    const from = attachmentScope(workspace, directory, sid);
    const target = `${from}:queue:${newMessageId()}`;
    const current = () => !operation.signal.aborted && this.state.activeSessionId === sid && this.state.directory === directory
      && gen === this.directoryGeneration && this.host.conversation() === backend;
    const operation = this.host.beginSending();
    let copies: DraftAttachment[] = [], queued: string | undefined;
    try {
      files = await attachmentDrafts.selected(from, files.map(file => file.id));
      if (!current() || (!text.trim() && !files.length)) return false;
      if (files.length) copies = await attachmentDrafts.copy(from, target, files.map(file => file.id));
      if (!current()) return false;
      const metadata = copies.length ? { scope: target, files: copies.map(({blob: _blob, ...file}) => file) } : undefined;
      // Block automatic dispatch until both IndexedDB and preferences are durable.
      if (!this.enqueuePrompt(text, metadata, captured)) return false;
      queued = this.getQueue(sid)[this.getQueue(sid).length - 1].id;
      // Remove only captured IDs; files added later belong to the next draft.
      try { await attachmentDrafts.remove(from, files.map(file => file.id)); }
      catch { if (current()) this.host.patchUi({ toast: "Запрос в очереди; копии вложений остались в черновике. Уберите их перед следующим запросом." }); }
      return true;
    } catch (error) {
      if (current()) this.host.patchUi({ sendError: errText(error) });
      return false;
    } finally {
      if (!queued && copies.length) await attachmentDrafts.remove(target, copies.map(file => file.id)).catch(() => {});
      if (this.host.finishSending(operation) && current()) void this.drainQueue();
    }
  }
  async removeQueued(id: string) {
    const sid = this.state.activeSessionId;
    if (!sid || this.queueLocks.has(sid)) return;
    const item = this.getQueue(sid).find(x => x.id === id);
    const previous = this.getQueue(sid);
    if (!this.writeQueue(sid, previous.filter(x => x.id !== id), true)) return;
    if (item?.attachments) await attachmentDrafts.remove(item.attachments.scope, item.attachments.files.map(file => file.id)).catch(() => {});
  }
  isQueueLocked() { return !!this.state.activeSessionId && this.queueLocks.has(this.state.activeSessionId); }
  releaseQueueLock(sid: string) {
    this.queueLocks.delete(sid);
    this.host.mutate(() => ({})); // Operation completion must re-enable the visible controls.
  }
  async removeQueuedAttachment(id: string, fileID: string) {
    const sid = this.state.activeSessionId;
    if (!sid || this.queueLocks.has(sid) || this.state.ui.sending) return;
    const item = this.getQueue(sid).find(q => q.id === id);
    if (!item || item.state !== 'ready' || !item.attachments?.files.some(f => f.id === fileID)) return;
    const directory = this.state.directory, gen = this.directoryGeneration;
    this.queueLocks.add(sid);
    try {
      const previous = this.getQueue(sid), files = item.attachments.files.filter(f => f.id !== fileID);
      if (!this.writeQueue(sid, previous.map(q => q.id === id ? {...q, attachments: files.length ? {...item.attachments!, files} : undefined, error: undefined} : q), true)) return;
      await attachmentDrafts.remove(item.attachments.scope, [fileID]);
      if (gen === this.directoryGeneration && directory === this.state.directory && sid === this.state.activeSessionId)
        this.host.patchUi({sendError: null});
    } catch (error) {
      if (gen === this.directoryGeneration && sid === this.state.activeSessionId) this.host.patchUi({sendError: errText(error)});
    } finally { this.releaseQueueLock(sid); }
  }
  getQueueEdit() {
    const edit = this.state.activeSessionId ? this.queueEdits.get(this.state.activeSessionId) : undefined;
    const scope = attachmentScope(this.state.prefs.workspaceKey ?? this.state.prefs.endpoint, this.state.directory, this.state.activeSessionId);
    return edit?.scope === scope ? edit : undefined;
  }
  async editQueued(id: string) {
    const item = this.getQueue().find(x => x.id === id);
    if (!item || item.state !== "ready" || this.host.getDraft().trim() || this.state.ui.sending || this.queueLocks.has(item.sessionID)) return false;
    const sid = item.sessionID, directory = item.directory, gen = this.directoryGeneration;
    const scope = attachmentScope(this.state.prefs.workspaceKey ?? this.state.prefs.endpoint, directory, sid);
    const current = () => gen === this.directoryGeneration && sid === this.state.activeSessionId && directory === this.state.directory;
    this.queueLocks.add(sid);
    let copies: DraftAttachment[] = [], editing = false;
    try {
      await attachmentDrafts.ensure(scope);
      if (!current() || this.host.getDraft().trim() || attachmentDrafts.snapshot(scope).length) return false;
      if (item.attachments) copies = await attachmentDrafts.copy(item.attachments.scope, scope, item.attachments.files.map(file => file.id));
      if (!current() || this.host.getDraft().trim()) return false;
      // Keep the original persisted entry and its position until Apply succeeds.
      this.queueEdits.set(sid, { id, scope, directory });
      editing = true;
      this.host.setDraft(item.text);
      return true;
    } catch (error) { if (current()) this.host.patchUi({ sendError: errText(error) }); return false; }
    finally {
      if (!editing) {
        this.releaseQueueLock(sid);
        if (copies.length) await attachmentDrafts.remove(scope, copies.map(file => file.id)).catch(() => {});
      }
    }
  }
  async cancelQueueEdit() {
    const edit = this.getQueueEdit(), sid = this.state.activeSessionId;
    if (!edit || !sid || this.state.ui.sending) return;
    const files = attachmentDrafts.snapshot(edit.scope);
    this.queueEdits.delete(sid);
    this.releaseQueueLock(sid);
    this.host.setDraft("");
    await attachmentDrafts.remove(edit.scope, files.map(file => file.id)).catch(() => {});
    void this.drainQueue();
  }
  async applyQueueEdit(text: string, files: DraftAttachment[], drain = true): Promise<boolean> {
    const edit = this.getQueueEdit(), sid = this.state.activeSessionId;
    if (!edit || !sid || this.state.ui.sending || (!text.trim() && !files.length)) return false;
    const item = this.getQueue(sid).find(q => q.id === edit.id);
    if (!item || item.state !== "ready") return false;
    const gen = this.directoryGeneration;
    const current = () => !operation.signal.aborted && gen === this.directoryGeneration && sid === this.state.activeSessionId && this.getQueueEdit() === edit;
    const target = `${edit.scope}:queue:${newMessageId()}`;
    let copies: DraftAttachment[] = [], saved = false;
    const operation = this.host.beginSending();
    try {
      files = await attachmentDrafts.selected(edit.scope, files.map(file => file.id));
      if (!text.trim() && !files.length) return false;
      if (files.length) copies = await attachmentDrafts.copy(edit.scope, target, files.map(file => file.id));
      if (!current()) return false;
      const previous = this.getQueue(sid);
      const attachments = copies.length ? { scope: target, files: copies.map(({ blob: _blob, ...file }) => file) } : undefined;
      if (!this.writeQueue(sid, previous.map(q => q.id === item.id ? { ...q, text: text.trim() || "Проанализируй приложенные файлы.", attachments, error: undefined } : q), true)) return false;
      saved = true;
      this.queueEdits.delete(sid);
      this.releaseQueueLock(sid);
      if (this.host.getDraft() === text) this.host.setDraft("");
      await attachmentDrafts.remove(edit.scope, files.map(file => file.id)).catch(() => {});
      if (item.attachments) await attachmentDrafts.remove(item.attachments.scope, item.attachments.files.map(file => file.id)).catch(() => {});
      return true;
    } catch (error) { if (current()) this.host.patchUi({ sendError: errText(error) }); return false; }
    finally {
      if (!saved && copies.length) await attachmentDrafts.remove(target, copies.map(file => file.id)).catch(() => {});
      if (this.host.finishSending(operation) && gen === this.directoryGeneration && sid === this.state.activeSessionId && saved && drain) void this.drainQueue();
    }
  }
  /** Explicit recovery acknowledges the old failure; future error events still pause. */
  resumeQueue(useSelectedModel = false) {
    const sid = this.state.activeSessionId;
    const queue = this.getQueue();
    if (!sid || !queue.length || queue[0].state !== "ready" || this.queueLocks.has(sid)) return;
    const model = useSelectedModel ? this.host.getModelChoice() : null;
    if (useSelectedModel && !model) return;
    if ((useSelectedModel || queue.some(item => item.state === "ready" && item.error)) &&
      !this.writeQueue(sid, queue.map(item => item.state === "ready"
        ? { ...item, ...(model ? { model: { ...model } } : {}), error: undefined } : item), true)) return;
    const chat = this.state.chat.sessions[sid];
    if (chat) this.host.mutate(s => ({ chat: { ...s.chat, sessions: { ...s.chat.sessions, [sid]: { ...chat, lastError: null } } } }));
    this.queueArmed.add(sid);
    this.host.patchUi({ sendError: null });
    void this.drainQueue();
  }
  queueRecoveryReason(): string | null {
    if (this.isQueueArmed() || !this.getQueue().length) return null;
    const sid = this.state.activeSessionId;
    const error = (sid ? this.state.chat.sessions[sid]?.lastError : null) || this.getQueue()[0]?.error;
    if (!error) return null;
    if (/insufficient.?balance|insufficient.?credits|payment required/i.test(error))
      return "Недостаточно средств у провайдера. Пополните баланс или выберите другую модель и продолжите очередь. Задания сохранены.";
    return "Очередь остановлена после ошибки. Устраните причину и продолжите; задания сохранены.";
  }
  queueHasDifferentModel(): boolean {
    const model = this.host.getModelChoice();
    return !!model && this.getQueue().some(item => item.state === "ready" &&
      (item.model.providerID !== model.providerID || item.model.modelID !== model.modelID || item.model.variant !== model.variant));
  }
  async drainQueue(explicit = false) {
    const sid = this.state.activeSessionId;
    if (
      !sid ||
      !this.queueArmed.has(sid) ||
      this.host.isRunning(sid) ||
      this.state.ui.sending ||
      this.queueLocks.has(sid) ||
      this.host.externalLock(sid)
    )
      return;
    if (
      !this.host.engineReady() ||
      (this.host.engineIdFor() !== PI_BACKEND_ID && !!this.state.connection.statusError) ||
      (this.host.engineIdFor() !== PI_BACKEND_ID && this.state.connection.streamState !== "open")
    )
      return;
    if (!explicit && isQueuePausingError(this.state.chat.sessions[sid]?.lastError)) {
      this.queueArmed.delete(sid);
      return;
    }
    const pending = this.host.pendingInteraction(sid);
    if (pending.permissions.length || pending.questions.length) return;
    const item = this.getQueue(sid)[0];
    if (
      !item ||
      item.state !== "ready" ||
      item.directory !== this.state.directory
    )
      return;
    await this.host.dispatchQueued(item, false);
  }
  async steerQueued(id: string) {
    if (this.state.ui.sending) return;
    const edit = this.getQueueEdit(), sid = this.state.activeSessionId, gen = this.directoryGeneration;
    const stopped = sid ? this.queueStops.get(sid) ?? 0 : 0;
    if (edit) {
      if (edit.id !== id) { this.host.patchUi({toast: 'Завершите редактирование текущего запроса.'}); return; }
      if (!await this.applyQueueEdit(this.host.getDraft(), attachmentDrafts.snapshot(edit.scope), false)) return;
      if (gen !== this.directoryGeneration || sid !== this.state.activeSessionId || (sid && (this.queueStops.get(sid) ?? 0) !== stopped)) return;
    }
    const item = this.getQueue().find((x) => x.id === id);
    if (!item || item.state !== "ready") return;
    await this.host.dispatchQueued(item, true);
  }
}
