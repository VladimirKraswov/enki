exports.replace = (current, expected, oldText, newText) => {
  if (current !== expected) throw new Error('stale: current does not match expected');
  if (oldText === '') throw new Error('empty oldText');
  const parts = current.split(oldText);
  const count = parts.length - 1;
  if (count === 0) throw new Error('no occurrence of oldText');
  if (count > 1) throw new Error('multiple occurrences of oldText');
  const idx = current.indexOf(oldText);
  return current.slice(0, idx) + newText + current.slice(idx + oldText.length);
};
