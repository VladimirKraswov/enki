const pricing = require('./pricing.cjs');

exports.checkout = async (store, id, cart, coupon, shipping, charge) => {
  const existing = store.get(id);
  if (existing !== undefined) {
    return existing;
  }

  const receipt = { id, total: pricing.total(cart, coupon, shipping) };

  await charge(receipt.total);
  store.set(id, receipt);
  return receipt;
};
