// Durable per-session prompt queue, owned by the runtime.
//
// Clients add, edit, reorder, remove, steer, pause and resume items; the runtime
// dispatches the first ready item when the session settles idle with nothing
// pending. The SDK's own follow-up queue is never used for these items, so
// there is exactly one authority over what runs next.
//
// Dispatch rules (unchanged observable contract):
//   - an item leaves the queue only once the SDK accepted its prompt;
//   - a refusal before execution returns it to "ready" and pauses the queue;
//   - an uncertain outcome keeps it as "uncertain" and pauses — never replayed;
//   - Stop disarms the queue and withdraws an item that has not reached the SDK;
//   - recoverable turn errors keep the queue running; fatal ones pause it.

import { randomUUID } from "node:crypto";
import type { CommandReceipt, ModelRef, PromptPart, QueueAttachmentRef, QueueItemDTO, QueueStateDTO } from "../protocol.ts";
import { isModelRef, isQueuePausingError } from "../protocol.ts";
import type { AttachmentStore } from "../store/attachments.ts";
import { integer, json, optionalText, text, type Database, type Row } from "../store/db.ts";
import type { EventJournal } from "../store/events.ts";

export const QUEUE_LIMIT = 20;

type StoredPart =
  | { kind: "text"; text: string; synthetic?: boolean; metadata?: Record<string, unknown> }
  | { kind: "file"; id: string; name: string; mime: string; size: number };

function isStoredParts(value: unknown): value is StoredPart[] {
  return Array.isArray(value) && value.every((p) => p && typeof p === "object" && (
    (p.kind === "text" && typeof p.text === "string")
    || (p.kind === "file" && typeof p.id === "string" && typeof p.name === "string" && typeof p.mime === "string" && typeof p.size === "number")));
}

type ItemState = QueueItemDTO["state"];
const STATES: readonly ItemState[] = ["ready", "sending", "uncertain"];

interface ItemRecord {
  id: string;
  sessionID: string;
  directory: string;
  position: number;
  text: string;
  parts: StoredPart[];
  model: ModelRef;
  state: ItemState;
  error: string | null;
  queuedAt: number;
  commandId: string | null;
}

function itemOf(row: Row): ItemRecord {
  const state = STATES.find((s) => s === text(row, "state"));
  if (!state) throw new Error("Corrupt queue item state");
  const model = json(row, "model", isModelRef);
  if (!model) throw new Error("Corrupt queue item model");
  return {
    id: text(row, "id"), sessionID: text(row, "session_id"), directory: text(row, "directory"), position: integer(row, "position"),
    text: text(row, "text"), parts: json(row, "attachments", isStoredParts) ?? [], model, state, error: optionalText(row, "error"),
    queuedAt: integer(row, "queued_at"), commandId: optionalText(row, "command_id"),
  };
}

function dto(item: ItemRecord): QueueItemDTO {
  const attachments: QueueAttachmentRef[] = item.parts.flatMap((p) => p.kind === "file" ? [{ id: p.id, name: p.name, mime: p.mime, size: p.size }] : []);
  return {
    id: item.id, sessionID: item.sessionID, directory: item.directory, text: item.text, model: item.model, state: item.state,
    ...(item.error ? { error: item.error } : {}), queuedAt: item.queuedAt, ...(attachments.length ? { attachments } : {}), commandId: item.commandId,
  };
}

export interface QueueHost {
  /** Session can take a new turn now (idle, nothing pending, no gate in flight). */
  ready(sessionID: string): boolean;
  streaming(sessionID: string): boolean;
  /** Submit through the dispatcher; returns the immediate receipt. */
  submit(kind: "prompt" | "steer", item: { commandId: string; sessionID: string; directory: string; parts: PromptPart[]; model: ModelRef; itemId: string }): CommandReceipt;
}

export interface EnqueueInput {
  id: string;
  text: string;
  /** Prepared prompt parts beyond the text (files as data: URLs, synthetic markers). */
  parts: PromptPart[];
  model: ModelRef;
}

export class PromptQueue {
  private host: QueueHost | null = null;

  constructor(private readonly db: Database, private readonly journal: EventJournal, private readonly attachments: AttachmentStore) {}

  bind(host: QueueHost): void { this.host = host; }

  private items(sessionID: string): ItemRecord[] {
    return this.db.all("SELECT * FROM queue WHERE session_id=? ORDER BY position", sessionID).map(itemOf);
  }

  private item(id: string): ItemRecord | null {
    const row = this.db.get("SELECT * FROM queue WHERE id=?", id);
    return row ? itemOf(row) : null;
  }

  private armedState(sessionID: string): { armed: boolean; pausedReason: string | null } {
    const row = this.db.get("SELECT * FROM queue_state WHERE session_id=?", sessionID);
    return { armed: integer(row, "armed") === 1, pausedReason: optionalText(row, "paused_reason") };
  }

  private setArmed(sessionID: string, armed: boolean, pausedReason: string | null): void {
    this.db.run("INSERT INTO queue_state(session_id,armed,paused_reason) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET armed=excluded.armed, paused_reason=excluded.paused_reason",
      sessionID, armed ? 1 : 0, pausedReason);
  }

  state(sessionID: string): QueueStateDTO {
    const armed = this.armedState(sessionID);
    return { sessionID, armed: armed.armed, pausedReason: armed.pausedReason, items: this.items(sessionID).map(dto) };
  }

  /** Sessions with queued items, for snapshots and attention markers. */
  sessions(directory?: string | null): QueueStateDTO[] {
    const ids = this.db.all(directory ? "SELECT DISTINCT session_id FROM queue WHERE directory=?" : "SELECT DISTINCT session_id FROM queue", ...(directory ? [directory] : []))
      .map((row) => text(row, "session_id"));
    return ids.map((id) => this.state(id));
  }

  /** Session that owns a queued item, or null when it does not exist. */
  ownerOf(id: string): string | null {
    return optionalText(this.db.get("SELECT session_id FROM queue WHERE id=?", id), "session_id");
  }

  hasWork(sessionID: string): boolean {
    return !!this.db.get("SELECT 1 AS present FROM queue WHERE session_id=? LIMIT 1", sessionID);
  }

  /** Armed with ready items: the next turn will start as soon as the session settles. */
  armedWork(sessionID: string): boolean {
    return this.armedState(sessionID).armed && !!this.db.get("SELECT 1 AS present FROM queue WHERE session_id=? AND state<>'uncertain' LIMIT 1", sessionID);
  }

  sending(sessionID: string): boolean {
    return !!this.db.get("SELECT 1 AS present FROM queue WHERE session_id=? AND state='sending' LIMIT 1", sessionID);
  }

  private publish(sessionID: string, directory: string): void {
    this.journal.append(directory, sessionID, { type: "queue.updated", properties: { sessionID, queue: this.state(sessionID) } });
  }

  private storeParts(owner: string, parts: readonly PromptPart[]): StoredPart[] {
    return parts.map((part): StoredPart => {
      if (part.type === "text") return { kind: "text", text: part.text, ...(part.synthetic ? { synthetic: true } : {}), ...(part.metadata ? { metadata: part.metadata } : {}) };
      const stored = this.attachments.put(part.url, part.filename ?? "файл", owner);
      return { kind: "file", id: stored.id, name: part.filename ?? "файл", mime: stored.mime, size: stored.size };
    });
  }

  private promptParts(item: ItemRecord): PromptPart[] {
    return [
      { type: "text", text: item.text },
      ...item.parts.map((part): PromptPart => part.kind === "text"
        ? { type: "text", text: part.text, ...(part.synthetic ? { synthetic: true } : {}), ...(part.metadata ? { metadata: part.metadata } : {}) }
        : { type: "file", mime: part.mime, filename: part.name, url: this.attachments.dataUrl(part.id) }),
    ];
  }

  /** Idempotent by item id: a retried enqueue returns the existing item. */
  enqueue(sessionID: string, directory: string, input: EnqueueInput): QueueStateDTO {
    const existing = this.item(input.id);
    if (existing) {
      if (existing.sessionID !== sessionID) throw new Error("Идентификатор элемента очереди уже занят.");
      return this.state(sessionID);
    }
    if (this.items(sessionID).length >= QUEUE_LIMIT) throw new Error(`В очереди может быть до ${QUEUE_LIMIT} запросов.`);
    const text = input.text.trim() || "Проанализируй приложенные файлы.";
    this.db.transaction(() => {
      const last = integer(this.db.get("SELECT MAX(position) AS position FROM queue WHERE session_id=?", sessionID), "position");
      const parts = this.storeParts(`queue:${input.id}`, input.parts);
      this.db.run("INSERT INTO queue(id,session_id,directory,position,text,attachments,model,state,queued_at) VALUES(?,?,?,?,?,?,?,?,?)",
        input.id, sessionID, directory, last + 1, text, JSON.stringify(parts), JSON.stringify(input.model), "ready", Date.now());
      this.setArmed(sessionID, true, null);
    });
    this.publish(sessionID, directory);
    this.drain(sessionID);
    return this.state(sessionID);
  }

  /**
   * Cutover publication of a pre-2.0 UI queue item, inside the caller's
   * transaction. The queue is left PAUSED with an explanation (never armed by
   * import), order is the caller's order, and an item whose old delivery was
   * uncertain stays uncertain: it is shown, never dispatched automatically.
   */
  importItem(sessionID: string, directory: string, input: EnqueueInput & { state: "ready" | "uncertain"; error?: string; queuedAt?: number }, pausedReason: string): QueueStateDTO {
    const existing = this.item(input.id);
    if (existing) {
      if (existing.sessionID !== sessionID) throw new Error("Идентификатор перенесённого запроса уже занят.");
      return this.state(sessionID);
    }
    if (this.items(sessionID).length >= QUEUE_LIMIT) throw new Error(`В очереди может быть до ${QUEUE_LIMIT} запросов.`);
    this.db.transaction(() => {
      const last = integer(this.db.get("SELECT MAX(position) AS position FROM queue WHERE session_id=?", sessionID), "position");
      const parts = this.storeParts(`queue:${input.id}`, input.parts);
      this.db.run("INSERT INTO queue(id,session_id,directory,position,text,attachments,model,state,error,queued_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        input.id, sessionID, directory, last + 1, input.text.trim() || "Проанализируй приложенные файлы.", JSON.stringify(parts),
        JSON.stringify(input.model), input.state, input.error?.slice(0, 2000) ?? null, input.queuedAt ?? Date.now());
      this.setArmed(sessionID, false, pausedReason);
      this.publish(sessionID, directory);
    });
    return this.state(sessionID);
  }

  /**
   * `parts` replaces every stored extra part; `addParts` appends new files and
   * `removeAttachments` drops stored files by id. Stored attachment bytes never
   * travel back to the client to be re-uploaded.
   */
  edit(id: string, patch: { text?: string; parts?: PromptPart[]; addParts?: PromptPart[]; removeAttachments?: string[]; model?: ModelRef }): QueueStateDTO {
    const item = this.item(id);
    if (!item) throw new Error("Запрос не найден в очереди.");
    if (item.state !== "ready") throw new Error("Этот запрос уже отправляется.");
    this.db.transaction(() => {
      if (patch.parts) {
        this.attachments.release(`queue:${id}`);
        this.db.run("UPDATE queue SET attachments=? WHERE id=?", JSON.stringify(this.storeParts(`queue:${id}`, patch.parts)), id);
      } else if (patch.addParts?.length || patch.removeAttachments?.length) {
        const removed = new Set(patch.removeAttachments ?? []);
        const kept = item.parts.filter((part) => part.kind !== "file" || !removed.has(part.id));
        for (const part of item.parts) if (part.kind === "file" && removed.has(part.id)) this.attachments.releaseOne(part.id, `queue:${id}`);
        const added = this.storeParts(`queue:${id}`, patch.addParts ?? []);
        this.db.run("UPDATE queue SET attachments=? WHERE id=?", JSON.stringify([...kept, ...added]), id);
      }
      if (patch.text !== undefined) this.db.run("UPDATE queue SET text=? WHERE id=?", patch.text.trim() || "Проанализируй приложенные файлы.", id);
      if (patch.model) this.db.run("UPDATE queue SET model=? WHERE id=?", JSON.stringify(patch.model), id);
      this.db.run("UPDATE queue SET error=NULL WHERE id=?", id);
    });
    this.publish(item.sessionID, item.directory);
    return this.state(item.sessionID);
  }

  remove(id: string): QueueStateDTO | null {
    const item = this.item(id);
    if (!item) return null;
    if (item.state === "sending") throw new Error("Этот запрос уже отправляется.");
    this.db.run("DELETE FROM queue WHERE id=?", id);
    this.attachments.release(`queue:${id}`);
    this.publish(item.sessionID, item.directory);
    return this.state(item.sessionID);
  }

  /**
   * The session was deleted: its queued prompts can never run (dispatch needs a
   * writable chat), yet an armed queue would keep the session "active" — e.g.
   * holding its Hub lease forever. Drop items, their attachments and the state.
   */
  discardSession(sessionID: string): number {
    const items = this.items(sessionID);
    if (items.some((item) => item.state === "sending")) throw new Error("Запрос этого чата ещё отправляется.");
    this.db.transaction(() => {
      this.db.run("DELETE FROM queue WHERE session_id=?", sessionID);
      this.db.run("DELETE FROM queue_state WHERE session_id=?", sessionID);
      if (items[0]) this.publish(sessionID, items[0].directory);
    });
    // Blob files are removed only after the rows are durably gone.
    for (const item of items) this.attachments.release(`queue:${item.id}`);
    return items.length;
  }

  /** Drag reorder: allowed while nothing in this session's queue is being sent. */
  reorder(sessionID: string, id: string, before: string | null): QueueStateDTO {
    const items = this.items(sessionID);
    if (items.some((i) => i.state !== "ready")) throw new Error("Дождитесь отправки текущего запроса.");
    const moving = items.find((i) => i.id === id);
    if (!moving || before === id || (before !== null && !items.some((i) => i.id === before))) throw new Error("Запрос не найден в очереди.");
    const order = items.filter((i) => i.id !== id);
    order.splice(before === null ? order.length : order.findIndex((i) => i.id === before), 0, moving);
    this.db.transaction(() => order.forEach((item, index) => this.db.run("UPDATE queue SET position=? WHERE id=?", index + 1, item.id)));
    this.publish(sessionID, moving.directory);
    return this.state(sessionID);
  }

  /** Explicit recovery: clears stale errors (optionally switches the model), arms and drains. */
  resume(sessionID: string, model?: ModelRef): QueueStateDTO {
    const items = this.items(sessionID);
    if (!items.length) return this.state(sessionID);
    this.db.transaction(() => {
      this.db.run(`UPDATE queue SET error=NULL${model ? ", model=?" : ""} WHERE session_id=? AND state='ready'`, ...(model ? [JSON.stringify(model), sessionID] : [sessionID]));
      this.setArmed(sessionID, true, null);
    });
    this.publish(sessionID, items[0].directory);
    this.drain(sessionID);
    return this.state(sessionID);
  }

  pause(sessionID: string, reason: string | null): void {
    const directory = this.items(sessionID)[0]?.directory;
    this.setArmed(sessionID, false, reason);
    if (directory) this.publish(sessionID, directory);
  }

  /** Stop pressed: disarm. The dispatcher withdraws a gated item, which then returns to "ready". */
  stop(sessionID: string): void {
    this.pause(sessionID, null);
  }

  /** Put corrections the SDK had not delivered back at the front of the queue. */
  restoreUndelivered(sessionID: string, directory: string, texts: string[], model: ModelRef | null): void {
    if (!texts.length || !model) return;
    this.db.transaction(() => {
      let first = integer(this.db.get("SELECT MIN(position) AS position FROM queue WHERE session_id=?", sessionID), "position");
      for (const value of [...texts].reverse()) {
        first -= 1;
        this.db.run("INSERT INTO queue(id,session_id,directory,position,text,attachments,model,state,queued_at,error) VALUES(?,?,?,?,?,?,?,?,?,?)",
          `restored-${randomUUID()}`, sessionID, directory, first, value, "[]",
          JSON.stringify(model), "ready", Date.now(), "Уточнение не было доставлено до остановки. Проверьте и отправьте заново.");
      }
    });
    this.publish(sessionID, directory);
  }

  /** Correct the running turn with this item (or start it now when idle). */
  steer(id: string): CommandReceipt {
    const item = this.item(id);
    if (!item) throw new Error("Запрос не найден в очереди.");
    if (item.state !== "ready") throw new Error("Этот запрос уже отправляется.");
    if (!this.host) throw new Error("Очередь не подключена к среде выполнения.");
    const streaming = this.host.streaming(item.sessionID);
    if (!streaming && !this.host.ready(item.sessionID)) throw new Error("В этом чате идёт другая операция. Запрос сохранён в очереди.");
    return this.dispatch(item, streaming ? "steer" : "prompt");
  }

  /** Dispatch the first ready item if the session can take a turn. */
  drain(sessionID: string): void {
    if (!this.host) return;
    const armed = this.armedState(sessionID);
    if (!armed.armed || !this.host.ready(sessionID)) return;
    const items = this.items(sessionID);
    if (items.some((i) => i.state !== "ready")) return;
    const first = items[0];
    if (!first) return;
    this.dispatch(first, "prompt");
  }

  private dispatch(item: ItemRecord, kind: "prompt" | "steer"): CommandReceipt {
    if (!this.host) throw new Error("Очередь не подключена к среде выполнения.");
    const attempt = Number(/-(\d+)$/.exec(item.commandId ?? "")?.[1] ?? 0) + 1;
    const commandId = `queue-${item.id}-${attempt}`;
    let parts: PromptPart[];
    try { parts = this.promptParts(item); }
    catch (error) {
      this.db.run("UPDATE queue SET error=? WHERE id=?", error instanceof Error ? error.message : String(error), item.id);
      this.setArmed(item.sessionID, false, error instanceof Error ? error.message : String(error));
      this.publish(item.sessionID, item.directory);
      throw error;
    }
    this.db.run("UPDATE queue SET state='sending', error=NULL, command_id=? WHERE id=?", commandId, item.id);
    this.publish(item.sessionID, item.directory);
    return this.host.submit(kind, { commandId, sessionID: item.sessionID, directory: item.directory, parts, model: item.model, itemId: item.id });
  }

  /** Receipt progress of a queue-originated command. */
  onReceipt(receipt: CommandReceipt): void {
    const row = this.db.get("SELECT * FROM queue WHERE command_id=?", receipt.id);
    if (!row) return;
    const item = itemOf(row);
    switch (receipt.state) {
      case "running":
      case "completed":
      case "failed":
        // Accepted by the SDK: the item has been delivered and leaves the queue.
        this.db.run("DELETE FROM queue WHERE id=?", item.id);
        this.attachments.release(`queue:${item.id}`);
        break;
      case "rejected":
      case "cancelled":
        this.db.run("UPDATE queue SET state='ready', error=? WHERE id=?", receipt.state === "cancelled" ? null : receipt.error ?? "Запрос отклонён.", item.id);
        this.setArmed(item.sessionID, false, receipt.state === "cancelled" ? null : receipt.error ?? null);
        break;
      case "uncertain":
        this.db.run("UPDATE queue SET state='uncertain', error=? WHERE id=?", receipt.error ?? "Доставка не подтверждена.", item.id);
        this.setArmed(item.sessionID, false, receipt.error ?? null);
        break;
      default:
        return;
    }
    this.publish(item.sessionID, item.directory);
  }

  /** A turn settled: fatal provider/auth errors and explicit stops pause the queue. */
  onSettled(sessionID: string, error: string | null): void {
    if (error && isQueuePausingError(error)) this.pause(sessionID, error);
    this.drain(sessionID);
  }

  /** The user reviewed an uncertain item and chose to drop or re-queue it. */
  acknowledge(id: string, action: "drop" | "requeue"): QueueStateDTO | null {
    const item = this.item(id);
    if (!item || item.state !== "uncertain") return item ? this.state(item.sessionID) : null;
    if (action === "drop") {
      this.db.run("DELETE FROM queue WHERE id=?", id);
      this.attachments.release(`queue:${id}`);
    } else this.db.run("UPDATE queue SET state='ready', error=NULL WHERE id=?", id);
    this.publish(item.sessionID, item.directory);
    return this.state(item.sessionID);
  }

  /** After a restart: reconcile "sending" items with their durable receipts. */
  recover(receipt: (commandId: string) => CommandReceipt | null): void {
    for (const row of this.db.all("SELECT * FROM queue WHERE state='sending'")) {
      const item = itemOf(row);
      const found = item.commandId ? receipt(item.commandId) : null;
      if (found) this.onReceipt(found);
      else {
        this.db.run("UPDATE queue SET state='ready' WHERE id=?", item.id);
        this.publish(item.sessionID, item.directory);
      }
    }
  }
}
