// A turn interrupted by an app/runtime restart leaves its last journal status
// as busy/retry/waiting. Clients then draw a "no fresh status" mark on a chat
// that is actually idle. On startup nothing is running in a fresh process, so
// such sticky statuses are reset once, explicitly, instead of being guessed by
// the UI.
export function staleRunningStatuses(rows: ReadonlyArray<{ session_id: string; payload: string }>): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as { properties?: { status?: { type?: unknown } } } | null;
      const type = payload?.properties?.status?.type;
      if (typeof type === "string" && type !== "idle") ids.push(row.session_id);
    } catch { /* an unreadable event cannot prove that work is running */ }
  }
  return ids;
}
