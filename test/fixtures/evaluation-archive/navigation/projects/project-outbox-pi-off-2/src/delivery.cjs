const {classify} = require('./classify.cjs');

// Explicitly resume a single uncertain entry back to 'ready'.
// Only an uncertain entry is affected; every other entry is left untouched.
exports.resume = (q, id) =>
  q.map(x => (x.id === id && x.state === 'uncertain' ? {...x, state: 'ready'} : x));

// Drain ready entries in order.
//  - a resolved POST removes that entry
//  - a permanent rejection marks the entry 'rejected' and processing continues
//  - an uncertain delivery marks the entry 'uncertain' and stops processing
//    immediately (no retry, no further entries sent)
// The caller's queue is only updated after persistence succeeds, so a failed
// persist leaves the original queue intact.
exports.drain = async (q, post, persist) => {
  const candidate = [];
  let stopped = false;

  for (const item of q) {
    if (stopped || item.state !== 'ready') {
      candidate.push(item);
      continue;
    }
    try {
      await post(item);
      // Confirmed success: drop the entry (do not re-add it).
    } catch (e) {
      if (classify(e) === 'rejected') {
        candidate.push({...item, state: 'rejected'});
      } else {
        candidate.push({...item, state: 'uncertain'});
        stopped = true;
      }
    }
  }

  // Persist the intended result before making any visible change.
  await persist(candidate);

  // Persistence succeeded -> commit the visible update in place.
  q.length = 0;
  for (const item of candidate) q.push(item);
  return q;
};
