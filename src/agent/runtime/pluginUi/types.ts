// Frontend view of the runtime plugin-UI DTOs. Scope, frames, attachments and
// their validators come from the runtime's pure transport module; the snapshot
// shapes below mirror `plugin-ui/runtime.ts` (draft-cas / surface-state import
// Node-only modules and are not part of the WebView program).
import { isAttachment, isFrame, type InputReceipt, type SurfaceAttachment, type UiFrame, type UiScope } from "../../../../src-tauri/resources/agent/src/plugin-ui/protocol";

export type { InputReceipt, SurfaceAttachment, UiFrame, UiScope };

export interface DraftSelection { start: number; end: number }
export interface DraftSnapshot { revision: number; text: string; selection: DraftSelection; updatedAt: number }
export interface DraftResult { replayed: boolean; snapshot: DraftSnapshot }

export interface UiWidget { key: string; placement: "aboveEditor" | "belowEditor"; kind: "text" | "component"; lines?: string[] }
export interface UiSurfaceState {
  revision: number;
  statuses: Record<string, string>;
  working: { message: string | null; visible: boolean; indicator: { frames?: string[]; intervalMs?: number } | null };
  hiddenThinkingLabel: string | null;
  title: string;
  toolsExpanded: boolean;
  themeName: string | null;
  widgets: UiWidget[];
}

/** Exact scope for the native gesture broker; present only for the current controller. */
export interface NativeUiScope extends UiScope { directory: string; principal: string }

export interface PendingDraftChange { id: string; baseRevision: number; origin: "user" | "extension"; text: string; committed: DraftSnapshot }
export interface PendingSubmission { id: string; text: string; draft: DraftSnapshot }

export interface UiSnapshot {
  scope: UiScope;
  nativeScope: NativeUiScope | null;
  draft: DraftSnapshot;
  state: UiSurfaceState;
  attachment: SurfaceAttachment;
  pendingDraft: PendingDraftChange | null;
  pendingSubmission: PendingSubmission | null;
}

export type DraftResolution = { kind: "discard" } | { kind: "replace"; id: string; baseRevision: number; text: string };

/** Messages of GET /sessions/:id/ui/{open,events}. */
export type UiStreamMessage =
  | { type: "ui.waiting" }
  | { type: "ui.hello"; instance: string; snapshot: UiSnapshot }
  | { type: "ui.reset"; attachment: SurfaceAttachment }
  | { type: "ui.vt"; frame: UiFrame }
  | { type: "ui.closed"; reason: string }
  | { type: "ui.event"; seq: number; event: { type: string; properties: Record<string, unknown> } }
  | { type: "ui.invalid"; what: "reset" | "frame" };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isDraft(value: unknown): value is DraftSnapshot {
  return record(value) && Number.isSafeInteger(value.revision) && typeof value.text === "string"
    && record(value.selection) && Number.isSafeInteger(value.selection.start) && Number.isSafeInteger(value.selection.end);
}
export function isUiSnapshot(value: unknown): value is UiSnapshot {
  return record(value) && record(value.scope) && isDraft(value.draft) && record(value.state) && record(value.attachment)
    && Array.isArray(value.state.widgets) && record(value.state.statuses);
}
export function parseUiMessage(value: unknown): UiStreamMessage | null {
  if (!record(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "ui.waiting": return { type: "ui.waiting" };
    case "ui.hello": return isUiSnapshot(value.snapshot) && typeof value.instance === "string" ? { type: "ui.hello", instance: value.instance, snapshot: value.snapshot } : null;
    case "ui.closed": return { type: "ui.closed", reason: typeof value.reason === "string" ? value.reason : "" };
    case "ui.event": return record(value.event) && typeof value.event.type === "string" && typeof value.seq === "number"
      ? { type: "ui.event", seq: value.seq, event: { type: value.event.type, properties: record(value.event.properties) ? value.event.properties : {} } } : null;
    // Invalid VT data is reported (the consumer requests a full redraw), never dropped silently.
    case "ui.reset": return isAttachment(value.attachment) ? { type: "ui.reset", attachment: value.attachment } : { type: "ui.invalid", what: "reset" };
    case "ui.vt": return isFrame(value.frame) ? { type: "ui.vt", frame: value.frame } : { type: "ui.invalid", what: "frame" };
    default: return null;
  }
}
