const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const roundCents = (value) => Math.round(value * 100) / 100;

exports.total = (cart, coupon, shipping) => {
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
    const quantity = item.quantity === null || item.quantity === undefined ? 1 : item.quantity;
    if (!isFiniteNumber(quantity) || quantity < 0) {
      throw new RangeError('quantity must be a non-negative finite number');
    }
    if (!isFiniteNumber(item.price) || item.price < 0) {
      throw new RangeError('price must be a non-negative finite number');
    }
    merchandise += quantity * item.price;
  }

  const discountedMerchandise = roundCents(merchandise * (1 - coupon / 100));
  return discountedMerchandise + shipping;
};
