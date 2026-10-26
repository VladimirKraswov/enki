exports.total = r => {
  const seen = new Set();
  let sum = 0;
  for (const x of r) {
    const key = String(x.device) + "\u0000" + String(x.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const t = typeof x.tokens === "number" ? x.tokens : Number(x.tokens);
    if (Number.isFinite(t)) sum += t;
  }
  return sum;
};
