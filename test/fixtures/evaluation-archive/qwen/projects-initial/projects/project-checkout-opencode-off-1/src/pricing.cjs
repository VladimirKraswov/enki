function requireNumber(value, message) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(message);
}

exports.total = (cart, coupon, shipping) => {
  if (!Array.isArray(cart)) throw new Error("cart must be an array");
  requireNumber(coupon, "coupon must be a finite number");
  if (coupon < 0 || coupon > 100) throw new Error("coupon must be between 0 and 100");
  requireNumber(shipping, "shipping must be a finite number");
  if (shipping < 0) throw new Error("shipping must not be negative");

  let merchandise = 0;
  for (const item of cart) {
    const quantity = item.quantity == null ? 1 : item.quantity;
    requireNumber(quantity, "quantity must be a finite number");
    if (quantity < 0) throw new Error("quantity must not be negative");
    requireNumber(item.price, "price must be a finite number");
    if (item.price < 0) throw new Error("price must not be negative");
    merchandise += quantity * item.price;
  }

  const discounted = Math.round(merchandise * (1 - coupon / 100) * 100) / 100;
  return discounted + shipping;
};
