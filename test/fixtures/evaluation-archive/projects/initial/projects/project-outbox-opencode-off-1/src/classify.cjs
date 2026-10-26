exports.classify=err=>{
  const s=err&&(typeof err.status==='number'?err.status:(err.response&&typeof err.response.status==='number'?err.response.status:undefined));
  if(typeof s==='number'&&s>=400&&s<500&&s!==408)return 'rejected';
  return 'uncertain';
};
