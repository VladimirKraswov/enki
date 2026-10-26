'use strict';

const { matches } = require('./scope.cjs');

// Canonical counter field, tolerating the shorter legacy alias on input.
const GEN_KEYS = ['generation', 'gen'];

function genOf(obj) {
  for (const key of GEN_KEYS) {
    const value = obj && obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return { key, value };
  }
  return { key: 'generation', value: 0 };
}

function seenOf(state) {
  return Array.isArray(state.seen) ? state.seen : [];
}

/**
 * Apply an event to the state.
 * Returns the ORIGINAL state object (untouched) when the event is unrelated,
 * already seen, or from a generation older than the current one.
 * Otherwise appends the delta exactly once and records the event id,
 * preserving every other field without mutating the input.
 */
exports.apply = (state, event) => {
  if (!state || !event) return state;
  if (!matches(state.scope, event.scope)) return state;

  const current = genOf(state);
  if (genOf(event).value < current.value) return state;

  const seen = seenOf(state);
  if (seen.includes(event.id)) return state;

  return {
    ...state,
    text: String(state.text == null ? '' : state.text) +
      String(event.text == null ? '' : event.text),
    seen: seen.concat([event.id]),
  };
};

/**
 * Move to a new scope: fresh text/seen, generation = previous + 1.
 * Unrelated preferences (and the untouched scope value) carry over.
 */
exports.switchTo = (state, scope) => {
  const previous = genOf(state);
  const nextScope = scope && typeof scope === 'object' && !Array.isArray(scope)
    ? { ...scope }
    : scope;
  return {
    ...state,
    scope: nextScope,
    [previous.key]: previous.value + 1,
    text: '',
    seen: [],
  };
};
