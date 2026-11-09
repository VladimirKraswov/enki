import { useEffect, useState } from "react";
import { streamStalled } from "../state/streamHealth";

/** Re-evaluates once a second while the stream is down, so a reconnect that
 * ends quickly never flashes an alarm and a real outage still reports itself. */
export function useStreamStalled(streamState: string | undefined, downSince: number | null | undefined): boolean {
  const [now, setNow] = useState(() => Date.now());
  const pending = streamState !== undefined && streamState !== "open" && streamState !== "connecting" && streamState !== "idle";
  useEffect(() => {
    if (!pending) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pending, downSince]);
  return streamStalled(streamState, downSince, now);
}
