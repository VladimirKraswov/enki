// Events observed while an authoritative snapshot (history page, reconnect
// resync) is in flight. The consumers need very little of them:
// reconcileHistoryEvents uses part events only for their IDS (the live chat
// state already holds the newest part contents) and replays the small
// non-part events; resync replays status/permission/question events. So a
// part event is kept as one compact `{sessionID, partID}` reference per part,
// never as a retained copy of a growing reasoning/tool snapshot. Overflow is
// explicit, so a caller never applies a snapshot over an incomplete journal.
import type { ServerEvent } from "../api/types";

export const HISTORY_JOURNAL_LIMIT = 20_000;

export class HistoryJournal {
  readonly events: ServerEvent[] = [];
  private readonly parts = new Set<string>();
  private full = false;

  get overflowed(): boolean { return this.full; }

  push(event: ServerEvent): void {
    if (this.full) return;
    if (event.type.startsWith("message.part.")) {
      const props = (event.properties ?? {}) as { sessionID?: unknown; partID?: unknown; part?: { id?: unknown; sessionID?: unknown } };
      const sessionID = typeof props.sessionID === "string" ? props.sessionID : props.part?.sessionID;
      const partID = typeof props.part?.id === "string" ? props.part.id : props.partID;
      if (typeof sessionID !== "string" || typeof partID !== "string") return;
      const key = `${sessionID}\u0000${partID}`;
      if (this.parts.has(key)) return;
      this.parts.add(key);
      this.events.push({ type: event.type, properties: { sessionID, partID } });
    } else {
      this.events.push(event);
    }
    if (this.events.length >= HISTORY_JOURNAL_LIMIT) this.full = true;
  }
}
