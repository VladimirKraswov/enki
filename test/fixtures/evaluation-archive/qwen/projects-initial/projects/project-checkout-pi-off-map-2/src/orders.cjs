'use strict';

const pricing = require('./pricing.cjs');

// Idempotent checkout:
//  - validation happens before charging or persisting,
//  - a duplicate order id returns the previously saved receipt without charging again,
//  - the cart is read-only (pricing never mutates items),
//  - unrelated store entries (other customers/orders) are untouched.
async function checkout(store, id, cart, coupon, shipping, charge) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new TypeError('store must expose get(id) and set(id, receipt)');
  }
  if (id === null || id === undefined || id === '') {
    throw new TypeError('order id is required');
  }
  if (typeof charge !== 'function') {
    throw new TypeError('charge must be a function');
  }

  const saved = store.get(id);
  if (saved !== undefined && saved !== null) {
    return saved; // already charged and persisted: no second charge
  }

  // Throws on invalid quantities/prices/shipping/coupon BEFORE any side effect.
  const grandTotal = pricing.total(cart, coupon, shipping);

  await charge(grandTotal);

  const receipt = { id: id, total: grandTotal };
  store.set(id, receipt);
  return receipt;
}

exports.checkout = checkout;
