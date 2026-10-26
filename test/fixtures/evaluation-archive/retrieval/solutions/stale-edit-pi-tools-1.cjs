exports.replace = (current, expected, oldText, newText) => {
  if (current !== expected) {
    throw new Error("stale: current does not match expected");
  }
  if (typeof oldText !== "string" || oldText.length === 0) {
    throw new Error("oldText must be a non-empty string");
  }
  const first = current.indexOf(oldText);
  if (first === -1) {
    throw new Error("oldText not found: zero occurrences");
  }
  if (current.indexOf(oldText, first + 1) !== -1) {
    throw new Error("oldText not unique: multiple occurrences");
  }
  // Literal replacement: avoid String.replace so $&, $1 etc. stay literal.
  return current.slice(0, first) + newText + current.slice(first + oldText.length);
};
