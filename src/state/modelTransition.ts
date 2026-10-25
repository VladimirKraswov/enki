// Explicit model choice for an existing chat → ONE durable runtime command.
//
// The Enki Runtime worker is the only model/context authority: it estimates
// the history against the target, summarizes with the current (source) model
// when needed, verifies the fit, takes the Hub lease for the exact model it
// uses next and only then switches. This module only submits
// `model.transition` under a stable id, follows its ledger receipt and maps
// the outcome; `session.context_transition` events supply progress text and
// typed recovery. No summary polling, no source-model residency control, no
// second orchestrator. A busy session is never interrupted: the choice is
// deferred to the next prompt, which passes the same worker gate at delivery.
import type { CommandReceipt, CommandRequest, ModelRef } from "../../src-tauri/resources/agent/src/protocol";
import { ApiError, ConnectionError } from "../api/http";

export type TransitionPhase = "planning" | "summary_model" | "summarizing" | "verifying" | "target_model" | "ready" | "failed" | "cancelled";
export type TransitionRecovery = "retry" | "larger_model" | "new_session_handoff";

export interface ContextTransitionProgress {
  sessionID: string;
  operation: string | null;
  phase: TransitionPhase;
  source: ModelRef | null;
  target: { providerID: string; modelID: string };
  code?: string;
  recovery?: TransitionRecovery[];
}

const PHASES: readonly TransitionPhase[] = ["planning", "summary_model", "summarizing", "verifying", "target_model", "ready", "failed", "cancelled"];
const RECOVERY: readonly TransitionRecovery[] = ["retry", "larger_model", "new_session_handoff"];
const ref = (value: unknown): value is { providerID: string; modelID: string } =>
  !!value && typeof value === "object" && typeof (value as ModelRef).providerID === "string" && typeof (value as ModelRef).modelID === "string";

/** Strict projection of a `session.context_transition` event; anything else is ignored. */
export function parseTransitionProgress(properties: Record<string, unknown> | undefined): ContextTransitionProgress | null {
  const p = properties ?? {};
  if (typeof p.sessionID !== "string" || !PHASES.includes(p.phase as TransitionPhase) || !ref(p.target)) return null;
  if (p.operation !== null && p.operation !== undefined && typeof p.operation !== "string") return null;
  return {
    sessionID: p.sessionID, operation: typeof p.operation === "string" ? p.operation : null, phase: p.phase as TransitionPhase,
    source: ref(p.source) ? (p.source as ModelRef) : null, target: { providerID: p.target.providerID, modelID: p.target.modelID },
    ...(typeof p.code === "string" ? { code: p.code } : {}),
    ...(Array.isArray(p.recovery) ? { recovery: p.recovery.filter((r): r is TransitionRecovery => RECOVERY.includes(r as TransitionRecovery)) } : {}),
  };
}

const PHASE_TEXT: Record<TransitionPhase, string> = {
  planning: "Проверяем, помещается ли история в выбранную модель…",
  summary_model: "Готовим текущую модель для сжатия истории…",
  summarizing: "Сжимаем историю текущей моделью. Полная история останется в чате…",
  verifying: "Проверяем размер сжатой истории…",
  target_model: "Готовим выбранную модель…",
  ready: "Выбранная модель готова.",
  failed: "Переход на модель не выполнен. История и очередь сохранены.",
  cancelled: "Переход на модель остановлен. История и очередь сохранены.",
};
export function transitionText(progress: ContextTransitionProgress): string { return PHASE_TEXT[progress.phase]; }

const RECOVERY_TEXT: Record<TransitionRecovery, string> = {
  retry: "повторите выбор модели",
  larger_model: "выберите модель с большим контекстом",
  new_session_handoff: "начните новый чат с кратким пересказом",
};
export function recoveryText(recovery: readonly TransitionRecovery[] | undefined): string {
  return recovery?.length ? ` Что можно сделать: ${recovery.map((r) => RECOVERY_TEXT[r]).join("; ")}.` : "";
}

export interface TransitionPort {
  command(request: CommandRequest, signal?: AbortSignal): Promise<CommandReceipt>;
  receipt(id: string, signal?: AbortSignal): Promise<CommandReceipt>;
}

export type TransitionOutcome =
  | { kind: "applied" }
  /** The session was busy: nothing was interrupted; the next prompt carries the model. */
  | { kind: "deferred"; reason: string }
  | { kind: "failed"; message: string; code?: string; recovery?: TransitionRecovery[] }
  /** Stopped in the runtime (Stop) before the target was selected. */
  | { kind: "cancelled"; message: string }
  /** This window stopped waiting; the runtime operation (if accepted) continues on its own. */
  | { kind: "detached" }
  /** Delivery or result unknown (lost acknowledgement / uncertain): never retried blindly. */
  | { kind: "unknown"; message: string };

const TERMINAL = new Set(["completed", "failed", "rejected", "cancelled", "uncertain"]);
const BUSY = /уже выполняется или готовится операция/;

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(true); }, ms);
    const stop = () => { clearTimeout(timer); resolve(false); };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

export interface TransitionInput {
  /** Stable for this explicit choice; reused verbatim after a lost acknowledgement. */
  id: string;
  sessionID: string;
  directory: string;
  model: ModelRef;
  signal?: AbortSignal;
  /** Latest progress for THIS operation (from session.context_transition events). */
  progress?: () => ContextTransitionProgress | null;
  pollMs?: number;
  deadlineMs?: number;
}

/** Submit once (same-id retry after a lost ACK), then follow the ledger receipt. */
export async function requestModelTransition(port: TransitionPort, input: TransitionInput): Promise<TransitionOutcome> {
  const request: CommandRequest = { id: input.id, kind: "model.transition", sessionID: input.sessionID, directory: input.directory, payload: { model: input.model } };
  const lost = "Связь прервалась во время смены модели. Результат неизвестен: проверьте чат. Повторная отправка не выполнялась.";
  let receipt: CommandReceipt;
  try { receipt = await port.command(request, input.signal); }
  catch (error) {
    if (input.signal?.aborted) return { kind: "detached" };
    if (!(error instanceof ConnectionError)) throw error;
    // The ledger is idempotent by id: look the receipt up first; resubmit the
    // SAME id only when the runtime positively says it has no such command.
    try { receipt = await port.receipt(input.id, input.signal); }
    catch (lookup) {
      if (input.signal?.aborted) return { kind: "detached" };
      if (!(lookup instanceof ApiError && lookup.status === 404)) return { kind: "unknown", message: lost };
      try { receipt = await port.command(request, input.signal); }
      catch { return input.signal?.aborted ? { kind: "detached" } : { kind: "unknown", message: lost }; }
    }
  }
  const deadline = Date.now() + (input.deadlineMs ?? 35 * 60_000);
  let transient = 0;
  while (!TERMINAL.has(receipt.state)) {
    if (Date.now() > deadline) return { kind: "unknown", message: "Смена модели выполняется слишком долго. Проверьте чат; повторная отправка не выполнялась." };
    if (!(await sleep(input.pollMs ?? 500, input.signal))) return { kind: "detached" };
    try { receipt = await port.receipt(input.id, input.signal); transient = 0; }
    catch (error) {
      if (input.signal?.aborted) return { kind: "detached" };
      if (!(error instanceof ConnectionError) || ++transient > 5) return { kind: "unknown", message: lost };
    }
  }
  const latest = input.progress?.();
  const typed = latest && latest.operation === input.id ? latest : null;
  switch (receipt.state) {
    case "completed": return { kind: "applied" };
    case "rejected":
      if (BUSY.test(receipt.error ?? "")) return { kind: "deferred", reason: receipt.error ?? "" };
      return { kind: "failed", message: receipt.error || "Среда выполнения отклонила смену модели." };
    case "cancelled": return { kind: "cancelled", message: receipt.error || "Смена модели остановлена." };
    case "failed": return { kind: "failed", message: receipt.error || "Смена модели не удалась.",
      ...(typed?.code ? { code: typed.code } : {}), ...(typed?.recovery ? { recovery: typed.recovery } : {}) };
    default: return { kind: "unknown", message: receipt.error || lost };
  }
}
