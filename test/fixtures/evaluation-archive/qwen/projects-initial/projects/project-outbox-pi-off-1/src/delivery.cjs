'use strict';

const { classify } = require('./classify.cjs');

// Explicit resume: only the matching *uncertain* entry returns to ready.
// All other entries (ready, rejected, etc.) are left untouched.
function resume(q, id) {
  return q.map((x) =>
    x.id === id && x.state === 'uncertain' ? { ...x, state: 'ready' } : x
  );
}

// Drain ready entries in queue order.
// - confirmed POST success: entry is removed
// - HTTP 4xx (not 408): entry becomes 'rejected', drain continues
// - transport error / 408 / 5xx: entry becomes 'uncertain' and the drain
//   STOPS -- no automatic retry and no following entries are sent.
// Durable-first: the persisted snapshot is written before any visible
// mutation of the queue, so a failed persist leaves the original queue
// exactly as it was.
async function drain(q, post, persist) {
  const updates = []; // [item, newState]
  const removed = new Set();

  for (const item of q) {
    if (item.state !== 'ready') continue; // never touch non-ready entries
    let err = null;
    try {
      await post(item);
    } catch (e) {
      err = e;
    }
    if (!err) {
      removed.add(item);
      continue;
    }
    const outcome = classify(err);
    if (outcome === 'rejected') {
      updates.push([item, 'rejected']);
      continue;
    }
    // uncertain (transport error, 408, 5xx): mark and stop immediately
    updates.push([item, 'uncertain']);
    break;
  }

  // Build the next-state snapshot without mutating the live queue.
  const next = [];
  for (const item of q) {
    if (removed.has(item)) continue;
    const upd = updates.find(([it]) => it === item);
    next.push(upd ? { ...item, state: upd[1] } : item);
  }

  // Persistence must precede visible updates; if it throws, the original
  // queue is preserved and the error propagates (no acknowledgement).
  await persist(next);

  // Durable write succeeded: apply visible updates. Untouched entries keep
  // their original object identity and state.
  for (const [item, state] of updates) item.state = state;
  for (const item of removed) {
    const i = q.indexOf(item);
    if (i !== -1) q.splice(i, 1);
  }
  return q;
}

exports.drain = drain;
exports.resume = resume;
