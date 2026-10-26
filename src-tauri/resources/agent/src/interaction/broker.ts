// Permission and extension-dialog decisions settle exactly once. Durable
// failure rejects the operation; no timer callback throws out of the broker.
import { randomUUID } from "node:crypto";
import type { DialogRequestDTO, PermissionRequestDTO, QuestionRequestDTO, ServerEventDTO } from "../protocol.ts";
import {QUESTION_ANSWER_TEXT_LIMIT} from '../protocol.ts';
import { text, type Database } from "../store/db.ts";
import type { EventJournal } from "../store/events.ts";
import { permissionPreview, readGrant, storedGrant, type ObservedGrant } from "./grants.ts";
import { questionParts, type AnswerContent } from './answer-parts.ts';
import type { AttachmentStore, StoredAttachment } from '../store/attachments.ts';

export type PermissionReply = "once" | "always" | "reject";
export interface DialogAnswer { value?: string; confirmed?: boolean; cancelled?: boolean }
const DEADLINE_MS = 30 * 60_000;
/** `policy`: settled by a changed chat/default policy, never by a client guess. */
type By = "user" | "deadline" | "cancelled" | "policy";
interface RequestScope { id: string; sessionID: string }
interface Pending<T, A> { request: T; directory: string; finish(answer: A, by: By, reportFailure: boolean): boolean; cancel(): void }

export class InteractionStorageError extends Error {
  constructor(operation: "request" | "reply", cause: unknown) {
    super(operation === "request"
      ? "Не удалось сохранить запрос подтверждения. Действие отменено; проверьте хранилище Enki и повторите."
      : "Не удалось сохранить ответ на запрос подтверждения. Действие отменено; проверьте хранилище Enki и повторите.", { cause });
    this.name = "InteractionStorageError";
  }
}
/** A malformed client answer; the pending question stays open. */
export class InteractionInputError extends Error {
  constructor(message: string) { super(message); this.name = "InteractionInputError"; }
}
export type QuestionSpec = QuestionRequestDTO["questions"][number];
export type QuestionAnswer = { answers: string[][]; content?: AnswerContent[]; attachments?: StoredAttachment[] } | { rejected: true };
export interface QuestionAsk {
  sessionID: string; directory: string; questions: QuestionSpec[]; callID?: string; signal?: AbortSignal;
}
export const QUESTION_LIMITS = { questions: 8, options: 16, question: 2000, header: 80, label: 200, description: 1000, answer: QUESTION_ANSWER_TEXT_LIMIT } as const;

/** Structural bounds for model-provided questions (the tool schema is checked too). */
export function questionProblem(questions: unknown): string | null {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > QUESTION_LIMITS.questions) return "Укажите от 1 до 8 вопросов.";
  for (const value of questions) {
    if (!value || typeof value !== "object") return "Некорректный вопрос.";
    const q = value as Record<string, unknown>;
    if (typeof q.question !== "string" || !q.question.trim() || q.question.length > QUESTION_LIMITS.question) return "Некорректный текст вопроса.";
    if (q.header !== undefined && (typeof q.header !== "string" || q.header.length > QUESTION_LIMITS.header)) return "Некорректный заголовок вопроса.";
    for (const flag of ["multiple", "custom"] as const) if (q[flag] !== undefined && q[flag] !== null && typeof q[flag] !== "boolean") return "Некорректный параметр вопроса.";
    if (q.options === undefined) continue;
    if (!Array.isArray(q.options) || q.options.length > QUESTION_LIMITS.options) return "Не более 16 вариантов ответа.";
    const labels = new Set<string>();
    for (const option of q.options) {
      const o = option && typeof option === "object" ? (option as Record<string, unknown>) : null;
      if (!o || typeof o.label !== "string" || !o.label.trim() || o.label.length > QUESTION_LIMITS.label || labels.has(o.label)) return "Некорректный вариант ответа.";
      if (o.description !== undefined && (typeof o.description !== "string" || o.description.length > QUESTION_LIMITS.description)) return "Некорректное описание варианта.";
      labels.add(o.label);
    }
  }
  return null;
}

function isAnswerList(value: unknown): value is string[][] {
  return Array.isArray(value) && value.every(list => Array.isArray(list) && list.every(item => typeof item === "string"));
}

/** One answer list per question: options only unless custom text is allowed. */
export function answerProblem(questions: readonly QuestionSpec[], answers: unknown): string | null {
  if (!Array.isArray(answers) || answers.length !== questions.length) return "Ответьте на каждый вопрос.";
  for (let index = 0; index < questions.length; index++) {
    const question = questions[index], answer: unknown = answers[index];
    const labels = new Set((question.options ?? []).map(option => option.label));
    const custom = question.custom !== false || labels.size === 0;
    if (!Array.isArray(answer) || answer.length < 1) return "Ответьте на каждый вопрос.";
    if (answer.length > (question.multiple ? Math.max(1, labels.size) + (custom ? 1 : 0) : 1)) return "Слишком много вариантов в ответе.";
    if (new Set(answer).size !== answer.length) return "Повторяющиеся варианты в ответе.";
    for (const value of answer) {
      if (typeof value !== "string" || !value.trim() || value.length > QUESTION_LIMITS.answer) return "Некорректный ответ.";
      if (!labels.has(value) && !custom) return "Выбранный вариант отсутствует в вопросе.";
    }
  }
  return null;
}

export interface PermissionAsk {
  sessionID: string; directory: string; permission: string; pattern: string;
  /** SHA of the complete action, independent of redacted UI presentation. */
  identity?: string;
  tool: string; callID: string; title: string; summary: string; signal?: AbortSignal;
  /** Current-policy verdict for this exact pending call (see reevaluatePermissions). */
  reevaluate?(): "allow" | "deny" | "ask";
}

export class InteractionBroker {
  private permissions = new Map<string, Pending<PermissionRequestDTO, PermissionReply>>();
  private readonly rechecks = new Map<string, () => "allow" | "deny" | "ask">();
  private dialogs = new Map<string, Pending<DialogRequestDTO, DialogAnswer>>();
  private questions = new Map<string, Pending<QuestionRequestDTO, QuestionAnswer>>();

  constructor(private readonly db: Database, private readonly journal: EventJournal, private readonly deadlineMs = DEADLINE_MS,
    private readonly attachments?: AttachmentStore) {}

  grants(sessionID: string): ObservedGrant[] {
    return this.db.all("SELECT permission,pattern FROM permission_grants WHERE session_id=?", sessionID)
      .flatMap(row => { const grant = readGrant(text(row, "permission"), text(row, "pattern")); return grant ? [grant] : []; });
  }

  /** The session was deleted: its remembered "always allow" grants go with it. */
  forgetSession(sessionID: string): void {
    this.db.run("DELETE FROM permission_grants WHERE session_id=?", sessionID);
    this.attachments?.release(`question:${sessionID}`);
  }

  private start<T extends RequestScope, A>(map: Map<string, Pending<T, A>>, request: T, directory: string,
    options: { signal?: AbortSignal; timeout: number; cancelled: A; asked: ServerEventDTO;
      replied(answer: A, by: By): ServerEventDTO; commit?(answer: A): void }): Promise<A> {
    if (options.signal?.aborted) return Promise.resolve(options.cancelled);
    return new Promise<A>((resolve, reject) => {
      let done = false, closing = false, timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        map.delete(request.id);
      };
      const storageFailure = (operation: "request" | "reply", cause: unknown): InteractionStorageError => {
        const failure = new InteractionStorageError(operation, cause);
        if (!done) { cleanup(); reject(failure); }
        return failure;
      };
      const finish = (answer: A, by: By, reportFailure: boolean): boolean => {
        if (done || closing) return false;
        closing = true;
        let committed = false, transactionCause: unknown, failure: InteractionStorageError | undefined;
        try {
          this.db.transaction(() => {
            this.db.afterRollback(() => {
              failure = storageFailure("reply", transactionCause ?? new Error("Enclosing permission-reply transaction rolled back."));
            });
            try {
              options.commit?.(answer);
              this.journal.append(directory, request.sessionID, options.replied(answer, by));
              this.db.afterCommit(() => { committed = true; cleanup(); resolve(answer); });
            } catch (cause) { transactionCause = cause; throw cause; }
          });
        } catch (cause) {
          // Qualified Database invokes every commit hook even if an earlier
          // observer failed. Durable decisions cannot be revoked afterwards.
          if (committed) return true;
          failure ??= storageFailure("reply", cause);
          if (reportFailure) throw failure;
        }
        return true;
      };
      const onAbort = () => { finish(options.cancelled, "cancelled", false); };
      map.set(request.id, { request, directory, finish, cancel: onAbort });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) { cleanup(); resolve(options.cancelled); return; }
      timer = setTimeout(() => { finish(options.cancelled, "deadline", false); }, options.timeout);
      let askedCommitted = false, requestCause: unknown;
      try {
        this.db.transaction(() => {
          this.db.afterRollback(() => { storageFailure("request", requestCause ?? new Error("Enclosing permission-request transaction rolled back.")); });
          try {
            this.journal.append(directory, request.sessionID, options.asked);
            this.db.afterCommit(() => { askedCommitted = true; });
          } catch (cause) { requestCause = cause; throw cause; }
        });
      } catch (cause) {
        if (!askedCommitted && !done) storageFailure("request", cause);
      }
    });
  }
  private timeout(value = this.deadlineMs): number {
    return Number.isNaN(value) ? 0 : Math.max(0, Math.min(value, this.deadlineMs, DEADLINE_MS));
  }

  askPermission(ask: PermissionAsk): Promise<PermissionReply> {
    const preview = permissionPreview(ask.pattern);
    const request: PermissionRequestDTO = {
      id: `perm_${randomUUID()}`, sessionID: ask.sessionID, permission: ask.permission,
      patterns: [preview], always: [preview],
      metadata: { tool: ask.tool, title: ask.title, summary: permissionPreview(ask.summary).slice(0, 2000), matching: "exact" },
      tool: { callID: ask.callID },
    };
    if (ask.reevaluate) this.rechecks.set(request.id, ask.reevaluate);
    // Explicit arguments: inference from the `.finally` chain widens the
    // literal `cancelled` reply to `string`.
    return this.start<PermissionRequestDTO, PermissionReply>(this.permissions, request, ask.directory, {
      signal: ask.signal, timeout: this.timeout(), cancelled: "reject",
      asked: { type: "permission.asked", properties: { ...request } },
      replied: (reply, by) => ({ type: "permission.replied", properties: { sessionID: ask.sessionID, requestID: request.id, reply, by } }),
      commit: reply => {
        if (reply !== "always") return;
        const row = storedGrant({ permission: ask.permission, identity: ask.identity ?? "" });
        this.db.run("INSERT OR IGNORE INTO permission_grants(session_id,permission,pattern,created) VALUES(?,?,?,?)", ask.sessionID, row.permission, row.pattern, Date.now());
      },
    }).finally(() => { this.rechecks.delete(request.id); });
  }
  /**
   * The chat rules or the default policy changed: settle every pending
   * permission of `sessionID` (all sessions when omitted) that the CURRENT
   * policy now decides — allow → "once", deny → "reject" — exactly once, with
   * `by: "policy"`. Still-"ask" requests stay pending; a recheck that throws
   * leaves its request for the user. Never creates a persistent grant.
   */
  reevaluatePermissions(sessionID?: string): number {
    let settled = 0;
    for (const [id, pending] of [...this.permissions]) {
      if (sessionID !== undefined && pending.request.sessionID !== sessionID) continue;
      let verdict: "allow" | "deny" | "ask" = "ask";
      try { verdict = this.rechecks.get(id)?.() ?? "ask"; } catch { continue; }
      if (verdict !== "ask" && pending.finish(verdict === "allow" ? "once" : "reject", "policy", false)) settled++;
    }
    return settled;
  }
  replyPermission(id: string, reply: PermissionReply): boolean {
    if (reply !== "once" && reply !== "always" && reply !== "reject") throw new Error("Некорректный ответ на запрос разрешения.");
    return this.permissions.get(id)?.finish(reply, "user", true) ?? false;
  }

  askDialog(sessionID: string, directory: string, spec: Omit<DialogRequestDTO, "id" | "sessionID" | "directory" | "deadline">,
    options: { signal?: AbortSignal; timeout?: number } = {}): Promise<DialogAnswer> {
    const timeout = this.timeout(options.timeout ?? this.deadlineMs);
    const request: DialogRequestDTO = { ...spec, id: `dlg_${randomUUID()}`, sessionID, directory, deadline: Date.now() + timeout };
    return this.start(this.dialogs, request, directory, {
      signal: options.signal, timeout, cancelled: { cancelled: true },
      asked: { type: "dialog.asked", properties: { dialog: request } },
      replied: (_answer, by) => ({ type: by === "deadline" ? "dialog.expired" : "dialog.replied", properties: { sessionID, requestID: request.id, by } }),
    });
  }
  replyDialog(id: string, answer: DialogAnswer): boolean {
    const pending = this.dialogs.get(id);
    if (!pending) return false;
    if (answer.cancelled === true) return pending.finish({ cancelled: true }, "user", true);
    const method = pending.request.method;
    if (method === "confirm") return pending.finish({ confirmed: answer.confirmed === true }, "user", true);
    if (typeof answer.value !== "string" || answer.value.length > 200_000) throw new Error("Некорректный ответ на диалог.");
    if (method === "select" && !pending.request.options?.includes(answer.value)) throw new Error("Выбранный ответ отсутствует в диалоге.");
    return pending.finish({ value: answer.value }, "user", true);
  }
  /** A question is not a permission: it never creates a grant and never authorizes a tool. */
  askQuestion(ask: QuestionAsk): Promise<QuestionAnswer> {
    const problem = questionProblem(ask.questions);
    if (problem) return Promise.reject(new InteractionInputError(problem));
    const request: QuestionRequestDTO = {
      id: `que_${randomUUID()}`, sessionID: ask.sessionID,
      questions: ask.questions.map(q => ({ question: q.question, ...(q.header ? { header: q.header } : {}),
        ...(typeof q.multiple === "boolean" ? { multiple: q.multiple } : {}), ...(typeof q.custom === "boolean" ? { custom: q.custom } : {}),
        ...(q.options ? { options: q.options.map(o => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })) } : {}) })),
      tool: ask.callID ? { callID: ask.callID } : null,
    };
    return this.start(this.questions, request, ask.directory, {
      signal: ask.signal, timeout: this.timeout(), cancelled: { rejected: true },
      asked: { type: "question.asked", properties: { ...request, directory: ask.directory } },
      replied: (answer, by) => "answers" in answer
        ? { type: "question.replied", properties: { sessionID: ask.sessionID, requestID: request.id, answers: answer.answers, ...(answer.attachments?.length ? { attachments: answer.attachments } : {}), by } }
        : { type: "question.rejected", properties: { sessionID: ask.sessionID, requestID: request.id, by } },
    });
  }
  replyQuestion(id: string, answers: unknown, directory?: string, parts?: unknown): boolean {
    const pending = this.questions.get(id);
    if (!pending || (directory && pending.directory !== directory)) return false;
    const problem = answerProblem(pending.request.questions, answers);
    if (problem || !isAnswerList(answers)) throw new InteractionInputError(problem ?? "Некорректный ответ.");
    let prepared: ReturnType<typeof questionParts>;
    try { prepared = questionParts(parts); }
    catch (error) { throw new InteractionInputError(error instanceof Error ? error.message : 'Некорректные вложения.'); }
    if (prepared.parts.some(p => p.type === 'file') && !this.attachments) throw new InteractionInputError('Хранилище вложений недоступно. Ответ сохранён в черновике.');
    return this.db.transaction(() => {
      const attachments = prepared.parts.flatMap(p => p.type === 'file' ? [this.attachments!.put(p.url, p.filename ?? 'файл', `question:${pending.request.sessionID}`)] : []);
      return pending.finish({ answers: answers.map(list => [...list]), ...(prepared.content.length ? { content: prepared.content } : {}), ...(attachments.length ? { attachments } : {}) }, "user", true);
    });
  }
  rejectQuestion(id: string, directory?: string): boolean {
    const pending = this.questions.get(id);
    if (!pending || (directory && pending.directory !== directory)) return false;
    return pending.finish({ rejected: true }, "user", true);
  }
  pendingPermissions(directory?: string | null): PermissionRequestDTO[] {
    return [...this.permissions.values()].filter(p => !directory || p.directory === directory).map(p => p.request);
  }
  pendingDialogs(directory?: string | null): DialogRequestDTO[] {
    return [...this.dialogs.values()].filter(p => !directory || p.directory === directory).map(p => p.request);
  }
  pendingQuestions(directory?: string | null): QuestionRequestDTO[] {
    return [...this.questions.values()].filter(p => !directory || p.directory === directory).map(p => p.request);
  }
  private all(): Array<{ request: RequestScope; cancel(): void }> {
    return [...this.permissions.values(), ...this.dialogs.values(), ...this.questions.values()];
  }
  hasPending(sessionID: string): boolean {
    return this.all().some(p => p.request.sessionID === sessionID);
  }
  /** The turn is parked on a tool permission (not a dialog/question). */
  hasPendingPermission(sessionID: string): boolean {
    for (const pending of this.permissions.values()) if (pending.request.sessionID === sessionID) return true;
    return false;
  }
  cancelSession(sessionID: string): void {
    for (const pending of this.all()) if (pending.request.sessionID === sessionID) pending.cancel();
  }
  cancelAll(): void {
    for (const pending of this.all()) pending.cancel();
  }
}
