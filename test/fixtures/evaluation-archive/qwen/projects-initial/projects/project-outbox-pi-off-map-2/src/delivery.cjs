const {classify}=require('./classify.cjs');

// Explicit resume: only an uncertain entry with this id returns to ready.
exports.resume=(q,id)=>q.map(x=>x.id===id&&x.state==='uncertain'?{...x,state:'ready'}:x);

// Drain ready entries in order. Other entries are untouched.
// - POST confirmed success -> entry removed.
// - Permanent rejection (4xx except 408) -> entry marked rejected, continue.
// - Uncertain (transport error, 408, 5xx) -> entry marked uncertain, stop.
// Every queue change is persisted BEFORE the caller-visible queue is updated;
// if persist throws, the original queue array is left exactly as it was.
exports.drain=async(q,post,persist)=>{
  let i=0;
  while(i<q.length){
    const item=q[i];
    if(item.state!=='ready'){i++;continue;}
    let result;
    try{
      await post(item);
      result={ok:true};
    }catch(e){
      result={ok:false,cls:classify(e)};
    }
    let next;
    if(result.ok){
      next=q.filter(x=>x!==item);
    }else if(result.cls==='rejected'){
      next=q.map(x=>x===item?{...x,state:'rejected'}:x);
    }else{
      next=q.map(x=>x===item?{...x,state:'uncertain'}:x);
    }
    // Durable write first; a throw here leaves q untouched and aborts the drain.
    await persist(next);
    q.splice(0,q.length,...next);
    if(result.ok)continue; // entry removed; element now at i is the next one
    if(result.cls==='rejected'){i++;continue;}
    break; // uncertain: stop without retrying or sending following entries
  }
  return q;
};
