/** Diagnostic seconds text ("12,4 с" style is deliberately plain ASCII). Missing values keep the caller's placeholder. */
export function secondsText(ms: number): string {
  return `${(ms / 1000).toFixed(1)} с`;
}
