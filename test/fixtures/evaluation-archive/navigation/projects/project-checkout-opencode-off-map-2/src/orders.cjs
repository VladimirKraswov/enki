const pricing = require('./pricing.cjs');

function readSaved(store, id) {
  if (store && typeof store.get === 'function') return store.get(id);
  if (store && Object.prototype.hasOwnProperty.call(store, id)) return store[id];
  return undefined;
}

exports.checkout = async (store, id, cart, coupon, shipping, charge) => {
  const saved = readSaved(store, id);
  if (saved !== undefined) return saved;

  const receipt = { id, total: pricing.total(cart, coupon, shipping) };
  await charge(receipt.total);
  store.set(id, receipt);
  return receipt;
};
