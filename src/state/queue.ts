export interface QueuedPrompt {
  id: string;
  text: string;
  directory: string;
  sessionID: string;
  model: { providerID: string; modelID: string; variant?: string | null };
  agent?: string;
  state: "ready" | "sending" | "uncertain";
  error?: string;
  queuedAt?: number;
  /** Reserved by the open queue editor; earlier items may still be dispatched. */
  held?: boolean;
  /** Private IndexedDB copies, never blobs/base64 in preferences. */
  attachments?: {
    scope: string;
    files: { id: string; name: string; mime: string; size: number }[];
  };
}
/** Message IDs are increasing, as required by OpenCode's parent/last-user comparison. */
let lastIdTime = 0;
export function newMessageId() {
  lastIdTime = Math.max(Date.now(), lastIdTime + 1);
  return `msg_${((BigInt(lastIdTime) * 4096n + 1n) & 0xffffffffffffn).toString(16).padStart(12, "0")}${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
}
