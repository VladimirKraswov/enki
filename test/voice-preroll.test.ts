// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { SegmentedCapture } from "../src/voice/capture";
import type { DictationSegment, DictationStorage } from "../src/voice/journal";

class FakeRecorder {
  static isTypeSupported() { return true; }
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; this.onstop?.(); }
  addEventListener() { /* pre-roll listener is covered by handOver in the component */ }
}
const original = globalThis.MediaRecorder;
afterEach(() => { (globalThis as { MediaRecorder?: unknown }).MediaRecorder = original; });

it("keeps audio captured during preparation as the first complete segment", async () => {
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeRecorder;
  const put = vi.fn(async (_segment: DictationSegment) => undefined);
  const storage = { put } as unknown as DictationStorage;
  const input = { getTracks: () => [{ readyState: "live", muted: false, stop() {} }] } as unknown as MediaStream;
  const ready = vi.fn();
  const settings = { endpoint: "https://asr.invalid", model: "m", language: "ru", enabled: true } as never;
  const capture = new SegmentedCapture(input, null, storage, "workspace", "draft", settings, {
    ready, progress: () => undefined, segmentReady: () => undefined, stopped: () => undefined, error: () => undefined,
  });
  const first = new Blob(["первое слово"], { type: "audio/webm" });
  capture.start([first]);
  await Promise.resolve(); await Promise.resolve();
  expect(put).toHaveBeenCalledTimes(1);
  const seeded = put.mock.calls[0][0];
  expect(seeded.complete).toBe(true);
  expect(seeded.parts).toEqual([first]);
  expect(ready).toHaveBeenCalled();
  await capture.finish();
});

it("records normally when preparation produced no pre-roll audio", async () => {
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeRecorder;
  const put = vi.fn(async (_segment: DictationSegment) => undefined);
  const input = { getTracks: () => [{ readyState: "live", muted: false, stop() {} }] } as unknown as MediaStream;
  const capture = new SegmentedCapture(input, null, { put } as unknown as DictationStorage, "workspace", "draft", {} as never, {
    ready: () => undefined, progress: () => undefined, segmentReady: () => undefined, stopped: () => undefined, error: () => undefined,
  });
  capture.start([]);
  expect(put).not.toHaveBeenCalled();
  await capture.finish();
});
