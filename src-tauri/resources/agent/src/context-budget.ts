// One policy for SDK auto-compaction and its UI explanation. This reserves
// room for the advertised answer without changing the model's actual window.
export function compactionBudget(model: { contextWindow: number; maxTokens: number }, settings: { reserveTokens?: number; keepRecentTokens?: number; triggerRatio?: number } = {}) {
  const window = Math.max(2, Math.floor(model.contextWindow));
  const output = Math.max(1, Math.min(model.maxTokens > 0 ? model.maxTokens : Math.floor(window / 4), Math.floor(window / 2)));
  // Pi 0.85.1 buildBaseOptions reserves 4096 tokens when clamping output.
  // Match that margin here so auto-compaction precedes answer truncation.
  const margin = 4096;
  const requested = Number.isFinite(settings.reserveTokens) && settings.reserveTokens! >= 0 ? settings.reserveTokens! : 0;
  // Small local models lose the thread long before the window is full: compact
  // at a fraction of the window instead of at the last possible moment.
  const ratio = Number.isFinite(settings.triggerRatio) && settings.triggerRatio! > 0 && settings.triggerRatio! < 1 ? settings.triggerRatio! : 0;
  const byRatio = ratio > 0 ? window - Math.floor(window * ratio) : 0;
  const reserveTokens = Math.min(window - 1, Math.max(output + margin, requested, byRatio));
  const recent = Number.isFinite(settings.keepRecentTokens) && settings.keepRecentTokens! >= 0 ? Math.floor(settings.keepRecentTokens!) : 20_000;
  const keepRecentTokens = Math.min(recent, Math.max(1, Math.floor((window - reserveTokens) / 3)));
  return { reserveTokens, keepRecentTokens, triggerTokens: window - reserveTokens };
}

/** Local providers are configured by the owner with the `local-` prefix. Their
 * smaller models degrade on a nearly full window, so compact earlier. */
export const LOCAL_COMPACTION_TRIGGER_RATIO = 0.68;
export function isLocalProvider(provider: string | undefined): boolean {
  return !!provider && provider.startsWith("local-");
}
