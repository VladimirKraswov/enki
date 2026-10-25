/** Effort is a real per-chat model variant, never hidden reasoning or a global rewrite. */
export function browserTaskKey(server: string, engine: string, session: string) { return JSON.stringify([server, engine, session]); }
/**
 * The runtime publishes each model's thinking levels as variants, already
 * filtered by the SDK's `getSupportedThinkingLevels` (so xhigh/max appear
 * only where the model really supports them).
 */
export function browserEfforts(variants: Record<string, unknown> | null | undefined): string[] {
  return Object.keys(variants ?? {});
}
export function browserDefaultEffort(available: string[], preferred = "low"): string | null {
  return available.includes(preferred) ? preferred : null;
}
