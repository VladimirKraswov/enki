// Event journal with a durable cursor.
//
// Every event gets a monotonic `seq`. Durable events (message/part snapshots,
// status, permissions, queue, receipts) are written to SQLite; high-volume
// transient events (text deltas, cumulative reasoning, partial tool output) stay
// in a bounded memory ring. Durable entry replacement events always carry full
// content, so a client that missed transient events still converges.
//
// Sequence numbers are reserved in persisted blocks, so a restart never reuses
// a number a client may already hold as its cursor.

import type { EventEnvelope, ServerEventDTO } from "../protocol.ts";
import { integer, text, optionalText, type Database, type SqlValue } from "./db.ts";

const BLOCK = 10_000;
const TRANSIENT_LIMIT = 20_000;
/** Serialized characters retained by the transient ring (all sessions). */
const TRANSIENT_BYTES = 8 * 1024 * 1024;
const DURABLE_RETAIN = 200_000;

interface TransientEntry { envelope: EventEnvelope; size: number; key: string | null; dead: boolean }

/**
 * Cumulative transient snapshots (reasoning text, partial tool output, SDK
 * queue counts) are REPLACEABLE: a newer one of the same session part carries
 * everything the older one did, so only the latest is retained. Deltas are
 * not replaceable. Without this, n growing snapshots retained ~n²/2 prefix
 * characters until the count cap.
 */
export function transientKey(sessionID: string | null, event: ServerEventDTO): string | null {
  if (event.type === "session.sdk_queue") return `queue\u0000${sessionID ?? ""}`;
  if (event.type !== "message.part.updated") return null;
  const part = event.properties?.part as { id?: unknown } | undefined;
  return typeof part?.id === "string" ? `part\u0000${sessionID ?? ""}\u0000${part.id}` : null;
}

export interface EventFilter {
  /** Only events of this directory (plus runtime-wide events). */
  directory?: string;
  sessionID?: string;
  /** All directories: used for background activity markers. */
  all?: boolean;
}

export type EventListener = (envelope: EventEnvelope) => void;

interface Subscriber { filter: EventFilter; listener: EventListener }

export function matches(filter: EventFilter, envelope: EventEnvelope): boolean {
  if (filter.sessionID && envelope.sessionID !== filter.sessionID) return false;
  if (filter.all) return true;
  if (filter.directory === undefined) return envelope.directory === null;
  return envelope.directory === filter.directory || envelope.directory === null;
}

export class EventJournal {
  private next: number;
  private reserved: number;
  private transient: TransientEntry[] = [];
  /** Ring index: entries of `transient` before it are consumed (evicted); see
   * retain(). Distinct from the public `head` getter (highest emitted seq) —
   * an own field of the same name would shadow that getter at runtime. */
  private ringStart = 0;
  private live = 0;
  private bytes = 0;
  private readonly latest = new Map<string, TransientEntry>();
  /** Highest seq of a transient event dropped by the budget, per directory ("" = runtime-wide). */
  private readonly evicted = new Map<string, number>();
  private subscribers = new Set<Subscriber>();

  constructor(private readonly db: Database) {
    const durable = integer(db.get("SELECT MAX(seq) AS seq FROM events"), "seq");
    const stored = Number(text(db.get("SELECT value FROM meta WHERE key='seq_reserved'"), "value") || 0);
    this.next = Math.max(durable, stored) + 1;
    this.reserved = this.next;
    this.reserve();
  }

  private reserve(): void {
    const reserved = this.next + BLOCK;
    this.db.run("INSERT INTO meta(key,value) VALUES('seq_reserved',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(reserved));
    this.reserved = reserved;
    // A reservation written inside a rolled-back transaction is not durable.
    // Invalidate its cache before another transient event can be published.
    this.db.afterRollback(() => { this.reserved = 0; });
  }

  get head(): number {
    return this.next - 1;
  }

  /** Oldest durable seq still replayable, or null when nothing durable is retained. */
  oldest(): number | null {
    const value = this.db.get("SELECT MIN(seq) AS seq FROM events")?.seq;
    return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : null;
  }

  /** Durable events were pruned after `cursor`: replay would have a hole. */
  private expired(cursor: number): boolean {
    const oldest = this.oldest();
    const pruned = Number(text(this.db.get("SELECT value FROM meta WHERE key='pruned_before'"), "value") || 0);
    return cursor + 1 < pruned || (oldest !== null && pruned > 0 && cursor + 1 < oldest);
  }

  append(directory: string | null, sessionID: string | null, event: ServerEventDTO, transient = false): EventEnvelope {
    if (this.next >= this.reserved) this.reserve();
    const envelope: EventEnvelope = { seq: this.next++, time: Date.now(), directory, sessionID, event: { ...event, id: undefined } };
    envelope.event.id = `e${envelope.seq}`;
    // Snapshot the same wire value for persistence and delayed live publication;
    // callers cannot mutate an uncommitted envelope's nested properties later.
    const payload = JSON.stringify(envelope.event);
    envelope.event = JSON.parse(payload) as ServerEventDTO;
    if (!transient) {
      this.db.run("INSERT INTO events(seq,time,directory,session_id,type,payload) VALUES(?,?,?,?,?,?)",
        envelope.seq, envelope.time, directory, sessionID, event.type, payload);
    }
    this.db.afterCommit(() => {
      if (transient) this.retain(envelope, payload.length);
      for (const subscriber of [...this.subscribers]) {
        if (!matches(subscriber.filter, envelope)) continue;
        try { subscriber.listener(envelope); }
        catch { this.subscribers.delete(subscriber); }
      }
    });
    return envelope;
  }

  /** Bounded by count AND serialized size; superseded snapshots are dropped. */
  private retain(envelope: EventEnvelope, size: number): void {
    const key = transientKey(envelope.sessionID, envelope.event);
    const entry: TransientEntry = { envelope, size, key, dead: false };
    if (key) {
      const previous = this.latest.get(key);
      if (previous && !previous.dead) { previous.dead = true; this.live--; this.bytes -= previous.size; }
      this.latest.set(key, entry);
    }
    this.transient.push(entry); this.live++; this.bytes += size;
    while ((this.live > TRANSIENT_LIMIT || this.bytes > TRANSIENT_BYTES) && this.ringStart < this.transient.length) {
      const oldest = this.transient[this.ringStart++];
      if (oldest.dead) continue;
      oldest.dead = true; this.live--; this.bytes -= oldest.size;
      if (oldest.key && this.latest.get(oldest.key) === oldest) this.latest.delete(oldest.key);
      // A client whose cursor predates this event can no longer replay it.
      const scope = oldest.envelope.directory ?? "";
      this.evicted.set(scope, Math.max(this.evicted.get(scope) ?? 0, oldest.envelope.seq));
    }
    // Compact consumed/superseded entries in amortized O(1) per append.
    if (this.transient.length - this.ringStart > 2 * this.live + 64 || this.ringStart > 4096) {
      this.transient = this.transient.slice(this.ringStart).filter((item) => !item.dead);
      this.ringStart = 0;
    }
  }

  /** Retained transient characters/events (diagnostics and tests). */
  transientStats(): { events: number; bytes: number } { return { events: this.live, bytes: this.bytes }; }

  /** A budget-evicted transient event after `cursor` would be missing from replay. */
  private transientGap(filter: EventFilter, cursor: number): boolean {
    if (filter.all) { for (const seq of this.evicted.values()) if (seq > cursor) return true; return false; }
    if ((this.evicted.get("") ?? 0) > cursor) return true;
    return filter.directory !== undefined && (this.evicted.get(filter.directory) ?? 0) > cursor;
  }

  /** Replay after `cursor`. Returns null when the cursor predates retention
   * (durable pruning OR a budget-evicted transient event): reconcile instead. */
  replay(filter: EventFilter, cursor: number, limit = 5_000): EventEnvelope[] | null {
    if (this.expired(cursor) || this.transientGap(filter, cursor)) return null;
    const bound = Number.isFinite(limit) ? Math.max(0, Math.min(5_000, Math.floor(limit))) : 5_000;
    if (bound === 0) return [];
    const where = ["seq > ?"];
    const params: SqlValue[] = [cursor];
    if (filter.sessionID) { where.push("session_id = ?"); params.push(filter.sessionID); }
    if (!filter.all) {
      if (filter.directory === undefined) where.push("directory IS NULL");
      else { where.push("(directory = ? OR directory IS NULL)"); params.push(filter.directory); }
    }
    params.push(bound);
    const rows = this.db.all(`SELECT seq,time,directory,session_id,payload FROM events WHERE ${where.join(" AND ")} ORDER BY seq LIMIT ?`, ...params);
    const durable: EventEnvelope[] = rows.map((row) => ({
      seq: integer(row, "seq"), time: integer(row, "time"),
      directory: optionalText(row, "directory"), sessionID: optionalText(row, "session_id"),
      event: JSON.parse(text(row, "payload")) as ServerEventDTO,
    }));
    const transient = this.transient.flatMap((entry) => !entry.dead && entry.envelope.seq > cursor && matches(filter, entry.envelope) ? [entry.envelope] : []);
    return [...durable, ...transient].sort((a, b) => a.seq - b.seq).slice(0, bound);
  }

  subscribe(filter: EventFilter, listener: EventListener): () => void {
    const subscriber = { filter, listener };
    this.subscribers.add(subscriber);
    return () => { this.subscribers.delete(subscriber); };
  }

  prune(): void {
    const max = integer(this.db.get("SELECT MAX(seq) AS seq FROM events"), "seq");
    const before = max - DURABLE_RETAIN;
    if (before <= 0) return;
    this.db.transaction(() => {
      this.db.run("DELETE FROM events WHERE seq < ?", before);
      this.db.run("INSERT INTO meta(key,value) VALUES('pruned_before',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(before));
    });
  }
}
