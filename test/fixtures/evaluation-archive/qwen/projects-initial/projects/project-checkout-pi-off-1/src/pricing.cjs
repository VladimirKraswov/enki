'use strict';

// Money helpers and validation for the checkout domain.
// Rules:
//  - Only null/undefined quantity defaults to 1; 0 is a valid quantity.
//  - Quantities, prices and shipping must be finite and >= 0.
//  - Coupon percent must be a finite number in 0..100.
//  - Coupon applies to merchandise only; merchandise total is rounded to
//    cents exactly once, then shipping is added.
//  - Cart items are never mutated.

const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);

function roundCents(value) {
  // Guard against binary float drift (e.g. 33.33 * 3 => 99.98999999999999)
  // before performing a single half-up round to cents.
  const scaled = Number((value * 100).toPrecision(12));
  return Math.round(scaled) / 100;
}

function resolveQuantity(raw, index) {
  const quantity = raw === null || raw === undefined ? 1 : raw;
  if (!isFiniteNumber(quantity) || quantity < 0) {
    throw new RangeError(
      `Invalid quantity at cart index ${index}: ${String(raw)} (expected a finite number >= 0)`
    );
  }
  return quantity;
}

function validateCoupon(coupon) {
  if (!isFiniteNumber(coupon) || coupon < 0 || coupon > 100) {
    throw new RangeError(
      `Invalid coupon percent: ${String(coupon)} (expected a finite number between 0 and 100)`
    );
  }
  return coupon;
}

function validateShipping(shipping) {
  if (!isFiniteNumber(shipping) || shipping < 0) {
    throw new RangeError(
      `Invalid shipping: ${String(shipping)} (expected a finite number >= 0)`
    );
  }
  return shipping;
}

function validateItem(item, index) {
  if (item === null || typeof item !== 'object') {
    throw new TypeError(`Invalid cart item at index ${index}: expected an object`);
  }
  const quantity = resolveQuantity(item.quantity, index);
  if (!isFiniteNumber(item.price) || item.price < 0) {
    throw new RangeError(
      `Invalid price at cart index ${index}: ${String(item.price)} (expected a finite number >= 0)`
    );
  }
  return { quantity, price: item.price };
}

// Validates everything before any money math / side effect happens.
function validate(cart, coupon, shipping) {
  if (!Array.isArray(cart)) {
    throw new TypeError('Cart must be an array of items');
  }
  const items = cart.map(validateItem);
  validateCoupon(coupon);
  validateShipping(shipping);
  return items;
}

function merchandiseTotal(items, coupon) {
  let sum = 0;
  for (const { quantity, price } of items) {
    sum += quantity * price;
  }
  // Single rounding step, applied to discounted merchandise only.
  return roundCents(sum * (1 - coupon / 100));
}

function total(cart, coupon, shipping) {
  const items = validate(cart, coupon, shipping);
  const merchandise = merchandiseTotal(items, coupon);
  // Shipping is never discounted; keep the final amount cent-clean as well.
  return roundCents(merchandise + validateShipping(shipping));
}

function lineTotal(item) {
  const { quantity, price } = validateItem(item, 0);
  return roundCents(quantity * price);
}

exports.total = total;
exports.validate = validate;
exports.roundCents = roundCents;
exports.lineTotal = lineTotal;
