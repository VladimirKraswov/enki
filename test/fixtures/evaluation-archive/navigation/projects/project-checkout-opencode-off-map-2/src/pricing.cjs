function requireFiniteNonNegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Invalid ' + name + ': ' + value);
  }
  return value;
}

exports.total = (cart, coupon, shipping) => {
  if (
    typeof coupon !== 'number' ||
    !Number.isFinite(coupon) ||
    coupon < 0 ||
    coupon > 100
  ) {
    throw new Error('Invalid coupon: ' + coupon);
  }

  const ship = requireFiniteNonNegative(shipping, 'shipping');

  let merchandise = 0;
  for (const item of cart) {
    let quantity = item.quantity;
    if (quantity === null || quantity === undefined) quantity = 1;
    const q = requireFiniteNonNegative(quantity, 'quantity');
    const price = requireFiniteNonNegative(item.price, 'price');
    merchandise += q * price;
  }

  const discounted = merchandise * (1 - coupon / 100);
  const roundedMerchandise = Math.round(discounted * 100) / 100;

  return roundedMerchandise + ship;
};
