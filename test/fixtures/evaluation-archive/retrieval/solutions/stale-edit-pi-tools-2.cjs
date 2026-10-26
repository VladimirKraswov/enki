'use strict';

// Replace the unique occurrence of `oldText` in `current` with `newText`.
//
// All guardrails are checked up front, before any text is produced, so a
// rejected call can never apply a partial edit:
//   - stale snapshot : current !== expected
//   - empty needle   : oldText is "" (or not a string)
//   - zero matches   : oldText does not occur in current
//   - ambiguous      : oldText occurs more than once
//
// The substitution is literal: `newText` is spliced in verbatim, so "$&",
// "$1", "$$" and friends are never treated as replacement patterns.
exports.replace = function replace(current, expected, oldText, newText) {
  if (current !== expected) {
    throw new Error(
      'replace: stale revision - current text does not match expected snapshot'
    );
  }

  if (typeof oldText !== 'string' || oldText.length === 0) {
    throw new Error('replace: oldText must be a non-empty string');
  }

  const first = current.indexOf(oldText);
  if (first === -1) {
    throw new Error('replace: oldText not found (zero occurrences)');
  }

  // Start one past the first character so that self-overlapping matches are
  // also counted: any second position means the match is not unique.
  if (current.indexOf(oldText, first + 1) !== -1) {
    throw new Error('replace: oldText is not unique (multiple occurrences)');
  }

  // Literal splice - no regex or replacement-string semantics.
  return (
    current.slice(0, first) + newText + current.slice(first + oldText.length)
  );
};
