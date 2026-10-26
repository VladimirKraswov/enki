const pricing = require('./pricing.cjs');

const savedReceipt = (store, id) => {
  if (typeof store.get === 'function') {
    return store.get(id);
  }
  return undefined;
};

exports.checkout = async (store, id, cart, coupon, shipping, charge) => {
  const existing = savedReceipt(store, id);
  if (existing !== undefined && existing !== null) {
    return existing;
  }

  const total = pricing.total(cart, coupon, shipping);
  const receipt = { id, total };
  await charge(total);
  store.set(id, receipt);
  return receipt;
};
