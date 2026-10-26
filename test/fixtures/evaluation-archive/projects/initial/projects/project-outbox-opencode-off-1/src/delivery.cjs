const {classify}=require('./classify.cjs');

exports.resume=(q,id)=>q.map(x=>x.id===id&&x.state==='uncertain'?{...x,state:'ready'}:x);

exports.drain=async(q,post,persist)=>{
  const next=[];
  let stopped=false;
  for(let i=0;i<q.length;i++){
    const item=q[i];
    if(stopped||item.state!=='ready'){next.push(item);continue;}
    try{
      await post(item);
    }catch(e){
      const state=classify(e);
      next.push({...item,state});
      if(state==='uncertain')stopped=true;
      continue;
    }
  }
  await persist(next);
  q.length=0;
  for(const x of next)q.push(x);
  return q;
};
