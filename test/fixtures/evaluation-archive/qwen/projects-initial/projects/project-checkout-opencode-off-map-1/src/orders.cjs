const pricing=require('./pricing.cjs');
exports.checkout=async(store,id,cart,coupon,shipping,charge)=>{
  if(store.has(id))return store.get(id);
  const total=pricing.total(cart,coupon,shipping);
  const receipt={id,total};
  await charge(total);
  store.set(id,receipt);
  return receipt;
};
