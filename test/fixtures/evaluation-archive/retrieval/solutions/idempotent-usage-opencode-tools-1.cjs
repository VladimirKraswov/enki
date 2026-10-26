exports.total = (records) => {
  const seen = new Set();
  let sum = 0;
  for (const r of records) {
    const key = JSON.stringify([r.device, r.id]);
    if (seen.has(key)) continue;
    seen.add(key);
    const t = r.tokens;
    if (typeof t === 'number' && Number.isFinite(t)) {
      sum += t;
    } else if (typeof t === 'string' && t.trim() !== '' && Number.isFinite(Number(t))) {
      sum += Number(t);
    }
  }
  return sum;
};
