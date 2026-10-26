exports.replace = (current, expected, oldText, newText) => {
  if (current !== expected) {
    throw new Error("stale: current does not match expected");
  }
  if (oldText === "") {
    throw new Error("empty oldText");
  }
  const first = current.indexOf(oldText);
  if (first === -1) {
    throw new Error("oldText not found (zero occurrences)");
  }
  if (current.indexOf(oldText, first + 1) !== -1) {
    throw new Error("multiple occurrences of oldText");
  }
  // literal replacement: no $& / dollar-pattern interpretation
  return current.slice(0, first) + newText + current.slice(first + oldText.length);
};
