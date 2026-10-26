'use strict';

// Pricing rules for checkout:
//  - quantity null/undefined defaults to 1; 0 is a valid quantity.
//  - quantities, prices and shipping must be finite numbers >= 0.
//  - coupon is a percentage in 0..100 and applies to MERCHANDISE ONLY.
//  - merchandise total is rounded to cents exactly ONCE, then shipping is added.
//  - cart items are read-only (never mutated).

const isMoneyNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const roundToCents = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

// Strip binary-float representation noise without a second cents-rounding step
// (shipping is still added exactly as supplied).
const deNoise = (value) => {
  const cleaned = Number(value.toFixed(10));
  return Number.isFinite(cleaned) ? cleaned : value;
};

function resolveQuantity(item, index) {
  const raw = item.quantity;
  if (raw === null || raw === undefined) return 1; // ONLY null/undefined default to 1
  if (!isMoneyNumber(raw) || raw < 0) {
    throw new RangeError('invalid quantity at cart index ' + index + ': ' + String(raw));
  }
  return raw;
}

function resolvePrice(item, index) {
  const price = item.price;
  if (!isMoneyNumber(price) || price < 0) {
    throw new RangeError('invalid price at cart index ' + index + ': ' + String(price));
  }
  return price;
}

// Validation runs before any side effect (charging / persisting).
function validate(cart, coupon, shipping) {
  if (!Array.isArray(cart)) {
    throw new TypeError('cart must be an array of items');
  }
  for (let i = 0; i < cart.length; i += 1) {
    const item = cart[i];
    if (item === null || typeof item !== 'object') {
      throw new TypeError('cart item at index ' + i + ' must be an object');
    }
    resolveQuantity(item, i);
    resolvePrice(item, i);
  }
  if (!isMoneyNumber(coupon) || coupon < 0 || coupon > 100) {
    throw new RangeError('coupon must be a finite percentage between 0 and 100: ' + String(coupon));
  }
  if (!isMoneyNumber(shipping) || shipping < 0) {
    throw new RangeError('shipping must be a finite, non-negative amount: ' + String(shipping));
  }
}

function merchandiseSubtotal(cart) {
  let sum = 0;
  for (let i = 0; i < cart.length; i += 1) {
    sum += resolveQuantity(cart[i], i) * resolvePrice(cart[i], i);
  }
  return sum;
}

// total(cart, coupon, shipping) -> grand total in dollars.
function total(cart, coupon, shipping) {
  validate(cart, coupon, shipping);
  const merchandise = roundToCents(merchandiseSubtotal(cart) * (1 - coupon / 100));
  return deNoise(merchandise + shipping);
}

exports.total = total;
