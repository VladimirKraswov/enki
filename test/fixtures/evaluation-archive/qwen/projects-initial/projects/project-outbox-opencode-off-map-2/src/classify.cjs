const status=e=>{if(!e||typeof e!=='object')return undefined;if(typeof e.status==='number')return e.status;if(typeof e.statusCode==='number')return e.statusCode;if(e.response&&typeof e.response.status==='number')return e.response.status;return undefined};
exports.classify=e=>{const s=status(e);return typeof s==='number'&&s>=400&&s<500&&s!==408?'rejected':'uncertain'};
