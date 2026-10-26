exports.total = r => {
  const seen = new Map();
  let sum = 0;
  for (const x of r) {
    let ids = seen.get(x.device);
    if (ids === undefined) seen.set(x.device, ids = new Set());
    if (ids.has(x.id)) continue;
    ids.add(x.id);
    sum += Number(x.tokens);
  }
  return sum;
};
