exports.replace = (current, expected, oldText, newText) => {
  if (current !== expected) throw new Error("stale current");
  if (oldText == null || oldText === "") throw new Error("empty oldText");
  const first = current.indexOf(oldText);
  if (first === -1) throw new Error("no match");
  if (current.indexOf(oldText, first + 1) !== -1) throw new Error("multiple matches");
  return current.slice(0, first) + newText + current.slice(first + oldText.length);
};
