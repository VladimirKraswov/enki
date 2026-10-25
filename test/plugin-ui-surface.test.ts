// Runtime plugin surface in the WebView: ordered VT frames behind xterm write
// callbacks, host/session/epoch/sequence fences, controller leases, viewer mode
// and recovery that never replays uncertain input. Adapted from the reviewed
// sdk-reference draft to the real runtime protocol module.
import { describe, expect, it, vi } from "vitest";
import { VtFrameConsumer, type TerminalSink } from "../src/agent/runtime/pluginUi/frameConsumer";
import { PluginSurfaceController, splitInput, type SurfaceAttachmentHandle, type SurfaceHandlers, type SurfacePort } from "../src/agent/runtime/pluginUi/surfaceController";
import type { SurfaceAttachment, UiFrame, UiScope } from "../src/agent/runtime/pluginUi/types";

const scope: UiScope = { hostId: "host-1", sessionId: "chat-1", sessionEpoch: 4, surfaceId: "extensions" };
const attachment = (streamEpoch = 1, lease: string | null = "lease-1", inputSeq = 0): SurfaceAttachment => ({ scope: { ...scope }, streamEpoch, controllerLeaseId: lease, inputSeq, cols: 80, rows: 24 });
const frame = (seq: number, data: string, streamEpoch = 1): UiFrame => ({ ...scope, type: "ui.vt", streamEpoch, seq, data });
const flush = async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve(); };

class Terminal implements TerminalSink {
  readonly ops: string[] = [];
  readonly pending: (() => void)[] = [];
  reset(): void { this.ops.push("reset"); }
  resize(cols: number, rows: number): void { this.ops.push(`size:${cols}x${rows}`); }
  write(data: string, complete: () => void): void { this.ops.push(`write:${data}`); this.pending.push(complete); }
  completeAll(): void { while (this.pending.length) this.pending.shift()!(); }
}

describe("VT frame consumer", () => {
  it("writes one frame at a time and fences a reset behind the in-flight write", async () => {
    const terminal = new Terminal(), onReady = vi.fn(), onRecovery = vi.fn();
    const consumer = new VtFrameConsumer(scope, terminal, { onReady, onRecovery });
    consumer.reset(attachment());
    consumer.accept(frame(1, "old"));
    consumer.accept(frame(2, "queued"));
    consumer.reset(attachment(2));
    consumer.accept(frame(1, "new", 2));
    expect(terminal.ops).toEqual(["reset", "size:80x24", "write:old"]);
    terminal.completeAll(); await flush();
    expect(terminal.ops).toEqual(["reset", "size:80x24", "write:old", "reset", "size:80x24", "write:new"]);
    expect(onRecovery).not.toHaveBeenCalled();
  });
  it("ignores foreign scopes, old epochs and duplicates; a gap requests one redraw", async () => {
    const terminal = new Terminal(), onRecovery = vi.fn();
    const consumer = new VtFrameConsumer(scope, terminal, { onReady: vi.fn(), onRecovery });
    consumer.reset(attachment(2));
    consumer.accept({ ...frame(1, "foreign", 2), sessionId: "other" });
    consumer.accept({ ...frame(1, "old session epoch", 2), sessionEpoch: 3 });
    consumer.accept(frame(1, "old stream", 1));
    consumer.accept(frame(1, "current", 2));
    consumer.accept(frame(1, "duplicate", 2));
    terminal.completeAll(); await flush();
    expect(terminal.ops).toEqual(["reset", "size:80x24", "write:current"]);
    consumer.accept(frame(3, "after gap", 2));
    consumer.accept(frame(4, "still blocked", 2));
    expect(onRecovery).toHaveBeenCalledTimes(1);
    expect(onRecovery.mock.calls[0][0]).toMatchObject({ code: "sequence-gap", lastAppliedSeq: 1 });
  });
});

/** A port double following the runtime contract: resync advances the epoch. */
function port() {
  let handlers: SurfaceHandlers | null = null, epoch = 1, lease: string | null = null, accepted = 0;
  const inputs: Array<{ inputSeq: number; data: string; lease: string; base: number }> = [];
  const handle: SurfaceAttachmentHandle = {
    input: vi.fn(async command => { inputs.push({ inputSeq: command.inputSeq, data: command.data, lease: command.controllerLeaseId, base: command.baseStreamEpoch }); accepted = command.inputSeq; return { acceptedSeq: command.inputSeq }; }),
    resize: vi.fn(async () => {}),
    resync: vi.fn(async () => { epoch++; handlers?.onReset(attachment(epoch, lease, accepted)); }),
    control: vi.fn(async () => { lease = "lease-A"; epoch++; handlers?.onReset(attachment(epoch, lease, accepted)); }),
    release: vi.fn(async () => { lease = null; epoch++; handlers?.onReset(attachment(epoch, null, accepted)); }),
    detach: vi.fn(() => { handlers = null; }),
  };
  const surfacePort: SurfacePort = { attach: vi.fn(async (_scope, next) => { handlers = next; next.onReset(attachment(epoch, lease, accepted)); return handle; }) };
  return { surfacePort, handle, inputs, emit: (f: UiFrame) => handlers?.onFrame(f), current: () => handlers, epoch: () => epoch };
}

describe("plugin surface controller", () => {
  it("starts read-only, takes control by explicit action and fences input by lease/epoch/seq", async () => {
    const terminal = new Terminal(), states: string[] = [], p = port();
    const controller = new PluginSurfaceController(scope, p.surfacePort, terminal, s => states.push(s.status));
    await controller.connect(); await flush();
    expect(controller.state.status).toBe("readonly");
    expect(controller.input("x")).toBe(false);
    await controller.takeControl(); await flush();
    expect(controller.state).toMatchObject({ status: "connected", canInput: true });
    expect(controller.input("ab")).toBe(true);
    expect(controller.input("c")).toBe(true);
    await flush();
    expect(p.inputs).toEqual([
      { inputSeq: 1, data: "ab", lease: "lease-A", base: 2 },
      { inputSeq: 2, data: "c", lease: "lease-A", base: 2 },
    ]);
    await controller.releaseControl(); await flush();
    expect(controller.state.status).toBe("readonly");
    controller.dispose();
    expect(p.handle.detach).toHaveBeenCalled();
  });
  it("an unconfirmed input is never replayed: recovery asks for a fresh snapshot", async () => {
    const terminal = new Terminal(), p = port();
    const controller = new PluginSurfaceController(scope, p.surfacePort, terminal, () => {});
    await controller.connect(); await controller.takeControl(); await flush();
    vi.mocked(p.handle.input).mockRejectedValueOnce(new Error("connection lost"));
    controller.input("rm");
    await flush();
    expect(p.handle.resync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(p.handle.input).mock.calls).toHaveLength(1);
    expect(controller.state.status).toBe("connected");
  });
  it("splits large pastes at 64 KiB without breaking surrogate pairs", () => {
    const text = "😀".repeat(20_000);
    const pieces = splitInput(text);
    expect(pieces.map(piece => piece.data).join("")).toBe(text);
    expect(pieces.every(piece => piece.bytes <= 64 * 1024)).toBe(true);
    expect(pieces.every(piece => !/[\uD800-\uDBFF]$/.test(piece.data))).toBe(true);
  });
});
