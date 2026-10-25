// The one execution path for user turns and session commands.
//
// `submit` records the command durably and returns its receipt immediately; the
// work continues asynchronously. Manual prompts, queued prompts and timer wakes
// all pass the same gates in the same order: session exists and is writable →
// directory matches → no other turn in flight → worker model transition (fit the
// context to the target; if needed the CURRENT model summarizes first under its
// own Hub lease) → exact target readiness (Hub lease for Hub-routed models; no
// direct fallback) → SDK preflight.

import { isReadOnlyOrigin, type CommandReceipt, type CommandRequest, type ModelRef } from "../protocol.ts";
import type { CommandLedger } from "../store/commands.ts";
import type { EventJournal } from "../store/events.ts";
import type { HubLeases, HubModelAlias } from "../models/hub.ts";
import type { SessionCatalog } from "../sessions/catalog.ts";
import type { SessionRegistry } from "../sessions/registry.ts";
import { ContextTransitionError, type ModelReadiness } from "../sessions/worker.ts";

export type ReceiptListener = (receipt: CommandReceipt, request: CommandRequest) => void;

export interface SubmitResult { receipt: CommandReceipt; status: 200 | 202 | 409 }

/** One gated command. `leased`: this operation obtained a Hub reservation it
 * now depends on (source summary, manual compaction, target before its turn). */
interface Reservation { sessionID: string; kind: CommandRequest["kind"]; abort: AbortController; leased: boolean }

/** An abort with a truthful cause other than the user's Stop (a lost Hub lease). */
class AbortReason extends Error {}

/** The reason an aborted signal carries, or null for a plain Stop. */
function abortText(signal: AbortSignal): string | null {
  return signal.aborted && signal.reason instanceof AbortReason ? signal.reason.message : null;
}

export class Dispatcher {
  // Reserved BEFORE execute() reaches its first await. A Hub lease, SDK model
  // selection and worker opening are all work, not a gap between two turns.
  private gates = new Map<string, Reservation>();
  private listeners = new Set<ReceiptListener>();
  private readonly executions = new Set<Promise<void>>();
  onReleased?: (sessionID: string) => void;

  constructor(
    private readonly registry: SessionRegistry,
    private readonly catalog: SessionCatalog,
    private readonly ledger: CommandLedger,
    private readonly hub: HubLeases,
    private readonly journal: EventJournal,
    private readonly draining: () => boolean,
  ) {}

  onReceipt(listener: ReceiptListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(receipt: CommandReceipt | null, request: CommandRequest): void {
    if (!receipt) return;
    for (const listener of [...this.listeners]) {
      try { listener(receipt, request); } catch { /* A listener failure never changes execution. */ }
    }
  }

  /** A turn of this session is being prepared or runs; nothing else may start. */
  inFlight(sessionID: string): boolean {
    return [...this.gates.values()].some((g) => g.sessionID === sessionID) || !!this.registry.live(sessionID)?.busy();
  }

  preparingCount(): number { return this.gates.size; }
  preparingSessions(): string[] { return [...new Set([...this.gates.values()].map(g => g.sessionID))]; }

  submit(request: CommandRequest, origin?: { source?: string; sourceId?: string | null }): SubmitResult {
    const begun = this.ledger.begin(request, origin);
    if (begun.kind === "conflict")
      return { status: 409, receipt: { id: request.id, kind: request.kind, sessionID: request.sessionID, state: "rejected", error: "Идентификатор команды уже использован с другим содержимым.", createdAt: Date.now(), updatedAt: Date.now() } };
    if (begun.kind === "duplicate") return { status: 200, receipt: begun.receipt };
    if (this.draining() && request.kind !== "abort") {
      const receipt = this.ledger.update(request.id, "rejected", { error: "Enki Runtime останавливается для обновления; запрос не выполнен." })!;
      this.emit(receipt, request);
      return { status: 202, receipt };
    }
    if (["prompt", "compact", "model.set", "model.transition"].includes(request.kind) && this.inFlight(request.sessionID)) {
      const receipt = this.ledger.update(request.id, "rejected", { error: "В этом чате уже выполняется или готовится операция. Дождитесь её завершения либо остановите её." })!;
      this.emit(receipt, request); return { status: 202, receipt };
    }
    const reservation: Reservation = { sessionID: request.sessionID, kind: request.kind, abort: new AbortController(), leased: false };
    this.gates.set(request.id, reservation);
    const execution = this.execute(request, reservation).catch((error: unknown) => {
      // Never reaching the SDK call is provably "not executed" (rejected);
      // a failure after "dispatching" keeps the honest "failed".
      const current = this.ledger.get(request.id);
      const state = !current || current.state === "accepted" ? (reservation.abort.signal.aborted ? "cancelled" : "rejected") : "failed";
      this.emit(this.ledger.update(request.id, state, { error: error instanceof Error ? error.message : String(error) }), request);
    }).finally(() => {
      if (this.gates.get(request.id) === reservation) this.gates.delete(request.id);
      // Includes handled/no-model prompts that settle before startPrompt's
      // promise returns. The queue must not remain asleep behind our own gate.
      this.onReleased?.(request.sessionID);
    });
    this.executions.add(execution);
    void execution.finally(() => this.executions.delete(execution)).catch(() => {});
    return { status: 202, receipt: begun.receipt };
  }

  private refuse(request: CommandRequest, error: string): void {
    this.emit(this.ledger.update(request.id, "rejected", { error }), request);
  }

  private async gate(request: CommandRequest, model: ModelRef | undefined, requireHub: boolean, reservation: Reservation): Promise<boolean> {
    const signal = reservation.abort.signal;
    signal.throwIfAborted();
    if (!model) return true;
    try {
      // Discovery precedes the decision: a fresh runtime never sends a
      // Hub-owned model directly just because its route cache is empty.
      const routed = !!(await this.hub.resolve(model.providerID, model.modelID, signal)) || requireHub;
      if (!routed) return true;
      this.journal.append(request.directory, request.sessionID, { type: "session.status", properties: { sessionID: request.sessionID, status: { type: "waiting", message: "Подготовка модели на Hub" } } });
      await this.hub.ensureRun(model.providerID, model.modelID, request.sessionID, signal);
      reservation.leased = true;
      signal.throwIfAborted();
      return true;
    } catch (error) {
      const message = signal.aborted ? abortText(signal) ?? "Подготовка модели отменена. Запрос не отправлен." : error instanceof Error ? error.message : String(error);
      this.emit(this.ledger.update(request.id, signal.aborted ? "cancelled" : "rejected", { error: message }), request);
      this.journal.append(request.directory, request.sessionID, { type: "session.idle", properties: { sessionID: request.sessionID } });
      return false;
    }
  }

  /**
   * Hub readiness handed to the worker's single model-transition path. Each
   * lease names the EXACT model the SDK uses next: the current (source) model
   * before it summarizes, then the target before a turn. The one per-session
   * lease is replaced in that order; failures refuse without direct fallback.
   */
  private readiness(request: CommandRequest, reservation: Reservation, target: { requireHub: boolean } | null): ModelReadiness {
    const signal = reservation.abort.signal;
    let alias: HubModelAlias | undefined;
    const cancelled = () => abortText(signal) ?? "Подготовка модели отменена. Запрос не отправлен.";
    const ensure = async (model: ModelRef, requireHub: boolean, message: string): Promise<void> => {
      signal.throwIfAborted();
      // The alias belongs to the TARGET only. A source-model summary keeps
      // its own exact route/lease and must never borrow the target's binding.
      const expected = alias?.model.providerID === model.providerID && alias.model.modelID === model.modelID ? alias : undefined;
      let routed: boolean;
      // Trusted discovery before direct-vs-Hub, for source summaries and
      // targets alike (manual, queued and timer prompts all pass here).
      try { routed = !!expected || !!(await this.hub.resolve(model.providerID, model.modelID, signal)) || requireHub; }
      catch (error) {
        this.journal.append(request.directory, request.sessionID, { type: "session.idle", properties: { sessionID: request.sessionID } });
        throw new Error(signal.aborted ? cancelled() : error instanceof Error ? error.message : String(error));
      }
      if (!routed) {
        // A direct model is next: a lease held for another model is dropped.
        reservation.leased = false;
        await this.hub.release(request.sessionID).catch(() => undefined);
        signal.throwIfAborted();
        return;
      }
      this.journal.append(request.directory, request.sessionID, { type: "session.status", properties: { sessionID: request.sessionID, status: { type: "waiting", message } } });
      try {
        await this.hub.ensureRun(model.providerID, model.modelID, request.sessionID, signal, expected);
        // From here the summary/turn depends on THIS reservation: an explicit
        // loss stops the operation (Runtime.hubLeaseLost → leaseLost).
        reservation.leased = true;
        signal.throwIfAborted();
      } catch (error) {
        this.journal.append(request.directory, request.sessionID, { type: "session.idle", properties: { sessionID: request.sessionID } });
        throw new Error(signal.aborted ? cancelled() : error instanceof Error ? error.message : String(error));
      }
    };
    return {
      resolve: async (model, available) => {
        alias = await this.hub.resolveMissing(model, available, signal);
        signal.throwIfAborted();
        return alias.model;
      },
      summary: model => ensure(model, false, "Подготовка текущей модели на Hub для сжатия истории"),
      target: async (model: ModelRef) => {
        if (target) await ensure(model, target.requireHub, "Подготовка модели на Hub");
        else if (alias) await this.hub.checkAlias(alias, signal);
      },
    };
  }

  private async execute(request: CommandRequest, reservation: Reservation): Promise<void> {
    const signal = reservation.abort.signal;
    signal.throwIfAborted();
    const record = this.catalog.get(request.sessionID);
    if (!record) return this.refuse(request, "Сессия не найдена.");
    if (record.directory !== request.directory) return this.refuse(request, "Сессия относится к другой папке.");
    if (record.origin.kind === "opencode" && request.kind !== "abort") return this.refuse(request, "Архив OpenCode доступен только для чтения. Продолжите его в новом чате.");
    if (isReadOnlyOrigin(record.origin) && request.kind !== "abort") return this.refuse(request, "Происхождение этого чата не подтверждено; он доступен только для чтения.");
    switch (request.kind) {
      case "prompt": {
        // Manual, queued and scheduled prompts: the worker fits the context to
        // the target (source-model summary first) before the target lease/turn.
        const worker = await this.registry.worker(request.sessionID);
        signal.throwIfAborted();
        this.emit(await worker.startPrompt(request, this.readiness(request, reservation, { requireHub: request.payload.hubRoute === true })), request);
        return;
      }
      case "steer": {
        const worker = this.registry.live(request.sessionID);
        if (!worker?.streaming()) return this.refuse(request, "Агент уже завершил работу; отправьте обычный запрос.");
        this.emit(await worker.steer(request), request);
        return;
      }
      case "abort": {
        await this.abort(request.sessionID);
        this.emit(this.ledger.update(request.id, "completed"), request);
        return;
      }
      case "compact": {
        // Manual compaction is a CURRENT-model operation. A payload model is
        // only validated; it never silently changes the summarizing model.
        const worker = await this.registry.worker(request.sessionID);
        signal.throwIfAborted();
        const current = worker.currentModel();
        const requested = request.payload.model;
        if (requested && (!current || requested.providerID !== current.providerID || requested.modelID !== current.modelID))
          return this.refuse(request, `Сжатие выполняется текущей моделью чата${current ? ` (${current.providerID}/${current.modelID})` : ""}, а не ${requested.providerID}/${requested.modelID}. Для переноса в другую модель используйте model.transition.`);
        // The lease names the model the SDK actually uses for compression.
        if (!(await this.gate(request, current ?? undefined, false, reservation))) return;
        this.ledger.update(request.id, "dispatching");
        try {
          const result = await worker.compact(request.payload.customInstructions);
          this.journal.append(request.directory, request.sessionID, { type: "session.compacted", properties: { sessionID: request.sessionID, tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter } });
          this.emit(this.ledger.update(request.id, "completed"), request);
        } catch (error) {
          // Stop or a lost Hub reservation cancelled the summary: not a model failure.
          const message = error instanceof Error ? error.message : String(error);
          this.emit(this.ledger.update(request.id, signal.aborted ? "cancelled" : "failed",
            { error: signal.aborted ? `${abortText(signal) ?? "Сжатие остановлено."} История не изменена.` : message }), request);
        }
        return;
      }
      case "model.set": {
        const worker = await this.registry.worker(request.sessionID);
        signal.throwIfAborted();
        try {
          // Same fit-before-switch path as prompts; no turn, so no target lease.
          const result = await worker.setModel(request.payload.model, this.readiness(request, reservation, null), request.id);
          if (result.compacted) this.journal.append(request.directory, request.sessionID, { type: "session.model_transition", properties: { sessionID: request.sessionID, target: request.payload.model, ...result } });
          this.emit(this.ledger.update(request.id, "completed"), request);
        } catch (error) {
          // A persisted source-model summary is a real mutation: not "rejected".
          const state = signal.aborted ? "cancelled" : error instanceof ContextTransitionError && error.compacted ? "failed" : "rejected";
          this.emit(this.ledger.update(request.id, state, { error: error instanceof Error ? error.message : String(error) }), request);
        }
        return;
      }
      case "model.transition": {
        const payload = request.payload;
        const worker = await this.registry.worker(request.sessionID);
        signal.throwIfAborted();
        this.ledger.update(request.id, "dispatching");
        try {
          // The worker leases the current model only if it must summarize.
          const result = await worker.transition(payload.model, payload.budget, this.readiness(request, reservation, null), request.id);
          this.journal.append(request.directory, request.sessionID, { type: "session.model_transition", properties: { sessionID: request.sessionID, target: payload.model, ...result } });
          this.emit(this.ledger.update(request.id, "completed"), request);
        } catch (error) {
          this.emit(this.ledger.update(request.id, signal.aborted ? "cancelled" : "failed", { error: error instanceof Error ? error.message : String(error) }), request);
        }
        return;
      }
    }
  }

  /** Stop: withdraw gated commands that have not reached the SDK, then abort the
   * run (including a source summary or manual compaction in progress). */
  async abort(sessionID: string, reason?: string): Promise<void> {
    const cause = reason ? new AbortReason(reason) : new Error("Подготовка операции отменена.");
    for (const gate of this.gates.values()) if (gate.sessionID === sessionID && gate.kind !== "abort") gate.abort.abort(cause);
    const worker = this.registry.live(sessionID);
    if (worker) await worker.abort(reason);
  }

  /**
   * Inference of this session currently depends on its Hub reservation: a
   * dispatched turn, or a gated operation (source summary, manual compaction,
   * target selection) that already obtained its lease. A gate still waiting
   * for its own ensureRun, and a settled chat whose lease is merely retained
   * for armed queue work, do not: they prepare anew.
   */
  leaseInUse(sessionID: string): boolean {
    for (const gate of this.gates.values()) if (gate.sessionID === sessionID && gate.leased && !gate.abort.signal.aborted) return true;
    return !!this.registry.live(sessionID)?.turnRunning();
  }

  async abortAll(): Promise<void> {
    await Promise.all(this.preparingSessions().map(id => this.abort(id)));
  }
  async settled(): Promise<void> { await Promise.allSettled([...this.executions]); }
}
