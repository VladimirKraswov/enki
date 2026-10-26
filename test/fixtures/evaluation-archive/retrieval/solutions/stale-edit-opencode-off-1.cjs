exports.replace = (current, expected, oldText, newText) => {
  if (current !== expected) {
    throw new Error("stale: current does not match expected");
  }
  if (oldText === "") {
    throw new Error("oldText must not be empty");
  }
  let count = 0;
  let idx = -1;
  let from = 0;
  while (true) {
    const found = current.indexOf(oldText, from);
    if (found === -1) break;
    count++;
    idx = found;
    if (count > 1) break;
    from = found + oldText.length;
  }
  if (count === 0) {
    throw new Error("oldText not found");
  }
  if (count > 1) {
    throw new Error("oldText appears multiple times");
  }
  return current.slice(0, idx) + newText + current.slice(idx + oldText.length);
};
