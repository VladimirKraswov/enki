// A brief stream reconnect (navigation, runtime restart, a two-second socket
// gap) must not be reported as "work unconfirmed" or "connection lost": the
// stream resumes and the journal replays the gap. Only a reconnect that lasts
// longer than the grace period is worth the owner's attention.

export const STREAM_GRACE_MS = 5000;

/** True only for a reconnect that has already lasted the grace period. */
export function streamStalled(streamState: string | undefined, downSince: number | null | undefined, now: number, grace = STREAM_GRACE_MS): boolean {
  if (streamState === "open" || streamState === "connecting" || streamState === "idle") return false;
  if (typeof downSince !== "number" || !Number.isFinite(downSince)) return false;
  return now - downSince >= grace;
}
