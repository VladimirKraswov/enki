exports.replace = (current, expected, oldText, newText) => {
  if (current !== expected) {
    throw new Error("stale: current does not match expected");
  }
  if (oldText === "") {
    throw new Error("oldText must not be empty");
  }
  const first = current.indexOf(oldText);
  if (first === -1) {
    throw new Error("oldText not found in current");
  }
  const second = current.indexOf(oldText, first + oldText.length);
  if (second !== -1) {
    throw new Error("oldText occurs more than once in current");
  }
  return current.slice(0, first) + newText + current.slice(first + oldText.length);
};
