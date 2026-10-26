exports.classify=err=>{const s=err&&err.status;return typeof s==='number'&&s>=400&&s<500&&s!==408?'rejected':'uncertain';};
