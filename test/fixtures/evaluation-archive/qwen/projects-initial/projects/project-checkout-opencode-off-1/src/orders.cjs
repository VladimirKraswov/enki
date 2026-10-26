const pricing = require('./pricing.cjs');

exports.checkout = async (store, id, cart, coupon, shipping, charge) => {
  const exists = typeof store.has === 'function' ? store.has(id) : store.get(id) !== undefined;
  if (exists) return store.get(id);
  const receipt = { id, total: pricing.total(cart, coupon, shipping) };
  await charge(receipt.total);
  store.set(id, receipt);
  return receipt;
};
