exports.replace = (current, expected, oldText, newText) => {
  if (current !== expected) {
    throw new Error("stale current text");
  }
  if (oldText === "") {
    throw new Error("oldText must not be empty");
  }
  const count = current.split(oldText).length - 1;
  if (count === 0) {
    throw new Error("oldText not found");
  }
  if (count > 1) {
    throw new Error("oldText is not unique");
  }
  return current.replace(oldText, () => newText);
};
