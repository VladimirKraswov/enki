// Session workers of one runtime.
//
// A worker is opened when a session first needs execution or live history and
// stays open while it runs, has pending interactions or queued work. It is
// closed only after an idle period or on runtime shutdown — never because a
// client switched tabs or closed its window. One worker per session id: two
// concurrent opens share one promise, so the transcript has a single writer.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isReadOnlyOrigin, type MessageDTO, type ModelRef, type PermissionRule, type SessionStatusDTO } from "../protocol.ts";
import { branchSessionFile, listSessionFiles, openSessionReader } from "../sdk/adapter.ts";
import { entriesPage, entriesToMessages } from "../sdk/history.ts";
import { SessionWorker, type WorkerDeps } from "./worker.ts";
import type { SessionCatalog, SessionRecord } from "./catalog.ts";

const IDLE_CLOSE_MS = 20 * 60_000;

/** A session extension vetoed the branch (SDK `session_before_fork`). */
export class ForkRefused extends Error {
  constructor(message: string) { super(message); this.name = "ForkRefused"; }
}

export interface RegistryDeps extends WorkerDeps {
  trashDir: string;
  /** Queue or gate still owns work for this session; keep the worker open. */
  retained(sessionID: string): boolean;
  /** Legacy read-only transcripts are served from their archive. */
  legacyHistory(record: SessionRecord): MessageDTO[] | null;
  /** Page-only archive path: never expand an entire transcript for a UI read. */
  legacyHistoryPage?(record: SessionRecord, limit: number, before?: string): { messages: MessageDTO[]; before?: string } | null;
}

export class SessionRegistry {
  private workers = new Map<string, SessionWorker>();
  private opening = new Map<string, Promise<SessionWorker>>();
  private closing = false;
  private admitting = true;
  private readonly evicting = new Map<string, Promise<void>>();
  /** Workers whose resource scope changed while they were busy or opening. */
  private readonly stale = new Set<string>();
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(private readonly catalog: SessionCatalog, private readonly deps: RegistryDeps) {}
  /** Synchronous fence: no async factory can start after maintenance admission. */
  setAdmission(allowed: boolean): void { this.admitting = allowed; }
  private assertAdmission(): void {
    if (this.closing || !this.admitting) throw new Error("Runtime закрывается или выполняет обслуживание; новые операции приостановлены.");
  }
  activity(): { opening: number; closing: number; busy: number; ui: number } {
    return { opening: this.opening.size, closing: this.evicting.size + (this.closing ? 1 : 0),
      busy: this.busyCount(), ui: [...this.workers.values()].reduce((count, worker) => count + worker.uiActivity(), 0) };
  }
  idle(): boolean { return Object.values(this.activity()).every(count => count === 0); }

  start(): void {
    if (this.closing) throw new Error("Runtime закрывается.");
    if (this.sweeper) return;
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  live(id: string): SessionWorker | undefined {
    return this.workers.get(id);
  }

  async worker(id: string): Promise<SessionWorker> {
    this.assertAdmission();
    const eviction = this.evicting.get(id);
    if (eviction) { await eviction; return this.worker(id); }
    const pending = this.opening.get(id);
    if (pending) return pending;
    const existing = this.workers.get(id);
    // A worker opened with an outdated resource scope is recycled only at idle,
    // right before its next use: never mid-turn and never with a replayed prompt.
    if (existing && !existing.isClosed() && this.stale.has(id) && existing.idle()) {
      await this.recycle(id, existing); return this.worker(id);
    }
    if (existing && !existing.isClosed()) return existing;
    if (existing) this.workers.delete(id);
    const record = this.catalog.get(id);
    if (!record) throw new Error("Сессия не найдена.");
    if (record.origin.kind === "opencode") throw new Error("Это архив истории OpenCode только для чтения. Продолжите его в новом чате Pi.");
    if (isReadOnlyOrigin(record.origin)) throw new Error("Происхождение этого чата не подтверждено; он доступен только для чтения.");
    // A fresh open reads the current scope; a refresh during it marks it again.
    this.stale.delete(id);
    let staged: SessionWorker | undefined;
    const opening = SessionWorker.open(record, this.deps, worker => {
      if (this.closing || !this.catalog.get(id)) throw new Error("Открытие отменено закрытием runtime или удалением сессии.");
      staged = worker; this.workers.set(id, worker);
    }).then(async worker => {
      if (this.closing || !this.catalog.get(id)) { await worker.close("quit"); throw new Error("Открытие сессии отменено."); }
      this.workers.set(id, worker); return worker;
    }).catch(error => {
      if (staged && this.workers.get(id) === staged) this.workers.delete(id);
      throw error;
    }).finally(() => { if (this.opening.get(id) === opening) this.opening.delete(id); });
    this.opening.set(id, opening);
    return opening;
  }

  status(id: string): SessionStatusDTO {
    const worker = this.workers.get(id);
    if (!worker || worker.isClosed()) return { type: "idle" };
    return worker.busy() ? (worker.status.type === "idle" ? { type: "busy" } : worker.status) : { type: "idle" };
  }

  statuses(directory: string | null): Record<string, SessionStatusDTO> {
    const out: Record<string, SessionStatusDTO> = {};
    for (const [id, worker] of this.workers) {
      if (directory && worker.directory !== directory) continue;
      const status = this.status(id);
      if (status.type !== "idle") out[id] = status;
    }
    return out;
  }

  busyCount(): number {
    return [...this.workers.values()].filter((w) => w.busy()).length;
  }

  create(input: { directory: string; title?: string; permission?: PermissionRule[] | null; model?: ModelRef | null; parentId?: string | null; workshop?: boolean }): SessionRecord {
    this.assertAdmission();
    const now = Date.now();
    return this.catalog.insert({
      id: randomUUID(), directory: input.directory, title: input.title?.trim().slice(0, 300) || "Новый чат",
      created: now, updated: now, archived: null, permission: input.permission ?? null, parentId: input.parentId ?? null,
      sessionFile: null, origin: { kind: "pi" }, workshop: input.workshop ?? false, model: input.model ?? null,
    });
  }

  /** Branch before `messageID` (the edited user message is not included). */
  /**
   * `messageID`: branch *before* that user message (edit flow). `null`: copy
   * the whole current branch (handoff preparation, which must never touch the
   * user's original chat).
   */
  async fork(id: string, messageID: string | null, title?: string): Promise<SessionRecord> {
    this.assertAdmission();
    const source = this.catalog.get(id);
    if (!source) throw new Error("Сессия не найдена.");
    // The source's own extensions take part (session_before_fork veto), so its
    // worker is the one live SDK session for this chat; opened if needed.
    const worker = this.workers.get(id) ?? await this.worker(id);
    if (worker.busy()) throw new Error("Сначала остановите ответ.");
    const file = worker.sessionFile() ?? source.sessionFile;
    if (!file || !fs.existsSync(file)) throw new Error("В этом чате ещё нет сохранённой истории.");
    const sessionDir = this.deps.sessionDir(source.directory);
    const reader = openSessionReader(file, sessionDir);
    let leaf: string | null;
    if (messageID === null) {
      leaf = reader.leafId();
      if (!leaf) throw new Error("В этом чате ещё нет сохранённой истории.");
    } else {
      const entry = reader.all().find((e) => e.id === messageID);
      if (!entry || entry.type !== "message" || (entry.message as { role?: string }).role !== "user") throw new Error("Выберите сохранённое сообщение пользователя.");
      leaf = entry.parentId;
    }
    // Vetoed before any file or catalog row exists.
    if (!(await worker.allowsFork(messageID ?? leaf!, messageID === null ? "at" : "before")))
      throw new ForkRefused("Расширение сессии отменило создание ветки. Ничего не создано.");
    this.assertAdmission();
    const newId = randomUUID();
    const branched = branchSessionFile(file, sessionDir, leaf, source.directory, newId);
    const now = Date.now();
    return this.catalog.insert({
      id: openSessionReader(branched, sessionDir).id, directory: source.directory, title: title?.trim().slice(0, 300) || `${source.title} · правка`,
      created: now, updated: now, archived: null, permission: source.permission, parentId: null, sessionFile: branched,
      origin: { kind: "pi" }, workshop: false, model: source.model,
    });
  }

  async remove(id: string): Promise<void> {
    this.assertAdmission();
    if (this.opening.has(id)) throw new Error("Сессия ещё открывается. Дождитесь подключения или остановите runtime.");
    // An idle eviction may still be closing this worker (SDK shutdown flushes
    // its transcript): finish it before the file is moved to trash.
    const eviction = this.evicting.get(id);
    if (eviction) await eviction.catch(() => undefined);
    this.assertAdmission();
    const worker = this.workers.get(id);
    if (worker?.busy()) throw new Error("Сначала остановите ответ.");
    if (worker) { await worker.close("quit"); this.workers.delete(id); }
    this.stale.delete(id);
    const record = this.catalog.remove(id);
    // Explicit permanent deletion still keeps a recoverable copy of the transcript.
    if (record?.sessionFile && fs.existsSync(record.sessionFile)) {
      fs.mkdirSync(this.deps.trashDir, { recursive: true, mode: 0o700 });
      fs.renameSync(record.sessionFile, path.join(this.deps.trashDir, `${Date.now()}-${path.basename(record.sessionFile)}`));
    }
  }

  history(record: SessionRecord): MessageDTO[] {
    const legacy = this.deps.legacyHistory(record);
    if (legacy) return legacy;
    const worker = this.workers.get(record.id);
    if (worker) return worker.history();
    if (!record.sessionFile || !fs.existsSync(record.sessionFile)) return [];
    return entriesToMessages(record.id, openSessionReader(record.sessionFile, this.deps.sessionDir(record.directory)).branch());
  }

  /** One history page (same cursor semantics as pageMessages over history()),
   * converting only the page's entries for SDK chats. */
  historyPage(record: SessionRecord, limit: number, before?: string): { messages: MessageDTO[]; before?: string } {
    if (record.origin.kind === "opencode") {
      const page = this.deps.legacyHistoryPage?.(record, limit, before);
      if (!page) throw new Error("Постраничное чтение архива недоступно.");
      return page;
    }
    const worker = this.workers.get(record.id);
    if (worker) return worker.historyPage(limit, before);
    if (!record.sessionFile || !fs.existsSync(record.sessionFile)) return { messages: [] };
    // The persisted reader already owns a private copy of its entries.
    return entriesPage(record.id, openSessionReader(record.sessionFile, this.deps.sessionDir(record.directory)).branch(), limit, before);
  }

  /** Adopt transcripts found in a directory's session folder (e.g. copied Pi CLI chats). */
  async adopt(directory: string): Promise<number> {
    this.assertAdmission();
    const sessionDir = this.deps.sessionDir(directory);
    const known = new Set(this.catalog.list(directory, 2000).map((r) => r.sessionFile));
    let adopted = 0;
    const files = await listSessionFiles(directory, sessionDir); this.assertAdmission();
    for (const info of files) {
      if (known.has(info.path) || this.catalog.get(info.id)) continue;
      this.catalog.insert({
        id: info.id, directory, title: info.name?.trim() || info.firstMessage.slice(0, 60).trim() || "Чат Pi",
        created: info.created.getTime(), updated: info.modified.getTime(), archived: null, permission: null, parentId: null,
        sessionFile: info.path, origin: { kind: "pi" }, workshop: false, model: null,
      });
      adopted++;
    }
    return adopted;
  }

  /**
   * The execution resources (shared MCP/skills/LSP/browser/extension paths) of
   * `directory` (null = every directory) changed after a confirmed commit.
   * Idle workers close now and reopen with the new scope on their next use;
   * busy, gated or still-opening workers are only marked and recycled once
   * idle. Nothing is aborted, interrupted or replayed.
   */
  async refreshResources(directory: string | null): Promise<{ reopened: number; pending: number }> {
    const matches = (id: string, dir?: string) => directory === null || (dir ?? this.catalog.get(id)?.directory) === directory;
    const recycling: Promise<void>[] = []; let pending = 0;
    for (const [id, worker] of [...this.workers]) {
      if (!matches(id, worker.directory)) continue;
      if (!worker.isClosed() && worker.idle() && !this.deps.retained(id)) recycling.push(this.recycle(id, worker));
      else { this.stale.add(id); pending++; }
    }
    for (const id of this.opening.keys()) if (matches(id) && !this.stale.has(id)) { this.stale.add(id); pending++; }
    await Promise.allSettled(recycling);
    return { reopened: recycling.length, pending };
  }
  /** Close one idle worker exactly like the idle sweep; the next use reopens it. */
  private async recycle(id: string, worker: SessionWorker): Promise<void> {
    this.stale.delete(id);
    if (this.workers.get(id) === worker) this.workers.delete(id);
    const closing = worker.close("quit"); this.evicting.set(id, closing);
    try { await closing; } finally { if (this.evicting.get(id) === closing) this.evicting.delete(id); }
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [id, worker] of this.workers) {
      if (worker.busy() || this.deps.retained(id) || !worker.idle()) continue;
      if (!this.stale.has(id) && now - worker.lastActivity < IDLE_CLOSE_MS) continue;
      await this.recycle(id, worker);
    }
  }

  stopSweeper(): void {
    clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  async shutdown(): Promise<void> {
    this.closing = true; this.stopSweeper();
    // Do not let a late open repopulate the registry after shutdown. Early UI
    // publication also lets clients finish a session_start dialog before open.
    const workers = [...this.workers.values()];
    await Promise.allSettled(workers.map(worker => worker.close("quit")));
    await Promise.allSettled([...this.opening.values()]);
    await Promise.allSettled([...this.evicting.values()]);
    this.workers.clear(); this.opening.clear();
  }
}
