exports.total = (records) => {
  const seen = new Map();
  let sum = 0;
  for (const rec of records) {
    let ids = seen.get(rec.device);
    if (!ids) {
      ids = new Set();
      seen.set(rec.device, ids);
    }
    if (ids.has(rec.id)) continue;
    ids.add(rec.id);
    const n = Number(rec.tokens);
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
};
