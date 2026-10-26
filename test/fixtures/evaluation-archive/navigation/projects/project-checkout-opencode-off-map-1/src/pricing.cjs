function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

exports.total = (cart, coupon, shipping) => {
  if (!Array.isArray(cart)) {
    throw new Error('cart must be an array');
  }
  if (!finiteNumber(coupon) || coupon < 0 || coupon > 100) {
    throw new Error('coupon must be a finite number between 0 and 100');
  }
  if (!finiteNumber(shipping) || shipping < 0) {
    throw new Error('shipping must be a finite non-negative number');
  }

  let merchandise = 0;
  for (const item of cart) {
    if (item === null || typeof item !== 'object') {
      throw new Error('cart item must be an object');
    }
    const quantity = item.quantity === null || item.quantity === undefined ? 1 : item.quantity;
    const { price } = item;
    if (!finiteNumber(quantity) || quantity < 0) {
      throw new Error('quantity must be a finite non-negative number');
    }
    if (!finiteNumber(price) || price < 0) {
      throw new Error('price must be a finite non-negative number');
    }
    merchandise += quantity * price;
  }

  const discounted = merchandise * (1 - coupon / 100);
  const rounded = Math.round(discounted * 100) / 100;
  return rounded + shipping;
};
