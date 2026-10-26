// Sum numeric `tokens` once per unique (device, id) pair.
// Different devices sharing the same id are distinct keys.
// `records` is treated as read-only (no mutation).
exports.total = (records) => {
  const seen = new Set();
  let sum = 0;
  for (const rec of records) {
    const key = String(rec.device) + "\u0000" + String(rec.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const n = typeof rec.tokens === "number" ? rec.tokens : Number(rec.tokens);
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
};
