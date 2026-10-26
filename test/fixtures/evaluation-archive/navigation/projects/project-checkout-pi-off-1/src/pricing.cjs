const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

exports.total = (cart, coupon, shipping) => {
  if (!isFiniteNumber(shipping) || shipping < 0) {
    throw new RangeError('Invalid shipping');
  }
  if (!isFiniteNumber(coupon) || coupon < 0 || coupon > 100) {
    throw new RangeError('Invalid coupon');
  }

  const merchandise = cart.reduce((sum, item) => {
    const quantity = item.quantity == null ? 1 : item.quantity;
    const price = item.price;
    if (!isFiniteNumber(quantity) || quantity < 0) {
      throw new RangeError('Invalid quantity');
    }
    if (!isFiniteNumber(price) || price < 0) {
      throw new RangeError('Invalid price');
    }
    return sum + quantity * price;
  }, 0);

  const discounted = merchandise * (1 - coupon / 100);
  const rounded = Math.round(discounted * 100) / 100;
  return rounded + shipping;
};
