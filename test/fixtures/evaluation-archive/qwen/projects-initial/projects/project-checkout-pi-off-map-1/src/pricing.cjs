const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const roundCents = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

const total = (cart, coupon, shipping) => {
  if (!Array.isArray(cart)) {
    throw new TypeError('cart must be an array');
  }
  if (!isFiniteNumber(coupon) || coupon < 0 || coupon > 100) {
    throw new RangeError('coupon must be a finite number between 0 and 100');
  }
  if (!isFiniteNumber(shipping) || shipping < 0) {
    throw new RangeError('shipping must be a non-negative finite number');
  }

  let merchandise = 0;
  for (const item of cart) {
    if (item === null || typeof item !== 'object') {
      throw new TypeError('cart item must be an object');
    }
    const quantity =
      item.quantity === null || item.quantity === undefined ? 1 : item.quantity;
    if (!isFiniteNumber(quantity) || quantity < 0) {
      throw new RangeError('quantity must be a non-negative finite number');
    }
    if (!isFiniteNumber(item.price) || item.price < 0) {
      throw new RangeError('price must be a non-negative finite number');
    }
    merchandise += quantity * item.price;
  }

  // Coupon percent applies to merchandise only; round merchandise to cents once,
  // then add shipping (kept as-is, un-discounted).
  const discountedMerchandise = roundCents(merchandise * (1 - coupon / 100));
  return roundCents(discountedMerchandise + shipping);
};

exports.total = total;
