"use strict";

// total(records): sum numeric tokens once per (device, id).
//
// Rules implemented:
//  - The dedup key is the STRUCTURED pair (device, id). Different devices with
//    the same id are distinct, and no delimiter/prefix concatenation is used,
//    so keys such as ("a:b", "c") and ("a", "b:c") cannot collide. A Map of
//    device -> Set(id) gives exact, type-aware grouping.
//  - Each (device, id) pair contributes at most once (its first occurrence).
//  - Only numeric token values are summed; non-numeric tokens are skipped.
//  - The caller's records array/objects are never mutated.
exports.total = function total(records) {
  function numericValue(t) {
    if (typeof t === "number") return Number.isFinite(t) ? t : 0;
    if (typeof t === "string") {
      let s = 0;
      for (const part of t.split(/\s+/)) {
        if (part === "") continue;
        const n = Number(part);
        if (Number.isFinite(n)) s += n;
      }
      return s;
    }
    return 0;
  }

  const byDevice = new Map();
  let sum = 0;

  if (records) {
    for (const rec of records) {
      if (rec == null) continue;

      const device = rec.device;
      const id = rec.id;

      let ids = byDevice.get(device);
      if (ids === undefined) {
        ids = new Set();
        byDevice.set(device, ids);
      }
      if (ids.has(id)) continue; // already counted this (device, id)
      ids.add(id);

      sum += numericValue(rec.tokens);
    }
  }

  return sum;
};
