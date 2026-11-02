/** Additive native diagnostics: no bearer, prompts, paths or process control. */
export interface RuntimeStartup {
  run: number;
  phase: 'preparing' | 'manifest' | 'inventory' | 'hashing' | 'starting_node' | 'waiting_ready' | 'ready' | 'failed' | 'cancelled';
  startedAt: number;
  elapsedMs: number;
  phaseElapsedMs: number;
  completed: number;
  total: number | null;
  error: string | null;
  failureCode?: string;
  stages: Array<{phase: string; elapsedMs: number}>;
  nativeVersion?: string;
  bundled?: string;
  artifactDigest?: string;
}
export function parseStartup(value: unknown): RuntimeStartup | undefined {
  if (!value || typeof value !== 'object') return;
  const p = value as RuntimeStartup;
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!count(p.run) || !count(p.startedAt) || !count(p.elapsedMs) || !count(p.phaseElapsedMs) || !count(p.completed)
    || !['preparing','manifest','inventory','hashing','starting_node','waiting_ready','ready','failed','cancelled'].includes(p.phase)
    || p.total !== null && !count(p.total) || p.total !== null && p.completed > p.total) return;
  return { run:p.run, phase:p.phase, startedAt:p.startedAt, elapsedMs:p.elapsedMs, phaseElapsedMs:p.phaseElapsedMs,
    completed:p.completed, total:p.total, error:typeof p.error === 'string' ? p.error.slice(0,600) : null,
    stages:Array.isArray(p.stages) ? p.stages.filter(s=>s && typeof s.phase === 'string' && s.phase.length < 40 && count(s.elapsedMs)).slice(0,20).map(s=>({phase:s.phase,elapsedMs:s.elapsedMs})) : [],
    ...(['cancelled','verification_timeout','artifact_hash_mismatch','artifact_io','artifact_integrity','node_start','node_readiness','runtime_setup'].includes(p.failureCode ?? '') ? {failureCode:p.failureCode} : {}),
    ...(typeof p.nativeVersion === 'string' && p.nativeVersion.length < 40 ? {nativeVersion:p.nativeVersion} : {}),
    ...(typeof p.bundled === 'string' && p.bundled.length < 128 ? {bundled:p.bundled} : {}),
    ...(typeof p.artifactDigest === 'string' && /^[a-f0-9]{64}$/.test(p.artifactDigest) ? {artifactDigest:p.artifactDigest} : {}) };
}
