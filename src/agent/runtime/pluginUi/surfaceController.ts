// One view of the runtime plugin surface: not a PTY and not the SDK session
// owner (adapted from the reviewed sdk-reference draft). Input is admitted only
// with the current controller lease, base stream epoch and next input sequence;
// an uncertain input is never replayed, recovery always requests a new snapshot.
import { MAX_INPUT_BYTES, isAttachment, sameScope, scopeCopy } from "../../../../src-tauri/resources/agent/src/plugin-ui/protocol";
import type { UiInput, UiResize } from "../../../../src-tauri/resources/agent/src/plugin-ui/protocol";
import { MAX_PENDING_BYTES, utf8Bytes, validSize, VtFrameConsumer, type FrameProblem, type TerminalSink } from "./frameConsumer";
import type { InputReceipt, SurfaceAttachment, UiFrame, UiScope } from "./types";

const MAX_PENDING_INPUTS = 256;
const DEADLINE_MS = 10_000;

export interface SurfaceHandlers {
  /** Starts a complete redraw; subsequent frames start at sequence 1. */
  onReset(attachment: SurfaceAttachment): void;
  onFrame(frame: UiFrame): void;
  onInvalid(): void;
  onClosed(reason: string): void;
}
export interface SurfaceAttachmentHandle {
  input(command: UiInput): Promise<InputReceipt>;
  resize(command: UiResize): Promise<void>;
  /** Fences outstanding input: the runtime advances streamEpoch before the reset. */
  resync(): Promise<void>;
  /** Controller lease for this window; the reset that follows carries it. */
  control(): Promise<void>;
  release(): Promise<void>;
  /** This view only; never aborts the agent or disposes the SDK UI. */
  detach(): void;
}
export interface SurfacePort { attach(scope: UiScope, handlers: SurfaceHandlers): Promise<SurfaceAttachmentHandle> }

export type SurfaceStatus = "connecting" | "connected" | "readonly" | "resynchronizing" | "closed" | "error";
export interface SurfaceState { status: SurfaceStatus; detail: string; canInput: boolean; cols: number | null; rows: number | null }
interface PendingInput { data: string; bytes: number }
interface Size { cols: number; rows: number }

export class PluginSurfaceController {
  private readonly scope: UiScope;
  private readonly frames: VtFrameConsumer;
  private handle: SurfaceAttachmentHandle | null = null;
  private attachment: SurfaceAttachment | null = null;
  private connectionGeneration = 0;
  private mutationGeneration = 0;
  private disposed = false;
  private inputQueue: PendingInput[] = [];
  private queuedInputBytes = 0;
  private runningInputBytes = 0;
  private mutationRunning = false;
  private pendingSize: Size | null = null;
  private confirmedSize: Size | null = null;
  private fence: { streamEpoch: number; controllerLeaseId: string } | null = null;
  private recoveryPending = false;
  private recoveryRequested = false;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private mutationDeadline: ReturnType<typeof setTimeout> | null = null;
  private stateValue: SurfaceState = { status: "connecting", detail: "Подключаю интерфейс расширения…", canInput: false, cols: null, rows: null };

  constructor(scope: UiScope, private readonly port: SurfacePort, sink: TerminalSink, private readonly onState: (state: SurfaceState) => void) {
    this.scope = scopeCopy(scope);
    this.frames = new VtFrameConsumer(this.scope, sink, {
      reservedBytes: () => this.queuedInputBytes + this.runningInputBytes,
      onReady: attachment => this.ready(attachment),
      onRecovery: problem => this.recover(problem),
    });
  }

  get state(): SurfaceState { return { ...this.stateValue }; }
  get controls(): boolean { return !!this.attachment?.controllerLeaseId; }

  async connect(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.connectionGeneration;
    this.detachCurrent();
    this.attachment = null; this.fence = null; this.recoveryPending = false; this.recoveryRequested = false;
    this.frames.pause();
    this.clearMutations();
    this.setState("connecting", "Подключаю интерфейс расширения…", false);
    this.armDeadline(generation, "Сервис не подтвердил подключение интерфейса.");
    try {
      const handle = await this.port.attach({ ...this.scope }, {
        onReset: attachment => {
          if (!this.current(generation)) return;
          if (!isAttachment(attachment)) { this.frames.reset(attachment); return; }
          if (!sameScope(this.scope, attachment.scope)) return;
          if (this.fence && attachment.controllerLeaseId === this.fence.controllerLeaseId && attachment.streamEpoch <= this.fence.streamEpoch) {
            this.fail("Сервис не подтвердил отмену устаревшего ввода. Переподключите интерфейс.");
            return;
          }
          if (this.attachment && attachment.streamEpoch <= this.attachment.streamEpoch) return;
          this.clearMutations();
          this.setState("resynchronizing", "Восстанавливаю экран интерфейса…", false);
          this.armDeadline(generation, "Не удалось отобразить начальное состояние интерфейса. Повторите подключение.");
          this.frames.reset(attachment);
        },
        onFrame: frame => { if (this.current(generation)) this.frames.accept(frame); },
        onInvalid: () => { if (this.current(generation)) this.frames.invalid(); },
        onClosed: reason => { if (this.current(generation)) this.close(reason || "Сервис закрыл интерфейс расширения."); },
      });
      if (!this.current(generation)) { handle.detach(); return; }
      this.handle = handle;
      if (this.recoveryPending) this.requestRecovery();
      else this.publishReady();
    } catch {
      if (this.current(generation)) this.fail("Не удалось подключить интерфейс расширения. Повторите подключение.");
    }
  }

  /** Called from a trusted user gesture only (click/keyboard inside the surface). */
  async takeControl(): Promise<void> {
    const handle = this.handle;
    if (!handle || this.disposed) return;
    try { await handle.control(); }
    catch (error) { this.setState(this.stateValue.status, error instanceof Error ? error.message : "Не удалось получить управление.", false); }
  }
  async releaseControl(): Promise<void> {
    const handle = this.handle;
    if (!handle || this.disposed || !this.controls) return;
    this.clearMutations();
    await handle.release().catch(() => undefined);
  }

  /** Both xterm.onData and xterm.onBinary use this exact string transport. */
  input(data: string): boolean {
    if (!this.stateValue.canInput || !data) return false;
    const bytes = utf8Bytes(data);
    if (this.queuedInputBytes + this.runningInputBytes + bytes + this.frames.pendingBytes > MAX_PENDING_BYTES) {
      this.beginRecovery("Ввод накопился быстрее обработки; восстанавливаю интерфейс. Неподтверждённые клавиши не повторяются.", true);
      return false;
    }
    const pieces = splitInput(data);
    if (this.inputQueue.length + pieces.length + (this.mutationRunning ? 1 : 0) > MAX_PENDING_INPUTS) {
      this.beginRecovery("Слишком много неподтверждённого ввода. Восстанавливаю интерфейс без повторной отправки клавиш.", true);
      return false;
    }
    this.inputQueue.push(...pieces);
    this.queuedInputBytes += bytes;
    this.pump();
    return true;
  }

  resize(cols: number, rows: number): boolean {
    if (!this.stateValue.canInput || !validSize(cols, rows)) return false;
    if (this.confirmedSize?.cols === cols && this.confirmedSize.rows === rows && !this.pendingSize) return true;
    this.pendingSize = { cols, rows };
    this.pump();
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.connectionGeneration += 1;
    this.clearDeadline();
    this.clearMutations();
    this.frames.dispose();
    this.detachCurrent();
  }

  private current(generation: number): boolean { return !this.disposed && this.connectionGeneration === generation; }

  private setState(status: SurfaceStatus, detail: string, canInput: boolean): void {
    if (this.disposed) return;
    this.stateValue = { status, detail, canInput, cols: this.attachment?.cols ?? null, rows: this.attachment?.rows ?? null };
    this.onState(this.state);
  }

  private ready(attachment: SurfaceAttachment): void {
    this.attachment = { ...attachment, scope: { ...attachment.scope } };
    this.confirmedSize = { cols: attachment.cols, rows: attachment.rows };
    this.fence = null; this.recoveryPending = false; this.recoveryRequested = false;
    this.publishReady();
  }

  private publishReady(): void {
    if (!this.handle || !this.attachment || this.recoveryPending || this.disposed) return;
    this.clearDeadline();
    const controls = this.attachment.controllerLeaseId !== null;
    this.setState(controls ? "connected" : "readonly",
      controls ? "Вы управляете интерфейсом расширения." : "Режим просмотра. Нажмите «Управлять», чтобы вводить в интерфейс.", controls);
  }

  private clearMutations(): void {
    if (this.mutationDeadline !== null) clearTimeout(this.mutationDeadline);
    this.mutationDeadline = null;
    this.mutationGeneration += 1;
    this.inputQueue = []; this.queuedInputBytes = 0; this.runningInputBytes = 0;
    this.mutationRunning = false; this.pendingSize = null;
  }

  private pump(): void {
    const attachment = this.attachment, handle = this.handle;
    if (this.mutationRunning || !this.stateValue.canInput || !attachment || !handle || attachment.controllerLeaseId === null) return;
    const generation = this.connectionGeneration, mutationGeneration = this.mutationGeneration;
    const input = this.inputQueue.shift();
    const size = input ? null : this.pendingSize;
    if (!input && !size) return;
    this.mutationRunning = true;
    if (input) { this.queuedInputBytes -= input.bytes; this.runningInputBytes = input.bytes; }
    else this.pendingSize = null;
    const expectedSeq = attachment.inputSeq + 1;
    if (!Number.isSafeInteger(expectedSeq)) { this.fail("Исчерпана нумерация ввода. Переподключите интерфейс."); return; }
    const controllerLeaseId = attachment.controllerLeaseId;
    const currentMutation = () => this.current(generation) && this.mutationGeneration === mutationGeneration;
    const command = Promise.resolve().then(async (): Promise<InputReceipt | undefined> => {
      if (!currentMutation()) return undefined;
      if (input) return handle.input({ ...this.scope, type: "ui.input", controllerLeaseId, inputSeq: expectedSeq, baseStreamEpoch: attachment.streamEpoch, data: input.data });
      if (size) { await handle.resize({ ...this.scope, type: "ui.resize", controllerLeaseId, baseStreamEpoch: attachment.streamEpoch, cols: size.cols, rows: size.rows }); return undefined; }
      throw new Error("Mutation has neither input nor dimensions");
    });
    const timer = setTimeout(() => {
      if (currentMutation()) this.beginRecovery("Сервис не подтвердил ввод вовремя. Восстанавливаю интерфейс без повторной отправки клавиш.", true);
    }, DEADLINE_MS);
    this.mutationDeadline = timer;
    void command.then(receipt => {
      if (!currentMutation()) return;
      if (input) {
        if (!receipt || receipt.acceptedSeq !== expectedSeq) { this.beginRecovery("Подтверждение ввода не совпало с отправленной командой. Восстанавливаю интерфейс.", true); return; }
        attachment.inputSeq = receipt.acceptedSeq;
      } else if (size) this.confirmedSize = size;
      this.runningInputBytes = 0;
      this.mutationRunning = false;
      this.pump();
    }, () => {
      if (currentMutation()) this.beginRecovery("Связь прервалась до подтверждения ввода. Неподтверждённые клавиши не повторяются.", true);
    }).finally(() => { clearTimeout(timer); if (this.mutationDeadline === timer) this.mutationDeadline = null; });
  }

  private recover(problem: FrameProblem): void { this.beginRecovery(problem.message, this.mutationRunning); }

  private beginRecovery(detail: string, uncertainInput: boolean): void {
    if (this.disposed || this.recoveryPending) return;
    const attachment = this.attachment;
    if (uncertainInput && attachment?.controllerLeaseId) this.fence = { streamEpoch: attachment.streamEpoch, controllerLeaseId: attachment.controllerLeaseId };
    this.clearMutations();
    this.frames.pause();
    this.recoveryPending = true; this.recoveryRequested = false;
    this.setState("resynchronizing", detail, false);
    this.armDeadline(this.connectionGeneration, "Не удалось восстановить интерфейс. Повторите подключение.");
    this.requestRecovery();
  }

  private requestRecovery(): void {
    if (!this.handle || !this.recoveryPending || this.recoveryRequested) return;
    this.recoveryRequested = true;
    const handle = this.handle, generation = this.connectionGeneration, mutationGeneration = this.mutationGeneration;
    const live = () => this.current(generation) && this.mutationGeneration === mutationGeneration && this.recoveryPending;
    void Promise.resolve().then(() => { if (live()) return handle.resync(); })
      .catch(() => { if (live()) this.fail("Сервис не смог восстановить интерфейс. Повторите подключение."); });
  }

  private armDeadline(generation: number, message: string): void {
    this.clearDeadline();
    this.deadline = setTimeout(() => { if (this.current(generation)) this.fail(message); }, DEADLINE_MS);
  }
  private clearDeadline(): void { if (this.deadline !== null) clearTimeout(this.deadline); this.deadline = null; }
  private detachCurrent(): void { const handle = this.handle; this.handle = null; handle?.detach(); }

  private close(reason: string): void {
    this.connectionGeneration += 1;
    this.clearDeadline(); this.clearMutations(); this.frames.pause(); this.detachCurrent();
    this.setState("closed", reason, false);
  }
  private fail(message: string): void {
    this.connectionGeneration += 1;
    this.clearDeadline(); this.clearMutations(); this.frames.pause(); this.detachCurrent();
    this.setState("error", message, false);
  }
}

/** Splits large pastes without splitting a UTF-16 surrogate pair or changing bytes. */
export function splitInput(data: string): PendingInput[] {
  const result: PendingInput[] = [];
  let start = 0, bytes = 0;
  for (let index = 0; index < data.length; index += 1) {
    const value = data.charCodeAt(index);
    const pair = value >= 0xd800 && value <= 0xdbff && index + 1 < data.length && data.charCodeAt(index + 1) >= 0xdc00 && data.charCodeAt(index + 1) <= 0xdfff;
    const width = value < 0x80 ? 1 : value < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes + width > MAX_INPUT_BYTES) { result.push({ data: data.slice(start, index), bytes }); start = index; bytes = 0; }
    bytes += width;
    if (pair) index += 1;
  }
  if (start < data.length) result.push({ data: data.slice(start), bytes });
  return result;
}
