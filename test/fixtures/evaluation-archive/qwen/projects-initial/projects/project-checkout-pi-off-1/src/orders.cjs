'use strict';

const pricing = require('./pricing.cjs');

function findReceipt(store, id) {
  if (store === null || store === undefined) return undefined;
  if (typeof store.get === 'function') {
    if (typeof store.has === 'function' && !store.has(id)) return undefined;
    const stored = store.get(id);
    return stored === undefined ? undefined : stored;
  }
  if (typeof store.has === 'function') {
    return store.has(id) ? store[id] : undefined;
  }
  if (typeof store === 'object' && Object.prototype.hasOwnProperty.call(store, id)) {
    return store[id];
  }
  return undefined;
}

function saveReceipt(store, id, receipt) {
  if (store === null || store === undefined) {
    throw new TypeError('Order store is required');
  }
  if (typeof store.set === 'function') {
    store.set(id, receipt);
    return;
  }
  if (typeof store === 'object') {
    store[id] = receipt;
    return;
  }
  throw new TypeError('Unsupported order store');
}

/**
 * Idempotent checkout.
 *  1. Validate the whole request (pricing.total throws before any side effect).
 *  2. Replay an already-saved receipt for a duplicate order id (no 2nd charge).
 *  3. Charge once, then persist; unrelated orders/customers stay untouched.
 *  4. The incoming cart is only read, never mutated.
 */
exports.checkout = async (store, id, cart, coupon, shipping, charge) => {
  // Validate + price first: invalid input never reaches the payment gateway.
  const total = pricing.total(cart, coupon, shipping);

  const saved = findReceipt(store, id);
  if (saved !== undefined) {
    return saved; // duplicate order id -> saved receipt, no re-charge
  }

  if (typeof charge !== 'function') {
    throw new TypeError('charge must be a function');
  }

  const receipt = { id, total };
  await charge(total);
  saveReceipt(store, id, receipt);
  return receipt;
};

exports.total = pricing.total;
