const isFiniteNumber=x=>typeof x==='number'&&Number.isFinite(x);

exports.total=(cart,coupon,shipping)=>{
  if(!Array.isArray(cart))throw new TypeError('cart must be an array');
  if(!isFiniteNumber(coupon)||coupon<0||coupon>100)throw new RangeError('coupon must be a number in 0..100');
  if(!isFiniteNumber(shipping)||shipping<0)throw new RangeError('shipping must be a non-negative finite number');

  let merchandise=0;
  for(const item of cart){
    if(item==null)throw new TypeError('invalid cart item');
    const quantity=(item.quantity===null||item.quantity===undefined)?1:item.quantity;
    const {price}=item;
    if(!isFiniteNumber(quantity)||quantity<0)throw new RangeError('quantity must be a non-negative finite number');
    if(!isFiniteNumber(price)||price<0)throw new RangeError('price must be a non-negative finite number');
    merchandise+=quantity*price;
  }

  const discounted=merchandise*(1-coupon/100);
  const rounded=Math.round(discounted*100)/100;
  return rounded+shipping;
};
