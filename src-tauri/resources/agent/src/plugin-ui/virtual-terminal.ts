import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { StdinBuffer, type Terminal } from "@earendil-works/pi-tui";
import {
  MAX_DRAFT_BYTES, MAX_FRAME_BYTES, MAX_QUEUED_BYTES, UiProtocolError, byteLength,
  integer, isInput, isResize, sameScope, scopeCopy,
  type InputReceipt, type SurfaceAttachment, type UiFrame, type UiScope,
} from "./protocol.ts";

export interface VirtualTerminalPorts {
  /** Trusted transport checks principal, live lease and revocation again for every input. */
  authorizeControl(scope: UiScope, leaseId: string): boolean;
  /** Supervisor retains routing/state. Missing viewers is not a publishing error. */
  publish(frame: UiFrame): void;
  reset(attachment: SurfaceAttachment): void;
  metadata(scope: UiScope, value: { title?: string; progress?: boolean }): void;
  /** Record/publish a visible scoped fault without throwing; admission may already be committed. */
  fault(scope: UiScope, error: Error): void;
}

/** Public pi-tui Terminal implementation. Never owns process.stdin/stdout or a PTY. */
export class EnkiVirtualTerminal implements Terminal {
  readonly scope: UiScope;
  private cols: number;
  private lines: number;
  private active = false;
  private disposed = false;
  private outputEpoch = 1;
  private outputSeq = 0;
  private lease: string | null = null;
  private acceptedInput = 0;
  private lastInputDigest: string | null = null;
  private lastInputEpoch = 0;
  private pendingInputBytes = 0;
  private lastInputAt = 0;
  private onInput: ((data: string) => void) | undefined;
  private onResize: (() => void) | undefined;
  private readonly buffer: StdinBuffer;
  private readonly drains = new Set<() => void>();

  constructor(scope: UiScope, private readonly ports: VirtualTerminalPorts,
    size: { cols: number; rows: number } = { cols: 80, rows: 24 }) {
    this.scope = scopeCopy(scope);
    if (!integer(size.cols, 1, 1000) || !integer(size.rows, 1, 1000)) throw new UiProtocolError("size", "Некорректный размер терминала.");
    this.cols = size.cols;
    this.lines = size.rows;
    this.buffer = new StdinBuffer({ timeout: 100, escapeTimeout: 35 });
    this.buffer.on("data", data => this.forward(data));
    this.buffer.on("paste", data => this.forward(`\x1b[200~${data}\x1b[201~`));
  }

  get columns(): number { return this.cols; }
  get rows(): number { return this.lines; }
  /** This transport does not advertise unimplemented Kitty key-release support. */
  get kittyProtocolActive(): boolean { return false; }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.ensureAlive();
    if (this.active) throw new UiProtocolError("started", "Интерфейс расширения уже подключён.");
    this.onInput = onInput;
    this.onResize = onResize;
    this.active = true;
  }
  stop(): void {
    this.active = false;
    this.onInput = undefined;
    this.onResize = undefined;
    this.buffer.clear();
    this.pendingInputBytes = 0;
    for (const finish of [...this.drains]) finish();
  }
  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.buffer.destroy();
    this.buffer.removeAllListeners();
  }

  /** Trusted supervisor only. A new controller fences every old input and partial paste. */
  setController(leaseId: string | null): void {
    this.ensureAlive();
    if (leaseId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(leaseId)) throw new UiProtocolError("lease", "Некорректное право ввода.");
    if (this.lease === leaseId) return;
    this.lease = leaseId;
    this.acceptedInput = 0;
    this.lastInputDigest = null;
    this.buffer.clear();
    this.pendingInputBytes = 0;
  }
  attachment(): SurfaceAttachment {
    return { scope: this.scope, streamEpoch: this.outputEpoch, controllerLeaseId: this.lease,
      inputSeq: this.acceptedInput, cols: this.cols, rows: this.lines };
  }

  /** Every snapshot increments the epoch: outstanding old input can no longer arrive late. */
  beginSnapshot(redraw: () => void): void {
    this.ensureAlive();
    if (!integer(this.outputEpoch + 1, 1)) throw new UiProtocolError("epoch-limit", "Требуется создать новый сеанс интерфейса.");
    this.outputEpoch++;
    this.outputSeq = 0;
    this.buffer.clear();
    this.pendingInputBytes = 0;
    this.ports.reset(this.attachment());
    this.clearScreen();
    redraw();
  }

  input(raw: unknown): InputReceipt {
    this.ensureAlive();
    if (!isInput(raw) || !sameScope(raw, this.scope)) throw new UiProtocolError("scope", "Ввод относится к другому сеансу интерфейса.");
    if (!this.active || raw.baseStreamEpoch !== this.outputEpoch) throw new UiProtocolError("stale", "Интерфейс изменился. Дождитесь повторного подключения.");
    this.authorize(raw.controllerLeaseId);
    const digest = createHash("sha256").update(raw.data).digest("hex");
    if (raw.inputSeq === this.acceptedInput) {
      if (digest !== this.lastInputDigest || raw.baseStreamEpoch !== this.lastInputEpoch)
        throw new UiProtocolError("input-conflict", "Идентификатор ввода уже использован для другого действия.");
      return { acceptedSeq: this.acceptedInput };
    }
    if (raw.inputSeq !== this.acceptedInput + 1) throw new UiProtocolError("input-gap", "Нарушен порядок ввода. Требуется синхронизация интерфейса.");
    // Admit before dispatch: a partially executed handler must never be blindly replayed.
    this.acceptedInput = raw.inputSeq;
    this.lastInputDigest = digest;
    this.lastInputEpoch = raw.baseStreamEpoch;
    this.lastInputAt = Date.now();
    this.pendingInputBytes += byteLength(raw.data);
    if (this.pendingInputBytes > MAX_DRAFT_BYTES) {
      this.buffer.clear();
      this.pendingInputBytes = 0;
      throw new UiProtocolError("paste-limit", "Вставка слишком велика. Текст не передан редактору.");
    }
    try { this.buffer.process(raw.data); }
    catch (error) { this.report(error); throw error; }
    return { acceptedSeq: this.acceptedInput };
  }

  resize(raw: unknown): void {
    this.ensureAlive();
    if (!isResize(raw) || !sameScope(raw, this.scope)) throw new UiProtocolError("scope", "Размер относится к другому сеансу интерфейса.");
    if (raw.baseStreamEpoch !== this.outputEpoch) throw new UiProtocolError("stale", "Размер относится к устаревшему кадру интерфейса.");
    this.authorize(raw.controllerLeaseId);
    if (this.cols === raw.cols && this.lines === raw.rows) return;
    this.cols = raw.cols;
    this.lines = raw.rows;
    try { this.onResize?.(); } catch (error) { this.report(error); throw error; }
  }

  write(data: string): void {
    this.ensureAlive();
    if (typeof data !== "string" || byteLength(data) > MAX_QUEUED_BYTES) throw new UiProtocolError("frame-limit", "Расширение сформировало слишком большой кадр интерфейса.");
    const bytes = Buffer.from(data, "utf8");
    const decoder = new StringDecoder("utf8");
    for (let offset = 0; offset < bytes.length; offset += MAX_FRAME_BYTES - 4) {
      const part = decoder.write(bytes.subarray(offset, offset + MAX_FRAME_BYTES - 4));
      if (part) this.publish(part);
    }
    const tail = decoder.end();
    if (tail) this.publish(tail);
  }
  moveBy(lines: number): void {
    if (!integer(Math.abs(lines), 0, 100000)) throw new UiProtocolError("cursor", "Некорректное перемещение курсора.");
    if (lines !== 0) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`);
  }
  hideCursor(): void { this.write("\x1b[?25l"); }
  showCursor(): void { this.write("\x1b[?25h"); }
  clearLine(): void { this.write("\x1b[K"); }
  clearFromCursor(): void { this.write("\x1b[J"); }
  clearScreen(): void { this.write("\x1b[2J\x1b[H"); }
  setTitle(title: string): void {
    if (typeof title !== "string" || byteLength(title) > 2000 || /[\x00-\x1f\x7f]/.test(title)) throw new UiProtocolError("title", "Некорректное название интерфейса.");
    this.ports.metadata(this.scope, { title });
    this.write(`\x1b]0;${title}\x07`);
  }
  setProgress(active: boolean): void {
    if (typeof active !== "boolean") throw new UiProtocolError("progress", "Некорректный статус интерфейса.");
    this.ports.metadata(this.scope, { progress: active });
    this.write(active ? "\x1b]9;4;3\x07" : "\x1b]9;4;0\x07");
  }
  drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
    if (!Number.isFinite(maxMs) || !Number.isFinite(idleMs) || maxMs < 0 || idleMs < 0)
      return Promise.reject(new UiProtocolError("deadline", "Некорректный срок очистки ввода."));
    const deadline = Date.now() + Math.min(maxMs, 5000);
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        clearTimeout(timer);
        this.drains.delete(finish);
        this.buffer.clear();
        this.pendingInputBytes = 0;
        resolve();
      };
      const poll = () => {
        if (!this.active || Date.now() >= deadline || Date.now() - this.lastInputAt >= idleMs) finish();
        else timer = setTimeout(poll, Math.min(25, Math.max(1, deadline - Date.now())));
      };
      this.drains.add(finish);
      poll();
    });
  }

  private forward(data: string): void {
    this.pendingInputBytes = 0;
    if (!this.active) return;
    if (byteLength(data) > MAX_DRAFT_BYTES + 12) throw new UiProtocolError("paste-limit", "Вставка слишком велика.");
    try { this.onInput?.(data); } catch (error) { this.report(error); }
  }
  private authorize(lease: string): void {
    if (lease !== this.lease || !this.ports.authorizeControl(this.scope, lease)) throw new UiProtocolError("lease", "Право ввода истекло или принадлежит другому клиенту.");
  }
  private publish(data: string): void {
    if (!integer(this.outputSeq + 1, 1)) throw new UiProtocolError("sequence-limit", "Требуется повторная синхронизация интерфейса.");
    const frame: UiFrame = { ...this.scope, type: "ui.vt", streamEpoch: this.outputEpoch, seq: ++this.outputSeq, data };
    this.ports.publish(frame);
  }
  private report(error: unknown): void {
    this.ports.fault(this.scope, error instanceof Error ? error : new Error("Ошибка обработчика интерфейса расширения."));
  }
  private ensureAlive(): void {
    if (this.disposed) throw new UiProtocolError("disposed", "Сеанс интерфейса уже закрыт.");
  }
}
