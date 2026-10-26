// Sum numeric tokens once per (device, id).
// Different devices sharing the same id are distinct keys.
// Records are never modified.
const numericTokens = (tokens) => {
  if (typeof tokens === 'number') return Number.isFinite(tokens) ? tokens : 0;
  if (Array.isArray(tokens)) return tokens.reduce((a, t) => a + numericTokens(t), 0);
  if (typeof tokens === 'string') {
    const found = tokens.match(/-?\d+(?:\.\d+)?/g);
    return found ? found.reduce((a, s) => a + parseFloat(s), 0) : 0;
  }
  return 0;
};

exports.total = (r) => {
  const seen = new Set();
  let sum = 0;
  for (const rec of r) {
    const key = String(rec.device) + '\u0000' + String(rec.id);
    if (seen.has(key)) continue; // count each (device, id) once
    seen.add(key);
    sum += numericTokens(rec.tokens);
  }
  return sum;
};
