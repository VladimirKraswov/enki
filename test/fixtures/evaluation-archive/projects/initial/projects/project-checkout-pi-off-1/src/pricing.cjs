'use strict';

// Numbers must be real, finite, and (where applicable) non-negative.
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

// Round a money amount to whole cents exactly once.
const roundCents = (amount) => Math.round(amount * 100) / 100;

// Only null/undefined default to 1; 0 (and any other valid number) is preserved.
const resolveQuantity = (quantity) => (quantity === null || quantity === undefined ? 1 : quantity);

// Validate and return a non-negative finite line quantity.
const validateQuantity = (quantity) => {
  if (!isFiniteNumber(quantity) || quantity < 0) {
    throw new RangeError(`invalid quantity: ${quantity}`);
  }
  return quantity;
};

// Validate and return a non-negative finite line price.
const validatePrice = (price) => {
  if (!isFiniteNumber(price) || price < 0) {
    throw new RangeError(`invalid price: ${price}`);
  }
  return price;
};

// Validate shipping: a non-negative finite amount.
const validateShipping = (shipping) => {
  if (!isFiniteNumber(shipping) || shipping < 0) {
    throw new RangeError(`invalid shipping: ${shipping}`);
  }
  return shipping;
};

// Validate coupon: a finite percentage within the inclusive 0..100 range.
const validateCoupon = (coupon) => {
  if (!isFiniteNumber(coupon) || coupon < 0 || coupon > 100) {
    throw new RangeError(`invalid coupon: ${coupon}`);
  }
  return coupon;
};

exports.total = (cart, coupon, shipping) => {
  if (!Array.isArray(cart)) {
    throw new TypeError('cart must be an array');
  }

  // Validate up front so an invalid input throws before any charging occurs.
  const discountRate = validateCoupon(coupon);
  const shippingCost = validateShipping(shipping);

  // Sum merchandise only. Reads cart items but never mutates them.
  let merchandise = 0;
  for (const item of cart) {
    const quantity = validateQuantity(resolveQuantity(item.quantity));
    const price = validatePrice(item.price);
    merchandise += quantity * price;
  }

  // Coupon applies to merchandise only; round the discounted merchandise once to
  // cents, then add shipping (shipping is never discounted).
  const discountedMerchandise = merchandise * (1 - discountRate / 100);
  return roundCents(discountedMerchandise) + shippingCost;
};
