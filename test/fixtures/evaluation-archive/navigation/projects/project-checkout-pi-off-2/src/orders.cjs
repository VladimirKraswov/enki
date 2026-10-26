const pricing=require('./pricing.cjs');

exports.checkout=async(store,id,cart,coupon,shipping,charge)=>{
  // Duplicate order id: return the saved receipt without charging again.
  if(typeof store.has==='function'){
    if(store.has(id))return store.get(id);
  }else{
    const saved=store.get(id);
    if(saved!==undefined)return saved;
  }

  // Validate (throws on invalid input) BEFORE any side effect such as charging.
  const total=pricing.total(cart,coupon,shipping);
  const receipt={id,total};

  await charge(total);
  store.set(id,receipt);
  return receipt;
};
