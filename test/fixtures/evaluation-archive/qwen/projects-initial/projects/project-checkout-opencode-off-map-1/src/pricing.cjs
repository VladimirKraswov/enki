const isNum=(n)=>typeof n==='number'&&Number.isFinite(n);
exports.total=(cart,coupon,shipping)=>{
  if(!isNum(coupon)||coupon<0||coupon>100)throw new TypeError('invalid coupon');
  if(!isNum(shipping)||shipping<0)throw new TypeError('invalid shipping');
  let merchandise=0;
  for(const item of cart||[]){
    const quantity=item.quantity==null?1:item.quantity;
    if(!isNum(quantity)||quantity<0)throw new TypeError('invalid quantity');
    if(!isNum(item.price)||item.price<0)throw new TypeError('invalid price');
    merchandise+=quantity*item.price;
  }
  const discounted=Math.round(merchandise*(1-coupon/100)*100)/100;
  return discounted+shipping;
};
