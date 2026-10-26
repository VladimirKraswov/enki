'use strict';

const pricing = require('./pricing.cjs');

// Public checkout entry point. Preserves the existing exported API.
exports.checkout = async (store, id, cart, coupon, shipping, charge) => {
  // Duplicate order IDs return the saved receipt without charging again.
  const existing = store.get(id);
  if (existing !== undefined) {
    return existing;
  }

  // Compute the total first: pricing validates all inputs and throws for invalid
  // quantities/prices/shipping/coupons, so we fail BEFORE any charge side effect.
  const total = pricing.total(cart, coupon, shipping);
  const receipt = { id, total };

  await charge(total);

  // Persist only this order; unrelated customers already in the store are kept.
  store.set(id, receipt);
  return receipt;
};
