// Durable-cursor event stream from the Enki Runtime.
//
// Every runtime event arrives as an envelope with a monotonically increasing
// `seq`. The stream resumes from the last delivered `seq` (`after=`), so a
// reconnect replays exactly what was missed. When the runtime instance changed
// (restart) or the cursor fell out of the retained journal (`stream.reset`),
// the caller must reconcile from a fresh snapshot instead of trusting replay.
import type { EventEnvelope, ServerEventDTO } from "../../../src-tauri/resources/agent/src/protocol";
import { EVENT_FRAME_CHARACTERS } from "../../../src-tauri/resources/agent/src/protocol";
import { SseDecoder, SseFrameTooLarge } from "../../api/sse";
import type { RuntimeClient } from "./client";

export type StreamState = "connecting" | "open" | "reconnecting" | "closed" | "error";
export type StreamResetReason = "instance" | "expired" | "oversized";

export interface RuntimeStreamOptions {
  client: RuntimeClient;
  /** `directory` scopes to one project; `all` subscribes to every runtime event. */
  scope: { directory: string } | { all: true };
  signal: AbortSignal;
  onEnvelope(envelope: EventEnvelope): void;
  onState(state: StreamState, detail?: string): void;
  /** History may have gaps: re-read authoritative state (snapshot, history).
   * `oversized`: one event was too large for the wire and was not applied. */
  onReset(reason: StreamResetReason): void;
  maxBackoffMs?: number;
  /** Hello must arrive promptly; server keepalive comments count as liveness afterwards. */
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
}

interface Hello { type: "stream.hello"; instance: string; head: number; contract: number }
interface Reset { type: "stream.reset"; reason: string; head: number }

function isEnvelope(value: unknown): value is EventEnvelope {
  const e = value as EventEnvelope;
  return !!e && typeof e === "object" && Number.isSafeInteger(e.seq) && !!e.event && typeof e.event.type === "string";
}

export async function runRuntimeStream(opts: RuntimeStreamOptions): Promise<void> {
  const maxBackoff = opts.maxBackoffMs ?? 15000;
  let attempt = 0;
  let cursor: number | null = null;
  let instance: string | null = null;
  let refreshConnection = false;
  try {
    while (!opts.signal.aborted) {
      opts.onState(attempt === 0 ? "connecting" : "reconnecting");
      let openedAt: number | undefined;
      const request = new AbortController();
      const abort = () => request.abort(opts.signal.reason);
      opts.signal.addEventListener("abort", abort, { once: true });
      if (opts.signal.aborted) abort();
      let timer: ReturnType<typeof setTimeout>;
      const arm = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => request.abort(new Error("Поток событий не отвечает. Повторяем подключение.")), ms);
      };
      // Bound refresh, headers AND reads, even if a transport neglects AbortSignal.
      const bounded = <T,>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const stop = () => { cleanup(); reject(request.signal.reason); };
        const cleanup = () => request.signal.removeEventListener("abort", stop);
        work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
        request.signal.addEventListener("abort", stop, { once: true });
        if (request.signal.aborted) stop();
      });
      arm(opts.connectTimeoutMs ?? 20_000);
      try {
        if (refreshConnection) { await bounded(opts.client.reconnect()); refreshConnection = false; }
        const query = "all" in opts.scope ? { all: "1" } : { directory: opts.scope.directory };
        const send = () => fetch(opts.client.url("/events", { ...query, after: cursor ?? undefined }), {
          headers: { ...opts.client.authorization(), Accept: "text/event-stream" },
          signal: request.signal,
          cache: "no-store",
        });
        let res = await bounded(send());
        if (res.status === 401) {
          void res.body?.cancel().catch(() => {});
          await bounded(opts.client.reconnect());
          res = await bounded(send());
        }
        if (!res.ok || !res.body) {
          void res.body?.cancel().catch(() => {});
          throw new Error(`event stream HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const cancel = () => { void reader.cancel().catch(() => {}); };
        opts.signal.addEventListener("abort", cancel, { once: true });
        try {
          const decoder = new TextDecoder();
          // Same bound the runtime applies before sending (EVENT_WIRE_LIMIT_BYTES).
          const frames = new SseDecoder(EVENT_FRAME_CHARACTERS);
          while (!opts.signal.aborted) {
            const { done, value } = await bounded(reader.read());
            if (done || opts.signal.aborted) break;
            if (openedAt !== undefined && value.byteLength) arm(opts.idleTimeoutMs ?? 45_000);
            try {
              frames.push(decoder.decode(value, { stream: true }), data => {
                if (opts.signal.aborted) return false;
                let parsed: unknown;
                try { parsed = JSON.parse(data); }
                catch { throw new Error("Invalid event stream JSON"); }
                const control = parsed as Hello | Reset;
                if (control?.type === "stream.hello") {
                  openedAt = Date.now();
                  const restarted = instance !== null && control.instance !== instance;
                  instance = control.instance;
                  arm(opts.idleTimeoutMs ?? 45_000);
                  opts.onState("open");
                  if (restarted) {
                    // A restarted runtime has a new journal: the old cursor means nothing.
                    cursor = control.head;
                    opts.onReset("instance");
                  } else if (cursor === null) cursor = control.head;
                  return true;
                }
                if (control?.type === "stream.reset") {
                  cursor = control.head;
                  opts.onReset("expired");
                  return true;
                }
                if (!isEnvelope(parsed)) return true;
                if (cursor !== null && parsed.seq <= cursor) return true;
                cursor = parsed.seq;
                // The runtime announced an event too large for the wire under
                // this seq: reconcile from the authoritative routes, then go on.
                // A stub naming its chat is handled by the store (that chat's
                // history is re-read); without one, everything is resynced.
                if (parsed.event.type === "event.oversized" && typeof parsed.event.properties?.sessionID !== "string") {
                  opts.onReset("oversized");
                  return !opts.signal.aborted;
                }
                opts.onEnvelope(parsed);
                return !opts.signal.aborted;
              });
            } catch (error) {
              // An older runtime sent a frame above the bound. Its seq precedes the
              // data, so skip exactly that event, reconcile, and reconnect after
              // it; without an id this stays an error (bounded backoff below).
              const seq = error instanceof SseFrameTooLarge && error.id !== null ? Number(error.id) : NaN;
              if (!Number.isSafeInteger(seq) || (cursor !== null && seq <= cursor)) throw error;
              cursor = seq;
              opts.onReset("oversized");
              break;
            }
          }
        } finally {
          opts.signal.removeEventListener("abort", cancel);
          // Cancellation itself can wait for a broken network transport. It
          // must not keep the next, cursor-preserving attempt from starting.
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (!opts.signal.aborted) { refreshConnection = true; opts.onState("reconnecting", "stream ended"); }
      } catch (error) {
        if (opts.signal.aborted) break;
        refreshConnection = true;
        opts.onState("error", error instanceof Error ? error.message : "Event stream failed");
      } finally {
        clearTimeout(timer!);
        opts.signal.removeEventListener("abort", abort);
        request.abort();
      }
      if (opts.signal.aborted) break;
      if (openedAt !== undefined && Date.now() - openedAt >= 10000) attempt = 0;
      attempt += 1;
      const delay = Math.min(maxBackoff, 1000 * 2 ** Math.min(attempt, 6) * (0.75 + Math.random() * 0.5));
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); opts.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, delay);
        opts.signal.addEventListener("abort", done, { once: true });
        if (opts.signal.aborted) done();
      });
    }
  } finally { opts.onState("closed"); }
}

/** Runtime event (`ServerEventDTO`) in the shape the chat reducer consumes. */
export type RuntimeEvent = ServerEventDTO;
