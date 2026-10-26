const {matches}=require('./scope.cjs');

exports.apply=(s,e)=>{
  if(!matches(s.scope,e.scope))return s;
  if(s.seen.includes(e.id))return s;
  if(e.generation<s.generation)return s;
  return {...s,text:s.text+e.text,seen:[...s.seen,e.id]};
};

exports.switchTo=(s,scope)=>({...s,scope,generation:s.generation+1,text:'',seen:[]});
