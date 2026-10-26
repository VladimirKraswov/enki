const { matches } = require('./scope.cjs');

// Resolve the current generation from either the state itself or its scope.
const generationOf = (state) => {
  if (!state || typeof state !== 'object') return 0;
  if (typeof state.generation === 'number') return state.generation;
  if (state.scope && typeof state.scope.generation === 'number') return state.scope.generation;
  return 0;
};

// Events may carry their generation directly or inside their scope.
// An event without generation information is treated as current (not stale).
const eventGeneration = (state, event) => {
  if (event && typeof event.generation === 'number') return event.generation;
  if (event && event.scope && typeof event.scope.generation === 'number') {
    return event.scope.generation;
  }
  return generationOf(state);
};

exports.apply = (state, event) => {
  if (!state || typeof state !== 'object' || !event || typeof event !== 'object') {
    return state;
  }

  // Routing: server + directory + engine + session must all match exactly.
  if (!matches(state.scope, event.scope)) return state;

  // Duplicate event IDs are ignored.
  const seen = Array.isArray(state.seen) ? state.seen : [];
  if (seen.includes(event.id)) return state;

  // Events from an older generation are ignored.
  if (eventGeneration(state, event) < generationOf(state)) return state;

  // Append the delta exactly once, copying (never mutating) nested state.
  const text = (typeof state.text === 'string' ? state.text : '') +
    (typeof event.text === 'string' ? event.text : '');

  return { ...state, text, seen: [...seen, event.id] };
};

exports.switchTo = (state, scope) => {
  const base = state && typeof state === 'object' ? state : {};
  const next = generationOf(base) + 1;

  const out = { ...base, scope, generation: next, text: '', seen: [] };

  // If scopes carry their own generation, refresh it on a copy of the scope.
  if (scope && typeof scope === 'object' && 'generation' in scope) {
    out.scope = { ...scope, generation: next };
  }

  return out;
};
