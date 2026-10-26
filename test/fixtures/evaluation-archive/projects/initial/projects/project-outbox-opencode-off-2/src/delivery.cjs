const {classify} = require('./classify.cjs');

exports.resume = (q, id) =>
  q.map(x => (x.id === id && x.state === 'uncertain' ? {...x, state: 'ready'} : x));

exports.drain = async (q, post, persist) => {
  const working = q.slice();
  let i = 0;

  while (i < working.length) {
    const item = working[i];
    if (item.state !== 'ready') {
      i += 1;
      continue;
    }

    try {
      await post(item);
      working.splice(i, 1);
    } catch (e) {
      const state = classify(e);
      if (state === 'rejected') {
        working[i] = {...item, state: 'rejected'};
        i += 1;
      } else {
        working[i] = {...item, state: 'uncertain'};
        break;
      }
    }
  }

  await persist(working);

  return working;
};
