// One policy for SDK auto-compaction and its UI explanation. This reserves
// room for the advertised answer without changing the model's actual window.
export function compactionBudget(model: { contextWindow: number; maxTokens: number }, settings: { reserveTokens?: number; keepRecentTokens?: number } = {}) {
  const window = Math.max(2, Math.floor(model.contextWindow));
  const output = Math.max(1, Math.min(model.maxTokens > 0 ? model.maxTokens : Math.floor(window / 4), Math.floor(window / 2)));
  // Pi 0.85.1 buildBaseOptions reserves 4096 tokens when clamping output.
  // Match that margin here so auto-compaction precedes answer truncation.
  const margin = 4096;
  const requested = Number.isFinite(settings.reserveTokens) && settings.reserveTokens! >= 0 ? settings.reserveTokens! : 0;
  const reserveTokens = Math.min(window - 1, Math.max(output + margin, requested));
  const recent = Number.isFinite(settings.keepRecentTokens) && settings.keepRecentTokens! >= 0 ? Math.floor(settings.keepRecentTokens!) : 20_000;
  const keepRecentTokens = Math.min(recent, Math.max(1, Math.floor((window - reserveTokens) / 3)));
  return { reserveTokens, keepRecentTokens, triggerTokens: window - reserveTokens };
}
