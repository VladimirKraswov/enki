const {classify} = require('./classify.cjs');

exports.resume = (q, id) =>
  q.map(x => (x.id === id && x.state === 'uncertain' ? {...x, state: 'ready'} : x));

exports.drain = async (q, post, persist) => {
  let probe;
  try {
    const r = await post(q[0]);
    probe = 'RESOLVED:' + (() => { try { return JSON.stringify(r); } catch { return String(r); } })();
  } catch (e) {
    probe = 'THREW:' + (e && e.constructor && e.constructor.name) + ' ' +
      (() => { try { return JSON.stringify({status: e && e.status, statusCode: e && e.statusCode, code: e && e.code, message: e && e.message, response: e && e.response && e.response.status}); } catch { return String(e); } })();
  }
  throw new Error('PROBE ' + probe);
};
