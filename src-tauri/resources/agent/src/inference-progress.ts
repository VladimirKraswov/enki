// Additive, request-scoped wire data. Shared with the WebView: no SDK or Node.
export interface InferenceProgress {
  requestID: string;
  phase: 'waiting' | 'prefill' | 'reasoning' | 'answer';
  startedAt: number;
  elapsedMs: number;
  total?: number;
  processed?: number;
  cached?: number;
  cache?: 'reused' | 'cold' | 'prefix_changed';
  task?: 'compaction';
}

export function parseInferenceProgress(value: unknown): InferenceProgress | undefined {
  if (!value || typeof value !== 'object') return;
  const p = value as InferenceProgress;
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (typeof p.requestID !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(p.requestID)
    || !['waiting', 'prefill', 'reasoning', 'answer'].includes(p.phase)
    || !count(p.startedAt) || !count(p.elapsedMs)) return;
  if ([p.total, p.processed, p.cached].some(n => n !== undefined && !count(n))) return;
  if (p.total !== undefined && (p.processed !== undefined && p.processed > p.total || p.cached !== undefined && p.cached > p.total)) return;
  if (p.processed !== undefined && p.cached !== undefined && p.cached > p.processed) return;
  return { requestID: p.requestID, phase: p.phase, startedAt: p.startedAt, elapsedMs: p.elapsedMs,
    ...(p.total !== undefined ? { total: p.total } : {}), ...(p.processed !== undefined ? { processed: p.processed } : {}),
    ...(p.cached !== undefined ? { cached: p.cached } : {}),
    ...(['reused', 'cold', 'prefix_changed'].includes(p.cache ?? '') ? { cache: p.cache } : {}),
    ...(p.task === 'compaction' ? { task: p.task } : {}) };
}
