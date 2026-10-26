const isNum=v=>typeof v==="number"&&Number.isFinite(v);
const qtyOf=i=>{const q=i==null?undefined:i.quantity;if(q===undefined||q===null)return 1;if(!isNum(q)||q<0)throw new TypeError("invalid quantity");return q;};
exports.total=(cart,coupon,shipping)=>{
if(!Array.isArray(cart))throw new TypeError("invalid cart");
if(!isNum(coupon)||coupon<0||coupon>100)throw new TypeError("invalid coupon");
if(!isNum(shipping)||shipping<0)throw new TypeError("invalid shipping");
let merch=0;
for(const i of cart){
const p=i==null?NaN:i.price;
if(!isNum(p)||p<0)throw new TypeError("invalid price");
merch+=qtyOf(i)*p;
}
return Math.round(merch*(1-coupon/100)*100)/100+shipping;
};
