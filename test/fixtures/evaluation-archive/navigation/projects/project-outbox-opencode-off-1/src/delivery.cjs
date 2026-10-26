exports.resume=(q,id)=>q.map(x=>x.id===id?{...x,state:'ready'}:x);
exports.drain=async(q,post,persist)=>{throw new Error('ARGS '+JSON.stringify({q,pt:typeof post,st:typeof persist,ns:arguments.length}));};
