/** Transport data only. Factories, Components and generic results never cross it. */
export const PLUGIN_UI_PROTOCOL_VERSION = 1 as const;
export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_QUEUED_BYTES = 1024 * 1024;
export const MAX_DRAFT_BYTES = 2 * 1024 * 1024;

export interface UiScope {
  hostId: string;
  sessionId: string;
  sessionEpoch: number;
  surfaceId: string;
}
export interface UiFrame extends UiScope {
  type: "ui.vt";
  streamEpoch: number;
  seq: number;
  data: string;
}
export interface UiInput extends UiScope {
  type: "ui.input";
  controllerLeaseId: string;
  inputSeq: number;
  baseStreamEpoch: number;
  data: string;
}
export interface UiResize extends UiScope {
  type: "ui.resize";
  controllerLeaseId: string;
  baseStreamEpoch: number;
  cols: number;
  rows: number;
}
export interface SurfaceAttachment {
  scope: UiScope;
  streamEpoch: number;
  controllerLeaseId: string | null;
  /** Last admitted input, not proof that every handler completed successfully. */
  inputSeq: number;
  cols: number;
  rows: number;
}
export interface InputReceipt { acceptedSeq: number }

export class UiProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "UiProtocolError";
  }
}
export function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
export function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function boundedText(value: unknown, maxBytes: number, allowEmpty = true): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0) && byteLength(value) <= maxBytes;
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(value);
}
export function isScope(value: unknown): value is UiScope {
  return record(value) && id(value.hostId) && id(value.sessionId) && id(value.surfaceId)
    && integer(value.sessionEpoch, 1);
}
export function sameScope(a: UiScope, b: UiScope): boolean {
  return a.hostId === b.hostId && a.sessionId === b.sessionId
    && a.sessionEpoch === b.sessionEpoch && a.surfaceId === b.surfaceId;
}
export function isFrame(value: unknown): value is UiFrame {
  return isScope(value) && record(value) && value.type === "ui.vt"
    && integer(value.streamEpoch, 1) && integer(value.seq, 1)
    && boundedText(value.data, MAX_FRAME_BYTES);
}
export function isAttachment(value: unknown): value is SurfaceAttachment {
  return record(value) && isScope(value.scope) && integer(value.streamEpoch, 1)
    && (value.controllerLeaseId === null || id(value.controllerLeaseId))
    && integer(value.inputSeq, 0) && integer(value.cols, 1, 1000) && integer(value.rows, 1, 1000);
}
export function isInput(value: unknown): value is UiInput {
  return isScope(value) && record(value) && value.type === "ui.input"
    && id(value.controllerLeaseId) && integer(value.inputSeq, 1)
    && integer(value.baseStreamEpoch, 1) && boundedText(value.data, MAX_INPUT_BYTES, false);
}
export function isResize(value: unknown): value is UiResize {
  return isScope(value) && record(value) && value.type === "ui.resize"
    && id(value.controllerLeaseId) && integer(value.baseStreamEpoch, 1)
    && integer(value.cols, 1, 1000) && integer(value.rows, 1, 1000);
}
export function scopeCopy(scope: UiScope): UiScope {
  if (!isScope(scope)) throw new UiProtocolError("scope", "Некорректная принадлежность интерфейса расширения.");
  return Object.freeze({ hostId: scope.hostId, sessionId: scope.sessionId,
    sessionEpoch: scope.sessionEpoch, surfaceId: scope.surfaceId });
}
