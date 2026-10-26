const { matches } = require('./scope.cjs');

// Resolve generation numbers defensively from either top level or scope.
const currentGen = (s) =>
  (s.scope && s.scope.generation != null ? s.scope.generation : s.generation) ?? 0;
const eventGen = (s, e) =>
  (e.generation != null ? e.generation : e.scope && e.scope.generation) ??
  currentGen(s);

/**
 * Apply a text-delta event to state without mutating inputs.
 * Returns the ORIGINAL state object when:
 *   - the event is unrelated (server/directory/engine/session not ALL equal)
 *   - the event ID was already seen (duplicate)
 *   - the event generation is older than the current generation
 * Otherwise appends the delta once, records the ID, and retains other fields.
 */
exports.apply = (s, e) => {
  if (!s || !e) return s;
  if (!matches(s.scope, e.scope)) return s;
  if (Array.isArray(s.seen) && s.seen.includes(e.id)) return s;
  if (eventGen(s, e) < currentGen(s)) return s;
  return {
    ...s,
    text: (s.text ?? '') + e.text,
    seen: [...(s.seen ?? []), e.id],
  };
};

/**
 * Switch to a new scope: fresh generation (previous + 1), empty text/seen,
 * unrelated preferences retained. Inputs are never mutated.
 */
exports.switchTo = (s, scope) => {
  const next = { ...scope, generation: currentGen(s) + 1 };
  const { text, seen, scope: _omit, generation, ...rest } = s;
  return { ...rest, scope: next, text: '', seen: [] };
};
