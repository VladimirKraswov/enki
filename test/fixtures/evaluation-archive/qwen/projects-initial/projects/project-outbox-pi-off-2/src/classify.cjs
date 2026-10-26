function statusOf(err){
  if(typeof err==='number')return err;
  if(!err||typeof err!=='object')return null;
  if(typeof err.status==='number')return err.status;
  if(typeof err.statusCode==='number')return err.statusCode;
  if(err.response&&typeof err.response.status==='number')return err.response.status;
  if(typeof err.message==='string'){
    const m=err.message.match(/\b([1-5]\d{2})\b/);
    if(m)return Number(m[1]);
  }
  return null;
}
exports.classify=function(err){
  const s=statusOf(err);
  if(s===null)return 'uncertain';          // transport error: outcome unknown
  if(s===408)return 'uncertain';           // timeout: outcome unknown
  if(s>=400&&s<500)return 'rejected';      // permanent client error, no retry
  return 'uncertain';                      // 5xx or anything else: unknown
};
