exports.replace = (current, expected, oldText, newText) => {
  // 1. Stale-state guard: refuse to touch anything unless current matches expected.
  if (current !== expected) {
    throw new Error('stale content: current !== expected');
  }

  // 2. Reject empty search text (an empty match is ambiguous / matches everywhere).
  if (oldText === '') {
    throw new Error('oldText must not be empty');
  }

  // 3. Count non-overlapping occurrences up front (no partial edits).
  let count = 0;
  let scan = 0;
  while ((scan = current.indexOf(oldText, scan)) !== -1) {
    count += 1;
    scan += oldText.length;
  }

  if (count === 0) {
    throw new Error('oldText not found (0 occurrences)');
  }
  if (count > 1) {
    throw new Error('oldText is ambiguous (' + count + ' occurrences)');
  }

  // 4. Unique match: splice by index so newText is treated literally
  //    (avoids String.replace's $& / $1 substitution semantics).
  const i = current.indexOf(oldText);
  return current.slice(0, i) + newText + current.slice(i + oldText.length);
};
