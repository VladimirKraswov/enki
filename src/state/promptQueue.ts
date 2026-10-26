// Client side of the runtime-owned prompt queue.
//
// The Enki Runtime persists every queued prompt (with its prepared
// attachments), decides when the next one runs and classifies pausing errors.
// This controller only mirrors the runtime's queue state (snapshot +
// `queue.updated` events) and forwards user intent: add, edit, reorder, remove,
// steer, pause and resume. Nothing here dispatches a prompt, so a reload, a
// hidden window or a closed chat never stops or duplicates queued work.
import type { ModelRef, PromptPart, QueueItemDTO, QueueStateDTO } from "../../src-tauri/resources/agent/src/protocol";
import { isQueuePausingError } from "../../src-tauri/resources/agent/src/protocol";
import { acceptedReceipt, type RuntimeBackend } from "../agent/runtime/backend";
import { ApiError, ConnectionError } from "../api/http";
import { attachmentDrafts, attachmentScope, type DraftAttachment } from "../attachments/drafts";
import { errText } from "./errors";
import type { ModelChoice } from "./modelChoice";
import { newMessageId, type QueuedPrompt } from "./queue";
import type { Submission } from "./submission";
import type { AppState, UiState } from "./types";

export { isQueuePausingError };

export const QUEUE_LIMIT = 20;

export interface PromptQueueHost {
  snapshot(): AppState;
  generation(): number;
  mutate(patch: Partial<AppState> | ((state: AppState) => Partial<AppState>)): void;
  patchUi(patch: Partial<UiState>): void;
  getModelChoice(): ModelChoice | null;
  getDraft(): string;
  setDraft(text: string): void;
  backend(): RuntimeBackend | null;
  /**
   * Prepare draft files for this model exactly as a direct send would. `parts`
   * go to the runtime; `originals` keep the user's image bytes for the local
   * image-editing context, staged when the runtime dispatches the item.
   */
  prepareParts(files: DraftAttachment[], model: ModelChoice, signal: AbortSignal): Promise<{ parts: PromptPart[]; originals: PromptPart[] }>;
  /** The runtime durably holds this item now (after add or edit with new files). */
  queued?(item: { id: string; sessionID: string; directory: string; model: ModelRef; originals: PromptPart[] }): void;
  beginSending(): Submission;
  finishSending(operation: Submission): boolean;
}

interface QueueEdit { id: string; scope: string; directory: string; removed: Set<string> }
interface QueueScope { backend: RuntimeBackend; generation: number }

function queued(item: QueueItemDTO): QueuedPrompt {
  return {
    id: item.id, text: item.text, directory: item.directory, sessionID: item.sessionID,
    model: { ...item.model }, state: item.state, ...(item.error ? { error: item.error } : {}), queuedAt: item.queuedAt,
    ...(item.attachments?.length ? { attachments: { scope: "runtime", files: item.attachments } } : {}),
  };
}

export class PromptQueueController {
  private edits = new Map<string, QueueEdit>();
  private locks = new Map<string, QueueScope>();
  private revisions = new Map<string, number>();
  /** Chats with a correction request in flight (double-click fence). */
  private steering = new Map<string, QueueScope>();

  constructor(private readonly host: PromptQueueHost) {}
  private get state() { return this.host.snapshot(); }

  /** Authoritative queue state from the runtime (snapshot, event or response). */
  apply(queue: QueueStateDTO): void {
    this.revisions.set(queue.sessionID, (this.revisions.get(queue.sessionID) ?? 0) + 1);
    this.host.mutate(s => ({ queues: { ...s.queues, [queue.sessionID]: queue } }));
    const edit = this.edits.get(queue.sessionID);
    const workspace = this.state.prefs.workspaceKey ?? this.state.prefs.endpoint;
    if (edit && edit.scope === attachmentScope(workspace, edit.directory, queue.sessionID)
      && !queue.items.some(item => item.id === edit.id && item.state === "ready")) {
      // The edited item was delivered or removed elsewhere: end the edit, keep the draft.
      this.edits.delete(queue.sessionID);
      this.locks.delete(queue.sessionID);
      if (queue.sessionID === this.state.activeSessionId)
        this.host.patchUi({ toast: "Запрос уже отправлен или удалён из очереди. Текст остался в поле ввода." });
    }
  }

  replaceAll(queues: QueueStateDTO[], scope: (sessionID: string) => boolean): void {
    for (const id of new Set([...this.revisions.keys(), ...Object.keys(this.state.queues), ...queues.map(q => q.sessionID)]))
      if (scope(id)) this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    this.host.mutate(s => {
      const next = Object.fromEntries(Object.entries(s.queues).filter(([id]) => !scope(id)));
      for (const queue of queues) next[queue.sessionID] = queue;
      return { queues: next };
    });
  }

  async refresh(sessionID: string, directory: string, captured?: QueueScope): Promise<void> {
    const backend = captured?.backend ?? this.host.backend();
    if (!backend) return;
    const scope = captured ?? { backend, generation: this.host.generation() };
    if (!this.currentScope(scope)) return;
    const revision = this.revisions.get(sessionID) ?? 0;
    this.revisions.set(sessionID, revision);
    const queue = await backend.queue(sessionID, directory);
    // A newer stream event (e.g. durable delivery) wins over an older HTTP snapshot.
    if (this.currentScope(scope) && this.revisions.get(sessionID) === revision) this.apply(queue);
  }

  getQueue(id = this.state.activeSessionId): QueuedPrompt[] {
    return id ? (this.state.queues[id]?.items ?? []).map(queued) : [];
  }
  isQueueArmed(id = this.state.activeSessionId): boolean {
    return !!id && !!this.state.queues[id]?.armed;
  }
  pausedReason(id = this.state.activeSessionId): string | null {
    return id ? this.state.queues[id]?.pausedReason ?? null : null;
  }
  private locked(sid: string): boolean {
    return this.locks.get(sid)?.backend === this.host.backend() || sid === this.state.activeSessionId && !!this.getQueueEdit();
  }
  isQueueLocked(): boolean { return !!this.state.activeSessionId && this.locked(this.state.activeSessionId); }

  private context() {
    const sid = this.state.activeSessionId, directory = this.state.directory, backend = this.host.backend();
    return sid && directory && backend ? { sid, directory, backend, generation: this.host.generation() } : null;
  }

  private currentScope(scope: QueueScope): boolean {
    return scope.backend === this.host.backend() && scope.generation === this.host.generation();
  }

  private report(sid: string, error: unknown, scope?: QueueScope & { directory: string }): void {
    if (scope && !this.currentScope(scope)) return;
    if (sid === this.state.activeSessionId) this.host.patchUi({ sendError: errText(error) });
    // 409 on an item route: this chat's copy is stale (the item was delivered,
    // edited elsewhere, or belongs to another chat). Re-read the authoritative
    // queue once so the stale row disappears; nothing is retried.
    if (scope && error instanceof ApiError && error.status === 409) void this.refresh(sid, scope.directory, scope).catch(() => {});
  }

  /** Idempotent add: a lost acknowledgement is retried once with the same item id. */
  private async add(backend: RuntimeBackend, sid: string, directory: string, item: { id: string; text: string; parts: PromptPart[]; model: ModelRef }) {
    try { return await backend.client.enqueue(sid, directory, item); }
    catch (error) {
      if (!(error instanceof ConnectionError)) throw error;
      return backend.client.enqueue(sid, directory, item);
    }
  }

  async enqueueWithAttachments(text: string, files: DraftAttachment[]): Promise<boolean> {
    if (this.getQueueEdit()) return this.applyQueueEdit(text, files);
    const context = this.context();
    const model = this.host.getModelChoice();
    if (!context || !model || this.state.ui.sending || (!text.trim() && !files.length)) return false;
    const { sid, directory, backend } = context;
    if (this.getQueue(sid).length >= QUEUE_LIMIT) {
      this.host.patchUi({ sendError: `В очереди может быть до ${QUEUE_LIMIT} запросов.` });
      return false;
    }
    const workspace = this.state.prefs.workspaceKey ?? this.state.prefs.endpoint;
    const scope = attachmentScope(workspace, directory, sid), generation = this.host.generation();
    const operation = this.host.beginSending();
    const current = () => !operation.signal.aborted && generation === this.host.generation() && this.currentScope(context) && sid === this.state.activeSessionId;
    try {
      const selected = files.length ? await attachmentDrafts.selected(scope, files.map(file => file.id)) : [];
      if (!current() || (!text.trim() && !selected.length)) return false;
      const prepared = selected.length ? await this.host.prepareParts(selected, model, operation.signal) : { parts: [], originals: [] };
      if (!current()) return false;
      const id = newMessageId();
      const ref: ModelRef = { providerID: model.providerID, modelID: model.modelID, variant: model.variant ?? null };
      const queue = await this.add(backend, sid, directory, {
        id, text: text.trim() || "Проанализируй приложенные файлы.", parts: prepared.parts, model: ref,
      });
      // The old runtime still owns a successful add, but its acknowledgement
      // must not change a newly selected runtime's cache, drafts or image scope.
      if (!current()) return true;
      this.apply(queue);
      if (prepared.originals.length) this.host.queued?.({ id, sessionID: sid, directory, model: ref, originals: prepared.originals });
      // The runtime holds its own copy now; drop only the captured draft files.
      if (this.host.getDraft() === text && sid === this.state.activeSessionId) this.host.setDraft("");
      if (selected.length) await attachmentDrafts.remove(scope, selected.map(file => file.id)).catch(() => {
        if (current()) this.host.patchUi({ toast: "Запрос в очереди; вложения остались в черновике. Уберите их перед следующим запросом." });
      });
      return true;
    } catch (error) {
      if (current()) this.report(sid, error);
      return false;
    } finally { this.host.finishSending(operation); }
  }

  /** Drag reorder; applied optimistically, the runtime's answer is authoritative. */
  reorderQueued(id: string, before: string | null): boolean {
    const context = this.context();
    const queue = this.getQueue();
    if (!context || this.state.ui.sending || this.isQueueLocked() || this.getQueueEdit() || queue.some(item => item.state !== "ready")) return false;
    const item = queue.find(entry => entry.id === id);
    if (!item || before === id || (before !== null && !queue.some(entry => entry.id === before))) return false;
    const order = queue.filter(entry => entry.id !== id);
    order.splice(before === null ? order.length : order.findIndex(entry => entry.id === before), 0, item);
    if (order.every((entry, index) => entry.id === queue[index].id)) return false;
    const { sid, directory, backend } = context;
    const previous = this.state.queues[sid];
    if (previous) this.host.mutate(s => ({ queues: { ...s.queues, [sid]: { ...previous, items: order.map(entry => previous.items.find(x => x.id === entry.id)!) } } }));
    void backend.client.reorderQueued(sid, directory, id, before).then(next => {
      if (this.currentScope(context)) this.apply(next);
    }, error => {
      if (!this.currentScope(context)) return;
      if (previous) this.apply(previous);
      this.report(sid, error);
    });
    return true;
  }

  async removeQueued(id: string): Promise<void> {
    const context = this.context();
    if (!context || this.locked(context.sid)) return;
    try {
      const next = await context.backend.client.removeQueued(context.sid, context.directory, id);
      if (next && this.currentScope(context)) this.apply(next);
    } catch (error) { this.report(context.sid, error, context); }
  }

  async removeQueuedAttachment(id: string, fileID: string): Promise<void> {
    const context = this.context();
    if (!context || this.state.ui.sending) return;
    const edit = this.getQueueEdit();
    if (edit?.id === id) {
      edit.removed.add(fileID);
      this.host.mutate({});
      return;
    }
    if (this.locked(context.sid)) return;
    const item = this.getQueue(context.sid).find(q => q.id === id);
    if (!item || item.state !== "ready" || !item.attachments?.files.some(f => f.id === fileID)) return;
    this.locks.set(context.sid, context);
    try {
      const next = await context.backend.client.editQueued(context.sid, context.directory, id, { removeAttachments: [fileID] });
      if (!this.currentScope(context)) return;
      this.apply(next);
      this.host.patchUi({ sendError: null });
    } catch (error) { this.report(context.sid, error, context); }
    finally {
      if (this.locks.get(context.sid) === context) this.locks.delete(context.sid);
      if (this.currentScope(context)) this.host.mutate({});
    }
  }

  getQueueEdit(): QueueEdit | undefined {
    const sid = this.state.activeSessionId;
    const edit = sid ? this.edits.get(sid) : undefined;
    const scope = attachmentScope(this.state.prefs.workspaceKey ?? this.state.prefs.endpoint, this.state.directory, sid);
    return edit?.scope === scope ? edit : undefined;
  }

  /** Attachments of the edited item that are still kept (stored by the runtime). */
  editKeptFiles(): { id: string; name: string; mime: string; size: number }[] {
    const edit = this.getQueueEdit();
    if (!edit) return [];
    const item = this.getQueue().find(q => q.id === edit.id);
    return (item?.attachments?.files ?? []).filter(file => !edit.removed.has(file.id));
  }

  async editQueued(id: string): Promise<boolean> {
    const context = this.context();
    const item = this.getQueue().find(x => x.id === id);
    if (!context || !item || item.state !== "ready" || this.host.getDraft().trim() || this.state.ui.sending || this.locked(item.sessionID)) return false;
    const scope = attachmentScope(this.state.prefs.workspaceKey ?? this.state.prefs.endpoint, item.directory, item.sessionID);
    await attachmentDrafts.ensure(scope);
    if (!this.currentScope(context) || attachmentDrafts.snapshot(scope).length || this.host.getDraft().trim()) return false;
    // The runtime keeps the original entry and its position until Apply succeeds.
    this.edits.set(item.sessionID, { id, scope, directory: item.directory, removed: new Set() });
    this.locks.set(item.sessionID, context);
    this.host.setDraft(item.text);
    return true;
  }

  async cancelQueueEdit(): Promise<void> {
    const context = this.context();
    const edit = this.getQueueEdit(), sid = this.state.activeSessionId;
    if (!context || !edit || !sid || this.state.ui.sending) return;
    const files = attachmentDrafts.snapshot(edit.scope);
    this.edits.delete(sid);
    this.locks.delete(sid);
    this.host.setDraft("");
    await attachmentDrafts.remove(edit.scope, files.map(file => file.id)).catch(() => {});
    if (this.currentScope(context)) this.host.mutate({});
  }

  async applyQueueEdit(text: string, files: DraftAttachment[]): Promise<boolean> {
    const edit = this.getQueueEdit(), context = this.context();
    if (!edit || !context || this.state.ui.sending) return false;
    const item = this.getQueue(context.sid).find(q => q.id === edit.id);
    if (!item || item.state !== "ready") return false;
    const kept = this.editKeptFiles();
    if (!text.trim() && !files.length && !kept.length) return false;
    const model = item.model, generation = this.host.generation();
    const operation = this.host.beginSending();
    const current = () => !operation.signal.aborted && generation === this.host.generation() && this.currentScope(context) && context.sid === this.state.activeSessionId && this.getQueueEdit() === edit;
    try {
      const selected = files.length ? await attachmentDrafts.selected(edit.scope, files.map(file => file.id)) : [];
      const prepared = selected.length ? await this.host.prepareParts(selected, model, operation.signal) : { parts: [], originals: [] };
      if (!current()) return false;
      const next = await context.backend.client.editQueued(context.sid, context.directory, item.id, {
        text: text.trim() || "Проанализируй приложенные файлы.",
        ...(prepared.parts.length ? { addParts: prepared.parts } : {}),
        ...(edit.removed.size ? { removeAttachments: [...edit.removed] } : {}),
      });
      if (!current()) return true;
      this.apply(next);
      if (prepared.originals.length) this.host.queued?.({ id: item.id, sessionID: context.sid, directory: context.directory, model, originals: prepared.originals });
      this.edits.delete(context.sid);
      this.locks.delete(context.sid);
      if (this.host.getDraft() === text) this.host.setDraft("");
      if (selected.length) await attachmentDrafts.remove(edit.scope, selected.map(file => file.id)).catch(() => {});
      return true;
    } catch (error) {
      if (current()) this.report(context.sid, error, context);
      return false;
    } finally { this.host.finishSending(operation); if (this.currentScope(context)) this.host.mutate({}); }
  }

  /** Explicit recovery: clears stale errors (optionally switches the model), arms the queue. */
  async resumeQueue(useSelectedModel = false): Promise<void> {
    const context = this.context();
    const queue = this.getQueue();
    if (!context || !queue.length || queue[0].state !== "ready" || this.locked(context.sid)) return;
    const model = useSelectedModel ? this.host.getModelChoice() : null;
    if (useSelectedModel && !model) return;
    try {
      const next = await context.backend.client.resumeQueue(context.sid, context.directory,
        model ? { providerID: model.providerID, modelID: model.modelID, variant: model.variant ?? null } : undefined);
      if (!this.currentScope(context)) return;
      this.apply(next);
      const chat = this.state.chat.sessions[context.sid];
      if (chat) this.host.mutate(s => ({ chat: { ...s.chat, sessions: { ...s.chat.sessions, [context.sid]: { ...chat, lastError: null } } } }));
      this.host.patchUi({ sendError: null });
    } catch (error) { this.report(context.sid, error, context); }
  }

  async pauseQueue(): Promise<void> {
    const context = this.context();
    if (!context) return;
    try {
      const next = await context.backend.client.pauseQueue(context.sid, context.directory);
      if (this.currentScope(context)) this.apply(next);
    } catch (error) { this.report(context.sid, error, context); }
  }

  queueRecoveryReason(): string | null {
    if (this.isQueueArmed() || !this.getQueue().length) return null;
    const sid = this.state.activeSessionId;
    const error = this.pausedReason() || (sid ? this.state.chat.sessions[sid]?.lastError : null) || this.getQueue()[0]?.error;
    if (!error) return null;
    if (/insufficient.?balance|insufficient.?credits|payment required/i.test(error))
      return "Недостаточно средств у провайдера. Пополните баланс или выберите другую модель и продолжите очередь. Задания сохранены.";
    return "Очередь остановлена после ошибки. Устраните причину и продолжите; задания сохранены.";
  }

  queueHasDifferentModel(): boolean {
    const model = this.host.getModelChoice();
    return !!model && this.getQueue().some(item => item.state === "ready" &&
      (item.model.providerID !== model.providerID || item.model.modelID !== model.modelID || (item.model.variant ?? null) !== (model.variant ?? null)));
  }

  /** Correct the running turn with this item (or start it now when idle). */
  async steerQueued(id: string): Promise<void> {
    const context = this.context();
    // One correction per chat in flight: a repeated click is not a second POST.
    if (!context || this.state.ui.sending || this.steering.get(context.sid)?.backend === context.backend) return;
    const { sid, directory, backend } = context;
    this.steering.set(sid, context);
    try {
      const edit = this.getQueueEdit();
      if (edit) {
        if (edit.id !== id) { this.host.patchUi({ toast: "Завершите редактирование текущего запроса." }); return; }
        if (!await this.applyQueueEdit(this.host.getDraft(), attachmentDrafts.snapshot(edit.scope))) return;
      }
      // The captured chat, even if the user switched away meanwhile.
      const item = this.getQueue(sid).find(x => x.id === id);
      if (!item || item.state !== "ready" || !this.currentScope(context)) return;
      acceptedReceipt(await backend.client.steerQueued(sid, directory, id));
      let refreshed = true;
      if (this.currentScope(context)) await this.refresh(sid, directory, context).catch(() => { refreshed = false; });
      if (this.currentScope(context) && sid === this.state.activeSessionId) this.host.patchUi({ toast: refreshed
        ? "Уточнение сохранено."
        : "Уточнение сохранено. Статус доставки временно недоступен." });
    } catch (error) { this.report(sid, error, context); }
    finally { if (this.steering.get(sid) === context) this.steering.delete(sid); }
  }

  /** An uncertain item: the user checked the history and decides. Never replayed automatically. */
  async acknowledge(id: string, action: "drop" | "requeue"): Promise<void> {
    const context = this.context();
    if (!context) return;
    try {
      const next = await context.backend.client.acknowledgeQueued(context.sid, context.directory, id, action);
      if (next && this.currentScope(context)) this.apply(next);
    } catch (error) { this.report(context.sid, error, context); }
  }
}

// Pre-2.0 preference queues move through the runtime cutover journal
// (src/state/cutover.ts + Store.migrateLegacyQueueState), never as plain text.
