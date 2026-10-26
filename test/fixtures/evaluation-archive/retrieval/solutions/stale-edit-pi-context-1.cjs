exports.replace = (current, expected, oldText, newText) => {
  if (current !== expected) {
    throw new Error('Stale edit: current does not match expected revision');
  }
  if (oldText === '') {
    throw new Error('Empty oldText is not allowed');
  }

  // Count occurrences without any partial edit.
  const first = current.indexOf(oldText);
  if (first === -1) {
    throw new Error('oldText not found (zero occurrences)');
  }
  if (current.indexOf(oldText, first + 1) !== -1) {
    throw new Error('oldText is not unique (multiple occurrences)');
  }

  // Literal replacement: never interpret $& / $1 / $$ patterns.
  return current.slice(0, first) + newText + current.slice(first + oldText.length);
};
