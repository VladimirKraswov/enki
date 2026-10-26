exports.replace = (current, expected, oldText, newText) => {
  if (current !== expected) {
    throw new Error("stale: current does not match expected");
  }
  if (oldText === "") {
    throw new Error("oldText must not be empty");
  }
  const occurrences = current.split(oldText).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      "oldText must occur exactly once, found " + occurrences
    );
  }
  return current.replace(oldText, () => newText);
};
