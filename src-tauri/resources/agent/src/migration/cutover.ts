// Durable cutover journal for work the pre-2.0 UI kept outside any runtime:
// queued prompts and timers. One row per exact source item, keyed by
// (installation, workspace, source, kind, legacy id) and a stable derived id,
// so a retry after any crash or lost acknowledgement finds the same receipt.
//
// The full immutable payload (attachments as content-addressed references) is
// stored BEFORE anything is published and kept until the user resolves it.
// Publication into the queue/scheduler and the "accepted" receipt are one
// SQLite transaction. Anything that cannot be mapped to a writable runtime
// chat is quarantined visibly with an actionable reason; nothing is dropped,
// converted to plain text, replayed or dispatched by the import itself.

import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalJson, isModelRef, isPromptPart, type ModelRef, type PromptPart } from "../protocol.ts";
import type { PromptQueue } from "../queue/queue.ts";
import { MAX_MINUTES, type Scheduler } from "../schedule/scheduler.ts";
import type { SessionRecord } from "../sessions/catalog.ts";
import type { AttachmentStore } from "../store/attachments.ts";
import { integer, optionalText, text, type Database, type Row } from "../store/db.ts";

export type CutoverKind = "queue" | "timer";
export type CutoverEngine = "opencode" | "pi-cli" | "runtime";
export interface CutoverSessionRef { engine: CutoverEngine; id: string; directory: string; sourceOrigin?: string }
export interface CutoverQueueInput {
  text: string; parts: PromptPart[]; model: ModelRef; agent?: string;
  state: "ready" | "uncertain"; error?: string; queuedAt?: number;
  /** Source attachments the client could not read; the item is quarantined, never shortened. */
  missingAttachments?: number;
}
export interface CutoverTimerInput {
  title: string; prompt: string; minutes: number; mode: "once" | "repeat"; runAt?: number; requestKey?: string;
  model: ModelRef; enabled: boolean; nextAt?: number; lastAt?: number; state: string; detail?: string;
}
export interface CutoverItemInput {
  kind: CutoverKind; legacyId: string; session: CutoverSessionRef;
  queue?: CutoverQueueInput; timer?: CutoverTimerInput;
}
export interface CutoverBatch { installation: string; workspace: string; source: string; items: CutoverItemInput[] }
export type CutoverState = "received" | "accepted" | "quarantined" | "resolved";
export interface CutoverReceiptDTO {
  id: string; legacyId: string; kind: CutoverKind; workspace: string; state: CutoverState;
  sessionID: string | null; itemID: string | null; code: string | null; reason: string | null; retryable: boolean; updatedAt: number;
}
export type CutoverTarget =
  | { ok: true; record: SessionRecord }
  | { ok: false; code: string; reason: string; retryable: boolean };
/** Runtime port: maps a source chat to a WRITABLE runtime chat (verified continuation for archives). */
export type CutoverResolver = (ref: CutoverSessionRef, model: ModelRef, signal?: AbortSignal) => Promise<CutoverTarget>;

type StoredPart = { kind: "text"; text: string; synthetic?: boolean; metadata?: Record<string, unknown> }
  | { kind: "file"; id: string; name: string; mime: string; size: number };
interface Stored { session: CutoverSessionRef; queue?: Omit<CutoverQueueInput, "parts"> & { parts: StoredPart[] }; timer?: CutoverTimerInput }

const MAX_ITEMS = 500;
const PAUSED = "Очередь перенесена из прежней версии Enki и приостановлена. Проверьте запросы и нажмите «Продолжить».";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && !!value && value.length <= max && !/[\u0000-\u001f]/.test(value);
const finite = (value: unknown) => value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);

export class CutoverInputError extends Error { constructor(message: string) { super(message); this.name = "CutoverInputError"; } }

function sessionRef(value: unknown): CutoverSessionRef {
  const v = (value ?? {}) as Record<string, unknown>;
  if (!["opencode", "pi-cli", "runtime"].includes(String(v.engine)) || !bounded(v.id, 512) || !bounded(v.directory, 4096) || !path.isAbsolute(v.directory)
    || (v.sourceOrigin !== undefined && !bounded(v.sourceOrigin, 512))) throw new CutoverInputError("Некорректная ссылка на исходный чат.");
  return { engine: v.engine as CutoverEngine, id: v.id, directory: v.directory, ...(typeof v.sourceOrigin === "string" ? { sourceOrigin: v.sourceOrigin } : {}) };
}

/** Strict wire validation; nothing is coerced into a smaller or different item. */
export function validBatch(value: unknown): CutoverBatch {
  const b = (value ?? {}) as Record<string, unknown>;
  if (!bounded(b.installation, 64) || !/^[A-Za-z0-9-]{8,64}$/.test(b.installation) || !bounded(b.workspace, 1024)
    || (b.source !== "ui-queue" && b.source !== "ui-timers") || !Array.isArray(b.items) || b.items.length > MAX_ITEMS)
    throw new CutoverInputError("Некорректный пакет переноса.");
  const items = b.items.map((raw): CutoverItemInput => {
    const i = (raw ?? {}) as Record<string, unknown>;
    if ((i.kind !== "queue" && i.kind !== "timer") || !bounded(i.legacyId, 512)) throw new CutoverInputError("Некорректный элемент переноса.");
    const session = sessionRef(i.session);
    if (i.kind === "queue") {
      const q = (i.queue ?? {}) as Record<string, unknown>;
      if (typeof q.text !== "string" || q.text.length > 200_000 || !Array.isArray(q.parts) || q.parts.length > 64 || !q.parts.every(isPromptPart)
        || !isModelRef(q.model) || (q.state !== "ready" && q.state !== "uncertain") || (q.error !== undefined && typeof q.error !== "string")
        || !finite(q.queuedAt) || !finite(q.missingAttachments) || (q.agent !== undefined && !bounded(q.agent, 64)))
        throw new CutoverInputError("Некорректный запрос очереди.");
      return { kind: "queue", legacyId: i.legacyId, session, queue: q as unknown as CutoverQueueInput };
    }
    const t = (i.timer ?? {}) as Record<string, unknown>;
    if (!bounded(t.title, 120) || typeof t.prompt !== "string" || !t.prompt.trim() || t.prompt.length > 20000 || !Number.isInteger(t.minutes)
      || Number(t.minutes) < 1 || Number(t.minutes) > MAX_MINUTES || (t.mode !== "once" && t.mode !== "repeat") || !isModelRef(t.model)
      || typeof t.enabled !== "boolean" || typeof t.state !== "string" || !finite(t.runAt) || !finite(t.nextAt) || !finite(t.lastAt)
      || (t.requestKey !== undefined && !bounded(t.requestKey, 128)) || (t.detail !== undefined && typeof t.detail !== "string"))
      throw new CutoverInputError("Некорректный таймер.");
    return { kind: "timer", legacyId: i.legacyId, session, timer: t as unknown as CutoverTimerInput };
  });
  return { installation: b.installation, workspace: b.workspace, source: b.source, items };
}

function receiptOf(row: Row): CutoverReceiptDTO {
  const detail = JSON.parse(optionalText(row, "detail") ?? "{}") as { code?: string; reason?: string; retryable?: boolean };
  return {
    id: text(row, "id"), legacyId: text(row, "legacy_id"), kind: text(row, "kind") as CutoverKind, workspace: text(row, "workspace"),
    state: text(row, "state") as CutoverState, sessionID: optionalText(row, "target_session"), itemID: optionalText(row, "target_item"),
    code: detail.code ?? null, reason: detail.reason ?? null, retryable: detail.retryable === true, updatedAt: integer(row, "updated"),
  };
}

export class CutoverJournal {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: Database, private readonly attachments: AttachmentStore, private readonly queue: PromptQueue,
    private readonly scheduler: Scheduler, private readonly resolver: CutoverResolver) {}

  static idOf(installation: string, workspace: string, source: string, kind: CutoverKind, legacyId: string): string {
    return `cut-${sha([installation, workspace, source, kind, legacyId].join("\0")).slice(0, 48)}`;
  }

  list(filter: { installation?: string; workspace?: string } = {}): CutoverReceiptDTO[] {
    const params: string[] = [];
    let sql = "SELECT * FROM cutover_items WHERE 1=1";
    if (filter.installation) { sql += " AND installation=?"; params.push(filter.installation); }
    if (filter.workspace) { sql += " AND workspace=?"; params.push(filter.workspace); }
    return this.db.all(`${sql} ORDER BY created, id LIMIT 2000`, ...params).map(receiptOf);
  }

  get(id: string): CutoverReceiptDTO | null {
    const row = this.db.get("SELECT * FROM cutover_items WHERE id=?", id);
    return row ? receiptOf(row) : null;
  }

  /** Items needing the user (quarantined) or still unpublished block "done" for their workspace. */
  pending(): number {
    return integer(this.db.get("SELECT COUNT(*) AS n FROM cutover_items WHERE state IN ('received','quarantined')"), "n");
  }

  /** Serialized: one publication at a time; continuations are exclusive per runtime. */
  submit(batch: CutoverBatch, signal?: AbortSignal): Promise<CutoverReceiptDTO[]> {
    return this.serial(async () => {
      const receipts: CutoverReceiptDTO[] = [];
      for (const item of batch.items) {
        signal?.throwIfAborted();
        const id = CutoverJournal.idOf(batch.installation, batch.workspace, batch.source, item.kind, item.legacyId);
        const digest = sha(canonicalJson({ session: item.session, queue: item.queue, timer: item.timer }));
        const existing = this.db.get("SELECT * FROM cutover_items WHERE id=?", id);
        if (existing && text(existing, "payload_sha256") !== digest) {
          // The first durable copy wins; a different payload under the same source identity is shown, never merged.
          receipts.push({ ...receiptOf(existing), code: "payload_conflict", retryable: false,
            reason: "Под этим исходным идентификатором уже сохранён другой запрос. Сохранённая копия не изменена." });
          continue;
        }
        if (!existing) this.record(id, batch, item, digest);
        receipts.push(await this.publish(id, signal));
      }
      return receipts;
    });
  }

  retry(id: string, signal?: AbortSignal): Promise<CutoverReceiptDTO> {
    return this.serial(async () => {
      const current = this.get(id);
      if (!current) throw new CutoverInputError("Элемент переноса не найден.");
      return current.state === "quarantined" && current.retryable ? this.publish(id, signal) : current;
    });
  }

  /** Explicit user decision. The payload row stays as an audit record; backup bytes are released. */
  resolve(id: string): CutoverReceiptDTO {
    const current = this.get(id);
    if (!current) throw new CutoverInputError("Элемент переноса не найден.");
    if (current.state === "received") throw new CutoverInputError("Перенос ещё выполняется; повторите позже.");
    this.db.transaction(() => {
      this.attachments.release(`cutover:${id}`);
      this.db.run("UPDATE cutover_items SET state='resolved',updated=? WHERE id=?", Date.now(), id);
    });
    return this.get(id)!;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The immutable source copy is durable before any publication is attempted. */
  private record(id: string, batch: CutoverBatch, item: CutoverItemInput, digest: string): void {
    this.db.transaction(() => {
      const stored: Stored = { session: item.session, ...(item.timer ? { timer: item.timer } : {}) };
      if (item.queue) stored.queue = { ...item.queue, parts: item.queue.parts.map((part): StoredPart => {
        if (part.type === "text") return { kind: "text", text: part.text, ...(part.synthetic ? { synthetic: true } : {}), ...(part.metadata ? { metadata: part.metadata } : {}) };
        const kept = this.attachments.put(part.url, part.filename ?? "файл", `cutover:${id}`);
        return { kind: "file", id: kept.id, name: part.filename ?? "файл", mime: kept.mime, size: kept.size };
      }) };
      const now = Date.now();
      this.db.run("INSERT INTO cutover_items(id,installation,workspace,source,kind,legacy_id,payload,payload_sha256,state,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        id, batch.installation, batch.workspace, batch.source, item.kind, item.legacyId, JSON.stringify(stored), digest, "received", now, now);
    });
  }

  private quarantine(id: string, code: string, reason: string, retryable: boolean): CutoverReceiptDTO {
    this.db.run("UPDATE cutover_items SET state='quarantined',detail=?,updated=? WHERE id=?", JSON.stringify({ code, reason: reason.slice(0, 1000), retryable }), Date.now(), id);
    return this.get(id)!;
  }

  private promptParts(parts: StoredPart[]): PromptPart[] {
    return parts.map((part): PromptPart => part.kind === "text"
      ? { type: "text", text: part.text, ...(part.synthetic ? { synthetic: true } : {}), ...(part.metadata ? { metadata: part.metadata } : {}) }
      : { type: "file", mime: part.mime, filename: part.name, url: this.attachments.dataUrl(part.id) });
  }

  private async publish(id: string, signal?: AbortSignal): Promise<CutoverReceiptDTO> {
    const row = this.db.get("SELECT * FROM cutover_items WHERE id=?", id);
    if (!row) throw new Error("Элемент переноса исчез из журнала.");
    const current = receiptOf(row);
    if (current.state === "accepted" || current.state === "resolved" || (current.state === "quarantined" && !current.retryable)) return current;
    const stored = JSON.parse(text(row, "payload")) as Stored;
    if (stored.queue?.missingAttachments)
      return this.quarantine(id, "attachments_missing", `Не удалось прочитать вложения (${stored.queue.missingAttachments}). Запрос сохранён без отправки; приложите файлы заново и добавьте его в очередь вручную.`, false);
    const model = stored.queue?.model ?? stored.timer?.model;
    if (!model) return this.quarantine(id, "invalid_payload", "Сохранённый элемент не содержит модели.", false);
    let target: CutoverTarget;
    try { target = await this.resolver(stored.session, model, signal); }
    catch (error) { target = { ok: false, code: "resolve_failed", reason: error instanceof Error ? error.message : String(error), retryable: true }; }
    if (!target.ok) return this.quarantine(id, target.code, target.reason, target.retryable);
    const record = target.record, suffix = id.slice(4, 44);
    try {
      this.db.transaction(() => {
        let itemID: string;
        if (stored.queue) {
          itemID = `cq-${suffix}`;
          this.queue.importItem(record.id, record.directory, { id: itemID, text: stored.queue.text, parts: this.promptParts(stored.queue.parts),
            model: stored.queue.model, state: stored.queue.state, ...(stored.queue.error ? { error: stored.queue.error } : {}),
            ...(stored.queue.queuedAt !== undefined ? { queuedAt: stored.queue.queuedAt } : {}) }, PAUSED);
        } else {
          const t = stored.timer!;
          // An occurrence the old UI may already have sent stays disabled with its explanation.
          const uncertain = ["dispatching", "uncertain", "sending", "error"].includes(t.state);
          // An early 2.0 build copied timers without a journal (requestKey
          // `legacy-<id>`, created enabled then paused). Adopt that exact copy
          // instead of creating a duplicate, and make it match the source's
          // paused/uncertain intent in this same transaction.
          const legacyCopy = this.scheduler.list({ sessionID: record.id }).tasks.find((task) => task.requestKey === `legacy-${text(row, "legacy_id")}`.slice(0, 128));
          if (legacyCopy) {
            if (legacyCopy.enabled && (!t.enabled || uncertain)) this.scheduler.toggle(legacyCopy.id, false);
            this.db.run("UPDATE cutover_items SET state='accepted',target_session=?,target_item=?,detail=NULL,updated=? WHERE id=?", record.id, legacyCopy.id, Date.now(), id);
            return;
          }
          itemID = `ct-${suffix}`;
          this.scheduler.importTask({ id: itemID, directory: record.directory, sessionID: record.id, title: t.title, prompt: t.prompt, minutes: t.minutes,
            mode: t.mode, ...(t.runAt !== undefined ? { runAt: t.runAt } : {}), ...(t.requestKey ? { requestKey: t.requestKey } : {}), model: t.model,
            enabled: t.enabled && !uncertain, ...(t.nextAt !== undefined ? { nextAt: t.nextAt } : {}), ...(t.lastAt !== undefined ? { lastAt: t.lastAt } : {}),
            ...(uncertain ? { detail: t.detail || "Прежняя версия могла уже отправить это пробуждение. Проверьте историю чата и возобновите таймер вручную." } : {}) });
        }
        this.db.run("UPDATE cutover_items SET state='accepted',target_session=?,target_item=?,detail=NULL,updated=? WHERE id=?", record.id, itemID, Date.now(), id);
      });
    } catch (error) {
      return this.quarantine(id, "publish_failed", `Не удалось сохранить в среде выполнения: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    return this.get(id)!;
  }
}
