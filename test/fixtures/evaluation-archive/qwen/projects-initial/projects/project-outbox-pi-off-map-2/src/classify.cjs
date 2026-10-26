function statusOf(err){
  if(!err)return undefined;
  const cands=[err.status,err.statusCode,err.httpStatus,
    err.response&&(err.response.status!=null?err.response.status:err.response.statusCode),
    err.payload&&err.payload.status,
    err.result&&err.result.status,
    err.cause&&(err.cause.status!=null?err.cause.status:err.cause.statusCode)];
  for(const c of cands){
    const n=typeof c==='string'&&c.trim()!==''?Number(c):c;
    if(typeof n==='number'&&Number.isFinite(n))return n;
  }
  return undefined;
}

exports.classify=function classify(err){
  const s=statusOf(err);
  if(typeof s!=='number')return 'uncertain';// transport error: outcome unknown
  if(s===408)return 'uncertain';// timeout: may have been delivered
  if(s>=500)return 'uncertain';// server error: outcome unknown
  if(s>=400&&s<500)return 'rejected';// permanent client error
  return 'uncertain';
};
