const pricing = require('./pricing.cjs');

const checkout = async (store, id, cart, coupon, shipping, charge) => {
  // Idempotent: a duplicate order ID returns the saved receipt without charging again.
  if (store.has(id)) {
    return store.get(id);
  }

  // Validate + compute BEFORE any side effect; invalid input throws here,
  // before charge() is ever called. Cart items are only read, never mutated.
  const total = pricing.total(cart, coupon, shipping);

  const receipt = { id, total };
  await charge(total);
  store.set(id, receipt);
  return receipt;
};

exports.checkout = checkout;
