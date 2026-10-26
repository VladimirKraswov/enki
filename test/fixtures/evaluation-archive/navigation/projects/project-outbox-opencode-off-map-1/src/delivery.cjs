const { classify } = require('./classify.cjs');

exports.resume = (q, id) =>
  q.map(x => (x.id === id && x.state === 'uncertain' ? { ...x, state: 'ready' } : x));

exports.drain = async (q, post, persist) => {
  const removed = new Set();
  const updated = new Map();
  let stop = false;

  for (const item of q) {
    if (stop) break;
    if (item.state !== 'ready') continue;
    try {
      await post(item);
      removed.add(item);
    } catch (e) {
      const state = classify(e);
      updated.set(item, state);
      if (state === 'rejected') continue;
      stop = true;
    }
  }

  const snapshot = [];
  for (const item of q) {
    if (removed.has(item)) continue;
    snapshot.push(updated.has(item) ? { ...item, state: updated.get(item) } : item);
  }

  await persist(snapshot);

  for (let i = q.length - 1; i >= 0; i--) {
    const item = q[i];
    if (removed.has(item)) q.splice(i, 1);
    else if (updated.has(item)) item.state = updated.get(item);
  }

  return q;
};
