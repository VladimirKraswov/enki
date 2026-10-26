const pricing = require('./pricing.cjs');

exports.checkout = async (store, id, cart, coupon, shipping, charge) => {
  const existing = store.get(id);
  if (existing !== undefined) {
    return existing;
  }

  const total = pricing.total(cart, coupon, shipping);
  const receipt = { id, total };

  await charge(total);
  store.set(id, receipt);
  return receipt;
};
