exports.replace = (current, expected, oldText, newText) => {
  if (current !== expected) {
    throw new Error("stale current revision");
  }
  if (oldText === undefined || oldText === null || oldText === "") {
    throw new Error("empty oldText");
  }
  const parts = current.split(oldText);
  if (parts.length !== 2) {
    throw new Error(parts.length < 2 ? "no occurrence of oldText" : "multiple occurrences of oldText");
  }
  return parts[0] + newText + parts[1];
};
