const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

const effectiveQuantity = (item) =>
  item.quantity === null || item.quantity === undefined ? 1 : item.quantity;

function validate(cart, coupon, shipping) {
  if (!Array.isArray(cart)) throw new TypeError('cart must be an array');
  if (!isFiniteNumber(coupon) || coupon < 0 || coupon > 100) {
    throw new RangeError('coupon must be a finite number between 0 and 100');
  }
  if (!isFiniteNumber(shipping) || shipping < 0) {
    throw new RangeError('shipping must be a finite non-negative number');
  }
  for (const item of cart) {
    if (item === null || typeof item !== 'object') {
      throw new TypeError('cart items must be objects');
    }
    const quantity = effectiveQuantity(item);
    if (!isFiniteNumber(quantity) || quantity < 0) {
      throw new RangeError('quantity must be a finite non-negative number');
    }
    if (!isFiniteNumber(item.price) || item.price < 0) {
      throw new RangeError('price must be a finite non-negative number');
    }
  }
}

function total(cart, coupon, shipping) {
  validate(cart, coupon, shipping);
  let merchandise = 0;
  for (const item of cart) {
    merchandise += effectiveQuantity(item) * item.price;
  }
  merchandise = Math.round(merchandise * (1 - coupon / 100) * 100) / 100;
  return merchandise + shipping;
}

exports.total = total;
exports.validate = validate;
