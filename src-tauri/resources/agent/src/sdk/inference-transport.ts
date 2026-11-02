// A transparent observer of the SDK's PUBLIC per-request fetch option. It does
// not consume a second stream, patch global fetch, retry inference or own a loop.
import { createHash, randomUUID } from 'node:crypto';
import type { InferenceProgress } from '../inference-progress.ts';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  return object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
}
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v) ?? '').digest('hex');

/** Tool declarations are a set by name. Reconnection must not randomize the
 * very first tokens of the model prompt. Never sort messages or content. */
export function stableTools(payload: unknown): unknown {
  if (!object(payload) || !Array.isArray(payload.tools)) return payload;
  const name = (tool: unknown) => object(tool) && object(tool.function) && typeof tool.function.name === 'string' ? tool.function.name : null;
  const names = payload.tools.map(name);
  if (names.some(n => n === null) || new Set(names).size !== names.length) return payload;
  return { ...payload, tools: payload.tools.map(canonical).sort((a, b) => name(a)! < name(b)! ? -1 : name(a)! > name(b)! ? 1 : 0) };
}

export class InferenceObserver {
  private serial = 0;
  private prefix?: { system: string; tools: string };
  constructor(private emit: (progress: InferenceProgress) => void, private now = Date.now) {}

  begin(payload: unknown, signal?: AbortSignal) {
    const serial = ++this.serial, startedAt = this.now(), requestID = randomUUID();
    const first = object(payload) && Array.isArray(payload.messages) ? payload.messages.find(m => object(m) && ['system', 'developer'].includes(String(m.role))) : undefined;
    const fingerprint = { system: hash(first), tools: hash(object(payload) ? payload.tools : undefined) };
    const changed = !!this.prefix && (fingerprint.system !== this.prefix.system || fingerprint.tools !== this.prefix.tools);
    this.prefix = fingerprint;
    let phase: InferenceProgress['phase'] = 'waiting', lastAt = -Infinity;
    let counters: Pick<InferenceProgress, 'total' | 'processed' | 'cached' | 'cache'> = {};
    let active = true;
    const publish = (force = false) => {
      const now = this.now();
      if (!active || signal?.aborted || serial !== this.serial || !force && now - lastAt < 1000) return;
      lastAt = now;
      this.emit({ requestID, phase, startedAt, elapsedMs: Math.max(0, now - startedAt), ...counters });
    };
    publish(true);
    const frame = (value: unknown) => {
      if (!object(value) || !active || signal?.aborted || serial !== this.serial) return;
      const p = value.prompt_progress;
      if (object(p) && ['total', 'processed', 'cache', 'time_ms'].every(k => Number.isSafeInteger(p[k]) && Number(p[k]) >= 0)) {
        const total = Number(p.total), processed = Number(p.processed), cached = Number(p.cache);
        if (cached > processed || processed > total || counters.total !== undefined && (total !== counters.total || cached !== counters.cached || processed < (counters.processed ?? 0))) return;
        // Late metadata must never move a decoding request back into prefill.
        if (phase === 'reasoning' || phase === 'answer') return;
        const initial = counters.total === undefined;
        counters = { total, processed, cached, cache: cached > 0 ? 'reused' : changed ? 'prefix_changed' : 'cold' };
        phase = 'prefill'; publish(initial || processed === total); return;
      }
      if (!Array.isArray(value.choices)) return;
      for (const c of value.choices) {
        if (!object(c) || !object(c.delta)) continue;
        const next = typeof c.delta.content === 'string' && c.delta.content || Array.isArray(c.delta.tool_calls) && c.delta.tool_calls.length
          ? 'answer' : typeof c.delta.reasoning_content === 'string' && c.delta.reasoning_content ? 'reasoning' : null;
        if (next && next !== phase && !(phase === 'answer' && next === 'reasoning')) { phase = next; publish(true); }
      }
    };
    return {
      wrap: (request: typeof fetch): typeof fetch => async (input, init) => {
        const response = await request(input, init);
        if (!response.ok || !response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) return response;
        const decoder = new TextDecoder(); let pending = '', dropped = false;
        const tap = new TransformStream<Uint8Array, Uint8Array>({
          transform(bytes, controller) {
            // Forward ORIGINAL bytes, including vendor fields, usage and errors.
            controller.enqueue(bytes);
            const text = decoder.decode(bytes, { stream: true });
            pending += text;
            // Tool argument frames can be enormous. Observation is bounded and
            // optional; a large/malformed frame must never break the SDK stream.
            let end;
            while ((end = pending.indexOf('\n')) >= 0) {
              const line = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1);
              if (dropped) { dropped = false; continue; }
              if (line.length <= 64 * 1024 && line.startsWith('data:')) {
                try { frame(JSON.parse(line.slice(5).trim())); } catch { /* Includes [DONE]. */ }
              }
            }
            if (pending.length > 64 * 1024) { pending = ''; dropped = true; }
          },
        });
        return new Response(response.body.pipeThrough(tap), { status: response.status, statusText: response.statusText, headers: response.headers });
      },
      end: () => { active = false; },
    };
  }
}
