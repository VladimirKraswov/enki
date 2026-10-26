exports.total = (records) => {
  if (!Array.isArray(records)) return 0;
  const seenByDevice = new Map();
  let total = 0;
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const { device, id, tokens } = record;
    let seenIds = seenByDevice.get(device);
    if (!seenIds) {
      seenIds = new Set();
      seenByDevice.set(device, seenIds);
    }
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    if (typeof tokens === "number" && Number.isFinite(tokens)) {
      total += tokens;
    }
  }
  return total;
};
