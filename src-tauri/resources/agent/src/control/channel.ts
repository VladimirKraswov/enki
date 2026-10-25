// Generation-bound, bounded JSON-lines control; no SDK import.
export const MAX_CONTROL_LINE = 1024 * 1024;
export type SupervisorMessage =
  | { type: 'configure'; generation: string; requestId: string; token: string; origins: string[]; version: string; executable?: string; initialMaintenance?: boolean }
  | { type: 'rotate'; generation: string; requestId: string; token: string; graceMs?: number }
  | { type: 'shutdown'; generation: string; requestId: string; mode: 'drain' | 'now'; deadlineMs?: number }
  | { type: 'maintenance'; generation: string; requestId: string; mode: 'begin' | 'end' }
  /** Read-only: the exact receipt state of an earlier begin/end request id. */
  | { type: 'maintenance'; generation: string; requestId: string; mode: 'status'; target: string }
  | { type: 'response'; generation: string; id: string; ok: true; value: unknown }
  | { type: 'response'; generation: string; id: string; ok: false; error: string };
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
export function parseSupervisorMessage(line: string): SupervisorMessage | null {
  if (Buffer.byteLength(line) > MAX_CONTROL_LINE) return null;
  let value: unknown; try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  if (typeof m.generation !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(m.generation)) return null;
  const generation = m.generation;
  const token = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(x);
  if (m.type === 'response') {
    if (!uuid(m.id) || typeof m.ok !== 'boolean') return null;
    return m.ok ? { type: 'response', generation, id: m.id, ok: true, value: m.value } : { type: 'response', generation, id: m.id, ok: false, error: typeof m.error === 'string' ? m.error.slice(0, 1000) : 'Ошибка Enki.' };
  }
  if (!uuid(m.requestId)) return null;
  const requestId = m.requestId;
  switch (m.type) {
    case 'configure':
      if (!token(m.token) || !Array.isArray(m.origins) || m.origins.length > 16 || !m.origins.every((o) => typeof o === 'string' && o.length <= 200 && /^(tauri|https?):\/\/[a-z0-9.:[\]-]+$/i.test(o)) || typeof m.version !== 'string' || !m.version || m.version.length > 128) return null;
      if (m.initialMaintenance !== undefined && typeof m.initialMaintenance !== 'boolean') return null;
      return { type: 'configure', generation, requestId, token: m.token, origins: m.origins, version: m.version, ...(typeof m.executable === 'string' ? { executable: m.executable } : {}), ...(typeof m.initialMaintenance === 'boolean' ? { initialMaintenance: m.initialMaintenance } : {}) };
    case 'rotate':
      if (!token(m.token) || (m.graceMs !== undefined && (typeof m.graceMs !== 'number' || !Number.isFinite(m.graceMs) || m.graceMs < 0 || m.graceMs > 300_000))) return null;
      return { type: 'rotate', generation, requestId, token: m.token, ...(typeof m.graceMs === 'number' ? { graceMs: m.graceMs } : {}) };
    case 'shutdown':
      if (!['now', 'drain'].includes(String(m.mode)) || (m.deadlineMs !== undefined && (typeof m.deadlineMs !== 'number' || !Number.isFinite(m.deadlineMs) || m.deadlineMs < 0 || m.deadlineMs > 30 * 60_000))) return null;
      return { type: 'shutdown', generation, requestId, mode: m.mode === 'now' ? 'now' : 'drain', ...(typeof m.deadlineMs === 'number' ? { deadlineMs: m.deadlineMs } : {}) };
    case 'maintenance':
      if (m.mode === 'status') return uuid(m.target) && m.target !== requestId ? { type: 'maintenance', generation, requestId, mode: 'status', target: m.target } : null;
      return m.mode === 'begin' || m.mode === 'end' ? { type: 'maintenance', generation, requestId, mode: m.mode } : null;
    default: return null;
  }
}
/** Reject an oversized physical line before concatenating it into retained memory. */
export class LineReader {
  private buffer = '';
  private bytes = 0;
  private dropping = false;
  constructor(private readonly onLine: (line: string) => void, private readonly onOversize: () => void = () => {}) {}
  push(chunk: string): void {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf('\n', start), terminal = end >= 0;
      const extent = (terminal ? end : chunk.length) - start;
      if (!this.dropping && extent > MAX_CONTROL_LINE - this.bytes) { this.buffer = ''; this.bytes = 0; this.dropping = true; this.onOversize(); }
      const fragment = this.dropping ? '' : chunk.slice(start, terminal ? end : undefined);
      if (!this.dropping) {
        const bytes = Buffer.byteLength(fragment);
        if (this.bytes + bytes > MAX_CONTROL_LINE) { this.buffer = ''; this.bytes = 0; this.dropping = true; this.onOversize(); }
        else { this.buffer += fragment; this.bytes += bytes; }
      }
      if (terminal) { if (!this.dropping) { const line = this.buffer.replace(/\r$/, ''); this.buffer = ''; this.bytes = 0; if (line.trim()) this.onLine(line); } this.dropping = false; start = end + 1; }
      else break;
    }
  }
}
export type ControlWriter = ((message: Record<string, unknown>) => void) & { flush(deadlineMs: number): Promise<void> };
export function reserveStdout(): ControlWriter {
  const original = process.stdout.write.bind(process.stdout);
  let pending = 0;
  const waiters = new Set<() => void>();
  const error = (..._args: unknown[]) => { process.stderr.write('Enki Runtime: incidental stdout redirected to stderr\n'); };
  // Do not JSON-stringify arbitrary incidental objects: they may contain keys.
  console.log = error; console.info = error; console.debug = error;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    process.stderr.write(chunk); const callback = rest.find((r): r is () => void => typeof r === 'function'); callback?.(); return true;
  }) as typeof process.stdout.write;
  const send = ((message: Record<string, unknown>) => {
    const line = JSON.stringify(message) + '\n', bytes = Buffer.byteLength(line);
    if (bytes > MAX_CONTROL_LINE || pending + bytes > 2 * MAX_CONTROL_LINE) throw new Error('Control transport output limit exceeded');
    pending += bytes;
    original(line, () => { pending -= bytes; if (!pending) { for (const waiter of waiters) waiter(); waiters.clear(); } });
  }) as ControlWriter;
  send.flush = (deadlineMs) => pending === 0 ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
    const timer = setTimeout(() => { waiters.delete(done); reject(new Error('Control output flush deadline exceeded')); }, Math.max(0, deadlineMs));
    waiters.add(done);
  });
  return send;
}
