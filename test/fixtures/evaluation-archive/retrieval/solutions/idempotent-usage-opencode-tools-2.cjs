exports.total = r => {
  const seen = new Map();
  let sum = 0;
  for (const x of r) {
    let ids = seen.get(x.device);
    if (!ids) {
      ids = new Set();
      seen.set(x.device, ids);
    }
    if (ids.has(x.id)) continue;
    ids.add(x.id);
    const t = Number(x.tokens);
    if (Number.isFinite(t)) sum += t;
  }
  return sum;
};
