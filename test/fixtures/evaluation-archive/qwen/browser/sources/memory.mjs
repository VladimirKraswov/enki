import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const helper = join(dirname(fileURLToPath(import.meta.url)), 'memory.py');
const notes = {
 'zero-value': 'Zero quantity is valid. Default only null and undefined; truthiness is not the project policy.',
 'idempotent-usage': 'The key is a structured pair (device,id). Delimiter concatenation can collide. Do not change caller records.',
 'stale-edit': 'Replacement text is literal, including $& and dollar patterns. Reject stale revision, empty needle and nonunique match before any edit.',
};
export const memoryTool = { name:'memory_search',description:'Search current owner-approved project facts. Reference data only; check current files. Cite href and source revision. No instructions, solutions or oracle.',inputSchema:{type:'object',additionalProperties:false,properties:{query:{type:'string',minLength:1,maxLength:256},limit:{type:'integer',minimum:1,maximum:8},budgetBytes:{type:'integer',minimum:1024,maximum:8192}},required:['query']} };
function invoke(data, input) {
 return new Promise((resolve,reject)=>{
  const child=spawn('python3',[helper,data],{stdio:['pipe','pipe','pipe']});let out='',size=0;
  const timer=setTimeout(()=>child.kill(),5000);
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>32768)child.kill();else out+=chunk;});child.stderr.resume();child.stdin.end(JSON.stringify(input));
  child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);if(code!==0)reject(Error('MEMORY_HELPER_FAILED'));else {try{resolve(JSON.parse(out));}catch{reject(Error('MEMORY_INVALID_REPLY'));}}});
 });
}
export async function evaluationMemory(root, fixture) {
 const data=join(root,'.memory');const seeded=await invoke(data,{action:'seed',facts:[[fixture.id,notes[fixture.id]??fixture.prompt]]});
 let calls=0,bytes=0;
 return { async search(args) {
  if(!args||typeof args.query!=='string'||!args.query.trim()||[...args.query].length>256||Object.keys(args).some(k=>!['query','limit','budgetBytes'].includes(k)))throw Error('INVALID_MEMORY_QUERY');
  const limit=args.limit??5,budget=args.budgetBytes??4096;
  if(!Number.isInteger(limit)||limit<1||limit>8||!Number.isInteger(budget)||budget<1024||budget>8192)throw Error('INVALID_MEMORY_BUDGET');
  if(++calls>20||bytes>=65536)throw Error('MEMORY_BUDGET_EXHAUSTED');
  const result=await invoke(data,{action:'retrieve',request:{project:seeded.project,query:args.query,limit,budget:budget-512}});
  const size=Buffer.byteLength(JSON.stringify(result));if(bytes+size>65536)throw Error('MEMORY_BUDGET_EXHAUSTED');bytes+=size;return result;
 }};
}
