// Sequential VT frame consumer for the runtime plugin surface (adapted from the
// reviewed draft in sdk-reference/enki-plugin-ui; protocol guards are the
// runtime's own). A reset is a barrier behind the outstanding xterm write
// callback, so an old asynchronous write cannot paint over a new snapshot.
import { isAttachment, isFrame, MAX_QUEUED_BYTES, sameScope, scopeCopy } from "../../../../src-tauri/resources/agent/src/plugin-ui/protocol";
import type { SurfaceAttachment, UiFrame, UiScope } from "./types";

export const MAX_PENDING_BYTES = MAX_QUEUED_BYTES;
export const MAX_PENDING_FRAMES = 1024;

export interface TerminalSink {
  reset(): void;
  resize(cols: number, rows: number): void;
  /** `complete` must run after xterm actually applied the data. */
  write(data: string, complete: () => void): void;
}

export type FrameProblemCode = "invalid-reset" | "invalid-frame" | "missing-reset" | "unexpected-epoch" | "sequence-gap" | "backpressure" | "terminal-error";
export interface FrameProblem { code: FrameProblemCode; message: string; lastAppliedSeq: number }
export interface FrameConsumerOptions {
  onReady(attachment: SurfaceAttachment): void;
  onRecovery(problem: FrameProblem): void;
  /** Shares the one-MiB budget with queued input in the surface controller. */
  reservedBytes?(): number;
}
interface PendingFrame { frame: UiFrame; bytes: number; generation: number }

export function validSize(cols: number, rows: number): boolean {
  return Number.isSafeInteger(cols) && Number.isSafeInteger(rows) && cols >= 1 && cols <= 1000 && rows >= 1 && rows <= 1000;
}

export function utf8Bytes(data: string): number {
  let bytes = 0;
  for (let index = 0; index < data.length; index += 1) {
    const value = data.charCodeAt(index);
    if (value < 0x80) bytes += 1;
    else if (value < 0x800) bytes += 2;
    else if (value >= 0xd800 && value <= 0xdbff && index + 1 < data.length
      && data.charCodeAt(index + 1) >= 0xdc00 && data.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index += 1; }
    else bytes += 3;
  }
  return bytes;
}

export class VtFrameConsumer {
  private readonly scope: UiScope;
  private generation = 0;
  private attachment: SurfaceAttachment | null = null;
  private resetPending: SurfaceAttachment | null = null;
  private queue: PendingFrame[] = [];
  private queuedBytes = 0;
  private inFlight: PendingFrame | null = null;
  private receivedSeq = 0;
  private appliedSeq = 0;
  private blocked = true;
  private disposed = false;
  private recovering = false;

  constructor(scope: UiScope, private readonly sink: TerminalSink, private readonly options: FrameConsumerOptions) {
    this.scope = scopeCopy(scope);
  }

  get pendingBytes(): number { return this.queuedBytes + (this.inFlight?.bytes ?? 0); }
  get lastAppliedSeq(): number { return this.appliedSeq; }

  reset(attachment: SurfaceAttachment): void {
    if (this.disposed) return;
    if (!isAttachment(attachment)) { this.recover("invalid-reset", "Сервис прислал некорректное состояние интерфейса."); return; }
    if (!sameScope(this.scope, attachment.scope)) return;
    if (this.attachment && attachment.streamEpoch <= this.attachment.streamEpoch) return;
    this.generation += 1;
    this.attachment = { ...attachment, scope: { ...attachment.scope } };
    this.resetPending = this.attachment;
    this.queue = []; this.queuedBytes = 0; this.receivedSeq = 0; this.appliedSeq = 0;
    this.blocked = false; this.recovering = false;
    this.drain();
  }

  /** The stream reported invalid VT data that could not be parsed at all. */
  invalid(): void { this.recover("invalid-frame", "Сервис прислал некорректный кадр интерфейса."); }

  accept(frame: UiFrame): void {
    if (this.disposed) return;
    if (!isFrame(frame)) { this.invalid(); return; }
    if (!sameScope(this.scope, frame)) return;
    if (!this.attachment) { this.recover("missing-reset", "Получен вывод до начального состояния интерфейса."); return; }
    if (frame.streamEpoch < this.attachment.streamEpoch || this.blocked) return;
    if (frame.streamEpoch !== this.attachment.streamEpoch) { this.recover("unexpected-epoch", "Поток интерфейса изменился; восстанавливаю его состояние."); return; }
    if (frame.seq <= this.receivedSeq) return;
    if (frame.seq !== this.receivedSeq + 1) { this.recover("sequence-gap", "Часть вывода интерфейса потеряна; запрашиваю полный экран."); return; }
    const bytes = utf8Bytes(frame.data);
    if (this.queue.length + (this.inFlight ? 1 : 0) >= MAX_PENDING_FRAMES
      || this.pendingBytes + bytes + (this.options.reservedBytes?.() ?? 0) > MAX_PENDING_BYTES) {
      this.recover("backpressure", "Вывод поступает быстрее отображения; запрашиваю полный экран.");
      return;
    }
    this.receivedSeq = frame.seq;
    this.queue.push({ frame: { ...frame }, bytes, generation: this.generation });
    this.queuedBytes += bytes;
    this.drain();
  }

  /** Keeps the last rendered screen visible, while refusing further replay. */
  pause(): void {
    this.generation += 1;
    this.blocked = true; this.recovering = false; this.resetPending = null;
    this.queue = []; this.queuedBytes = 0;
  }

  dispose(): void { this.pause(); this.disposed = true; }

  private recover(code: FrameProblemCode, message: string): void {
    if (this.disposed || this.recovering) return;
    this.pause();
    this.recovering = true;
    this.options.onRecovery({ code, message, lastAppliedSeq: this.appliedSeq });
  }

  private drain(): void {
    if (this.disposed || this.blocked || this.inFlight) return;
    if (this.resetPending) {
      const attachment = this.resetPending;
      this.resetPending = null;
      try { this.sink.reset(); this.sink.resize(attachment.cols, attachment.rows); }
      catch { this.recover("terminal-error", "Не удалось восстановить экран интерфейса."); return; }
      this.options.onReady(attachment);
      if (this.disposed || this.blocked || this.inFlight) return;
    }
    const pending = this.queue.shift();
    if (!pending) return;
    this.queuedBytes -= pending.bytes;
    this.inFlight = pending;
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      // A sink may call complete synchronously. Do not recurse.
      queueMicrotask(() => {
        if (this.inFlight !== pending) return;
        this.inFlight = null;
        if (this.disposed) return;
        if (!this.blocked && pending.generation === this.generation) this.appliedSeq = pending.frame.seq;
        this.drain();
      });
    };
    try { this.sink.write(pending.frame.data, complete); }
    catch {
      if (this.inFlight === pending) this.inFlight = null;
      this.recover("terminal-error", "Не удалось отобразить вывод интерфейса.");
    }
  }
}
