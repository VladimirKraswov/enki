const { classify } = require('./classify.cjs');

// Explicit resume only moves the matching uncertain entry back to ready.
exports.resume = (q, id) =>
  q.map(x => (x.id === id && x.state === 'uncertain' ? { ...x, state: 'ready' } : x));

// A POST outcome counts as failed if it threw (transport error) or if the
// resolved HTTP response reports a failure status / not-ok flag.
const outcomeFailure = (err, res) => {
  if (err) return err;
  if (res && (res.ok === false ||
      (typeof res.status === 'number' && res.status >= 400))) {
    return res;
  }
  return null;
};

exports.drain = async (q, post, persist) => {
  const removed = new Set();   // entries whose POST was confirmed successful
  const changes = new Map();   // entry -> new state ('rejected' | 'uncertain')

  // Process ready entries in order; leave non-ready entries untouched.
  for (const item of q) {
    if (item.state !== 'ready') continue;
    let failure = null;
    let res;
    try {
      res = await post(item);
    } catch (e) {
      failure = e; // transport error (or thrown HTTP failure)
    }
    failure = outcomeFailure(failure, res);
    if (!failure) {
      removed.add(item); // confirmed success: entry leaves the queue
      continue;
    }
    const next = classify(failure);
    changes.set(item, next);
    // Uncertain delivery: stop; do not retry or send following entries.
    if (next === 'uncertain') break;
    // Rejected (4xx except 408): permanent, no automatic retry; keep going.
  }

  // Persist the projected outcome before any visible update to the queue.
  const projected = q
    .filter(item => !removed.has(item))
    .map(item => (changes.has(item) ? { ...item, state: changes.get(item) } : item));
  await persist(projected);

  // Persisted successfully: now make changes visible on the live queue.
  for (const [item, state] of changes) item.state = state;
  const kept = q.filter(item => !removed.has(item));
  q.length = 0;
  q.push(...kept);
  return q;
};
