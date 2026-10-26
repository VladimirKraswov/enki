const {matches} = require('./scope.cjs');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Generation may live on the state/event itself or inside its scope.
const generationOf = (x) => {
  if (!x || typeof x !== 'object') return null;
  const own = num(x.generation);
  if (own !== null) return own;
  return x.scope && typeof x.scope === 'object' ? num(x.scope.generation) : null;
};

const seenList = (state) => {
  if (state.seen instanceof Set) return [...state.seen];
  if (Array.isArray(state.seen)) return state.seen.slice();
  return [];
};

const alreadySeen = (state, id) => {
  if (state.seen instanceof Set) return state.seen.has(id);
  if (Array.isArray(state.seen)) return state.seen.includes(id);
  return false;
};

/**
 * Apply an event's text delta.
 * Returns the ORIGINAL state object (untouched) when:
 *   - the event scope does not match the state scope on every routing field
 *   - the event id has already been recorded
 *   - the event generation is older than the state's current generation
 * Otherwise returns a new state with the delta appended once and the id
 * recorded; every other field (preferences, scope, generation, ...) is kept.
 */
exports.apply = (state, event) => {
  if (!state || typeof state !== 'object' || !event || typeof event !== 'object') return state;
  if (!matches(state.scope, event.scope)) return state;
  if (alreadySeen(state, event.id)) return state;

  const current = generationOf(state);
  const incoming = generationOf(event);
  if (current !== null && incoming !== null && incoming < current) return state;

  const delta = event.text !== undefined ? event.text : event.delta;
  const text = String(state.text === undefined || state.text === null ? '' : state.text) +
    String(delta === undefined || delta === null ? '' : delta);

  return {...state, text, seen: [...seenList(state), event.id]};
};

/**
 * Move to a new scope: bump generation to previous+1, clear text and seen ids,
 * and retain unrelated state (preferences and any other fields).
 */
exports.switchTo = (state, scope) => {
  const prev = generationOf(state);
  return {
    ...state,
    scope,
    generation: (prev === null ? 0 : prev) + 1,
    text: '',
    seen: [],
  };
};
