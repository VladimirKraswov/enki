// total(records): sum numeric tokens once per (device, id).
// - Key is a structured pair (device, id): nested Map/Set avoids delimiter
//   collisions that a concatenated string key (e.g. device + ":" + id) could cause.
// - Different devices sharing the same id are distinct keys.
// - Caller records are never mutated.
exports.total = (records) => {
  const seen = new Map(); // device -> Set(id)
  let sum = 0;
  for (const rec of records || []) {
    if (rec == null) continue;
    let ids = seen.get(rec.device);
    if (!ids) {
      ids = new Set();
      seen.set(rec.device, ids);
    }
    if (ids.has(rec.id)) continue; // already counted this (device, id)
    ids.add(rec.id);

    const raw = rec.tokens;
    const n =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : NaN;
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
};
