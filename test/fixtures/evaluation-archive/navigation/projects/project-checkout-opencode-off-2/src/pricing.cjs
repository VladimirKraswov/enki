const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

const roundToCents = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

exports.total = (cart, coupon, shipping) => {
  if (!Array.isArray(cart)) {
    throw new Error('cart must be an array');
  }

  const discount = coupon == null ? 0 : coupon;
  if (!isFiniteNumber(discount) || discount < 0 || discount > 100) {
    throw new Error('coupon must be a number between 0 and 100');
  }

  if (!isFiniteNumber(shipping) || shipping < 0) {
    throw new Error('shipping must be a non-negative finite number');
  }

  let merchandise = 0;
  for (const item of cart) {
    if (item == null || typeof item !== 'object') {
      throw new Error('cart items must be objects');
    }

    const quantity = item.quantity == null ? 1 : item.quantity;
    if (!isFiniteNumber(quantity) || quantity < 0) {
      throw new Error('quantity must be a non-negative finite number');
    }

    if (!isFiniteNumber(item.price) || item.price < 0) {
      throw new Error('price must be a non-negative finite number');
    }

    merchandise += quantity * item.price;
  }

  const discounted = roundToCents(merchandise * (1 - discount / 100));
  return roundToCents(discounted + shipping);
};
