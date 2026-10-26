// Sum numeric tokens once per (device, id) pair.
// - Key is a structured pair; nested Maps avoid delimiter-collision bugs.
// - Different devices with the same id are distinct.
// - Input records are never mutated.
exports.total = (r) => {
  if (!Array.isArray(r)) return 0;

  const seen = new Map(); // device -> Set(id)
  let sum = 0;

  for (const x of r) {
    if (x == null) continue;

    const device = x.device;
    const id = x.id;

    let ids = seen.get(device);
    if (ids === undefined) {
      ids = new Set();
      seen.set(device, ids);
    }
    if (ids.has(id)) continue; // already counted this (device, id)
    ids.add(id);

    const t = typeof x.tokens === 'number' ? x.tokens : NaN;
    if (Number.isFinite(t)) sum += t;
  }

  return sum;
};
