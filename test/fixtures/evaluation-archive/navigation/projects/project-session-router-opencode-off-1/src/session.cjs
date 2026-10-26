const {matches}=require('./scope.cjs');

const generationOf=(scope)=>(scope&&typeof scope.generation==='number')?scope.generation:0;

exports.apply=(s,e)=>{
  if(!matches(s.scope,e.scope))return s;
  if(s.seen.includes(e.id))return s;
  if(generationOf(e.scope)<generationOf(s.scope))return s;
  return {...s,text:s.text+e.text,seen:[...s.seen,e.id]};
};

exports.switchTo=(s,scope)=>({
  ...s,
  scope:{...scope,generation:generationOf(s.scope)+1},
  text:'',
  seen:[],
});
