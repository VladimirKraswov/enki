const pricing = require('./pricing.cjs');

async function checkout(store, id, cart, coupon, shipping, charge) {
  // Validate and price BEFORE any side effects (throws before charging).
  const total = pricing.total(cart, coupon, shipping);

  // Idempotent: duplicate order IDs return the saved receipt without charging twice.
  const existing =
    typeof store.has === 'function' ? store.has(id) : store.get(id) !== undefined;
  if (existing) return store.get(id);

  // Never mutate cart items; build a fresh receipt.
  const receipt = { id, total };
  await charge(total);
  store.set(id, receipt);
  return receipt;
}

exports.checkout = checkout;
