// Pre-2.0 UI-owned queues and timers → the runtime's durable cutover journal.
//
// The runtime journal (POST /migrations/cutover) stores every complete item
// before publishing it, keyed by installation/workspace/source/kind/legacy id,
// so retries after a crash or lost acknowledgement return the same receipts.
// This side only builds the exact items and keeps the old preferences/storage
// as the backup until a receipt for THAT item says accepted or resolved. There
// is no blanket "migrated" flag: one failed item or workspace never marks any
// other item or workspace done, and nothing is turned into plain text, sent
// under an old session id or dispatched by the migration itself.
import type { ModelRef, PromptPart } from "../../src-tauri/resources/agent/src/protocol";
import type { CutoverEngine, CutoverItem, CutoverReceiptDTO } from "../agent/runtime/client";
import type { QueuedPrompt } from "./queue";

const INSTALLATION_KEY = "enki.installation.v1";

/** Stable id of this app installation (not a secret); created once. */
export function installationId(storage: Pick<Storage, "getItem" | "setItem">): string {
  const saved = storage.getItem(INSTALLATION_KEY);
  if (saved && /^[A-Za-z0-9-]{8,64}$/.test(saved)) return saved;
  const created = crypto.randomUUID();
  storage.setItem(INSTALLATION_KEY, created);
  return created;
}

/** Pre-2.0 chats were OpenCode (`ses_…`) or Pi CLI; the runtime maps them only by exact imported source. */
export function legacyEngineOf(sessionID: string): CutoverEngine {
  return sessionID.startsWith("ses_") ? "opencode" : "pi-cli";
}

const modelOf = (model: QueuedPrompt["model"]): ModelRef => ({ providerID: model.providerID, modelID: model.modelID, variant: model.variant ?? null });

/** Attachment bytes of one old item; `missing` counts files that could not be read (never silently dropped). */
export type ReadAttachments = (item: QueuedPrompt) => Promise<{ parts: PromptPart[]; missing: number }>;

export async function queueCutoverItems(legacy: Record<string, QueuedPrompt[]>, read: ReadAttachments): Promise<CutoverItem[]> {
  const items: CutoverItem[] = [];
  for (const [sessionID, list] of Object.entries(legacy)) for (const item of list) {
    const session = item.sessionID || sessionID;
    if (!validQueueItem(item, sessionID)) continue; // cannot be addressed; stays in the backup and is reported
    let attachments: { parts: PromptPart[]; missing: number } = { parts: [], missing: 0 };
    if (item.attachments?.files.length) {
      try { attachments = await read(item); }
      catch { attachments = { parts: [], missing: item.attachments.files.length }; }
    }
    items.push({ kind: "queue", legacyId: item.id, session: { engine: legacyEngineOf(session), id: session, directory: item.directory },
      queue: { text: item.text, parts: attachments.parts, model: modelOf(item.model), ...(item.agent ? { agent: item.agent } : {}),
        // A send the old UI may have started is uncertain, never "ready".
        state: item.state === "ready" ? "ready" : "uncertain", ...(item.error ? { error: item.error } : {}),
        ...(item.queuedAt !== undefined ? { queuedAt: item.queuedAt } : {}), ...(attachments.missing ? { missingAttachments: attachments.missing } : {}) } });
  }
  return items;
}

/** Items that could not even be addressed (no id/session/directory): kept in the backup, shown to the user. */
export function unaddressableQueueItems(legacy: Record<string, QueuedPrompt[]>): number {
  return Object.entries(legacy).reduce((n, [sessionID, list]) => n + list.filter((item) => !validQueueItem(item, sessionID)).length, 0);
}

/** Only an accepted or explicitly resolved receipt releases the backup copy of an item. */
export function acknowledged(receipts: readonly CutoverReceiptDTO[]): Set<string> {
  return new Set(receipts.filter((r) => r.state === "accepted" || r.state === "resolved").map((r) => r.legacyId));
}

/** Remove exactly the acknowledged items; everything else (quarantined, failed, unknown) stays. */
export function pruneQueues(legacy: Record<string, QueuedPrompt[]>, done: ReadonlySet<string>): Record<string, QueuedPrompt[]> {
  const next: Record<string, QueuedPrompt[]> = {};
  for (const [sessionID, list] of Object.entries(legacy)) {
    const kept = list.filter((item) => !done.has(item.id));
    if (kept.length) next[sessionID] = kept;
  }
  return next;
}

/** Old window-scheduler record (ocdesktop.scheduled-prompts.v1). */
export interface LegacyTimer {
  id: string; server: string; directory: string; sessionID: string; title: string; prompt: string; minutes: number;
  mode?: "once" | "repeat"; runAt?: number; requestKey?: string; model: QueuedPrompt["model"];
  enabled: boolean; nextAt?: number; lastAt?: number; state: string; detail?: string;
}

const absolute = (p: unknown) => typeof p === "string" && p.length <= 4096 && (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\"));
const token = (v: unknown, max: number) => typeof v === "string" && !!v && v.length <= max && !/[\u0000-\u001f]/.test(v);

/** Mirrors the runtime's strict batch validation so one malformed record cannot reject the whole batch. */
function validTimer(value: unknown): value is LegacyTimer {
  const t = value as LegacyTimer;
  return !!t && typeof t === "object" && token(t.id, 512) && typeof t.server === "string" && absolute(t.directory) && token(t.sessionID, 512)
    && typeof t.title === "string" && typeof t.prompt === "string" && !!t.prompt.trim() && t.prompt.length <= 20000
    && Number.isInteger(t.minutes) && t.minutes >= 1 && t.minutes <= 10080
    && !!t.model && token(t.model.providerID, 512) && token(t.model.modelID, 512) && typeof t.enabled === "boolean";
}

export function validQueueItem(item: QueuedPrompt, sessionID: string): boolean {
  return token(item.id, 512) && token(item.sessionID || sessionID, 512) && absolute(item.directory) && typeof item.text === "string"
    && item.text.length <= 200_000 && (item.attachments?.files.length ?? 0) <= 64 && !!item.model
    && token(item.model.providerID, 512) && token(item.model.modelID, 512) && (item.agent === undefined || token(item.agent, 64));
}

/** Timers of ONE workspace (old records carry the server they belonged to); others are untouched. */
export function timerCutoverItems(list: unknown, servers: readonly string[]): { items: CutoverItem[]; invalid: number } {
  if (!Array.isArray(list)) return { items: [], invalid: 0 };
  let invalid = 0;
  const items: CutoverItem[] = [];
  for (const value of list) {
    if (!validTimer(value)) { invalid++; continue; }
    if (!servers.includes(value.server)) continue;
    const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
    items.push({ kind: "timer", legacyId: value.id, session: { engine: legacyEngineOf(value.sessionID), id: value.sessionID, directory: value.directory },
      timer: { title: value.title.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120) || "Таймер", prompt: value.prompt, minutes: value.minutes, mode: value.mode === "once" ? "once" : "repeat",
        ...(finite(value.runAt) !== undefined ? { runAt: finite(value.runAt) } : {}), ...(value.requestKey ? { requestKey: value.requestKey.slice(0, 128) } : {}),
        model: modelOf(value.model), enabled: value.enabled, ...(finite(value.nextAt) !== undefined ? { nextAt: finite(value.nextAt) } : {}),
        ...(finite(value.lastAt) !== undefined ? { lastAt: finite(value.lastAt) } : {}), state: String(value.state || "ready"),
        ...(typeof value.detail === "string" && value.detail ? { detail: value.detail } : {}) } });
  }
  return { items, invalid };
}

/** Read an old IndexedDB draft file as a data URL (bytes unchanged). */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Не удалось прочитать вложение."));
    reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать вложение."));
    reader.readAsDataURL(blob);
  });
}
