// Wire IDs are scoped to the imported runtime session. SQL IDs remain in
// archive annotations and are never treated as live SDK entry IDs.
import { createHash } from "node:crypto";
import type { MessageDTO } from "./protocol.ts";

export function archiveWireId(kind: "message" | "part", sessionID: string, sourceID: string): string {
  const prefix = kind === "message" ? "msg_legacy_" : "prt_legacy_";
  return prefix + createHash("sha256").update("enki-archive-wire-v1\0").update(sessionID).update("\0").update(sourceID).digest("hex").slice(0, 48);
}
export function projectArchiveMessages(messages: readonly MessageDTO[], sessionID: string): MessageDTO[] {
  return messages.map(message => {
    const id = archiveWireId("message", sessionID, message.info.id);
    return {
      info: { ...message.info, sessionID, id,
        ...(message.info.parentID ? { parentID: archiveWireId("message", sessionID, message.info.parentID) } : {}) },
      parts: message.parts.map(part => ({ ...part, sessionID, messageID: id, id: archiveWireId("part", sessionID, part.id) })),
    };
  });
}
