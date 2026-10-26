const {classify}=require('./classify.cjs');

function statusOf(res){
  if(typeof res==='number')return res;
  if(res&&typeof res==='object'&&typeof res.status==='number')return res.status;
  return null;
}

// Explicit resume: only an uncertain entry with this id returns to ready.
exports.resume=function(q,id){
  return q.map(function(x){
    return (x&&x.id===id&&x.state==='uncertain')?Object.assign({},x,{state:'ready'}):x;
  });
};

exports.drain=async function(q,post,persist){
  // Work on copies so the caller's queue stays pristine until persistence succeeds.
  const items=q.map(function(x){return Object.assign({},x);});
  const removed=new Set();
  let stop=false;
  for(const item of items){
    if(stop)break;
    if(!item||item.state!=='ready')continue; // untouched entries preserved
    let failure=null;
    try{
      const res=await post(Object.assign({},item));
      const s=statusOf(res);
      if(s!==null&&s>=400)failure={status:s};
    }catch(e){failure=e;}
    if(failure===null){removed.add(item);continue;} // confirmed success
    const kind=classify(failure);
    if(kind==='rejected'){item.state='rejected';continue;} // permanent, no auto retry
    item.state='uncertain'; // transport/408/5xx: stop; no retry, no further sends
    stop=true;
  }
  const next=items.filter(function(x){return !removed.has(x);});
  // Persist the new state first; if this throws, the original queue is untouched.
  await persist(next.map(function(x){return Object.assign({},x);}));
  // Persistence succeeded: apply visible updates to the caller's queue.
  // items[i] is index-aligned with the original q.
  for(let i=q.length-1;i>=0;i--){
    const item=items[i];
    if(removed.has(item)){q.splice(i,1);continue;}
    if(q[i]&&q[i].state!==item.state)q[i].state=item.state;
  }
  return q;
};
