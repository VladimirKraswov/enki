const {matches}=require('./scope.cjs');

exports.apply=(s,e)=>{
  // Unrelated event: any scope field differs -> keep original state.
  if(!matches(s.scope,e.scope))return s;
  // Duplicate event ID -> keep original state.
  if(Array.isArray(s.seen)&&s.seen.includes(e.id))return s;
  // Generation older than current -> keep original state.
  if(typeof e.generation==='number'&&typeof s.generation==='number'&&e.generation<s.generation)return s;
  // Applicable: append the text delta once, record the event ID,
  // retaining every other state field. Never mutate the inputs.
  return {...s,text:(s.text||'')+e.text,seen:(s.seen||[]).concat(e.id)};
};

exports.switchTo=(s,scope)=>({
  ...s,
  scope,
  generation:(typeof s.generation==='number'?s.generation:0)+1,
  text:'',
  seen:[]
});
