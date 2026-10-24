import fs from 'node:fs/promises';import path from 'node:path';
const gates=new Map<string,Promise<void>>();
/** Files persist across adapter restarts; native OS-lock behavior has Rust tests. */
export async function testImageTransaction(context:any,fn:(state:any)=>Promise<any>){
 const file=path.join(context.root,context.id+'.state.json'),before=gates.get(file)??Promise.resolve();
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});gates.set(file,before.then(()=>held));await before;
 try{
  let state;try{state=JSON.parse(await fs.readFile(file,'utf8'));}catch(e:any){if(e.code!=='ENOENT')throw e;state={version:1,requests:{},jobs:[],latest:null};}
  const value=await fn(state);await fs.writeFile(file,JSON.stringify(state));return value;
 }finally{release();}
}
