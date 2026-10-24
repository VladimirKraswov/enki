// Trusted dispatch context is staged by Enki, never derived from model prose.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const error=()=>Error('Контекст изображений этой сессии недоступен. Отправьте запрос из обновлённого Enki; чужие сессии и файлы не используются.');
async function read(file,max){
 const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size>max)throw error();
 return JSON.parse(await fs.readFile(file,'utf8'));
}
export function imageBytes(data,mime){
 if(typeof data!=='string'||data.length>Math.ceil(8*1048576/3)*4||!data.length||data.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))throw Error('Исходное изображение повреждено или больше 8 МБ');
 const bytes=Buffer.from(data,'base64');
 const valid=mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:mime==='image/webp'?bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP':false;
 if(!valid||bytes.length>8*1048576||bytes.toString('base64')!==data)throw Error('Для перерисовки нужен корректный PNG, JPEG или WebP до 8 МБ');
 return bytes;
}
export async function imageContext(configFile,cwd,identity){
 if(!identity||!['opencode','pi'].includes(identity.engine)||typeof identity.sessionID!=='string'||!identity.sessionID||identity.sessionID.length>240)throw error();
 const directory=await fs.realpath(cwd),root=path.join(path.dirname(configFile),'image-context');
 const parent=await fs.lstat(root);if(!parent.isDirectory()||parent.isSymbolicLink())throw error();
 const id=hash(JSON.stringify([directory,identity.engine,identity.sessionID]));
 const context=await read(path.join(root,id+'.json'),24*1048576);
 if(context.version!==1||context.directory!==directory||context.engine!==identity.engine||context.sessionID!==identity.sessionID||typeof context.messageID!=='string'||!context.messageID||context.messageID.length>240||!Array.isArray(context.images)||context.images.length>4)throw error();
 let total=0;
 for(const input of context.images){const bytes=imageBytes(input.data,input.mime);total+=bytes.length;if(total>16*1048576||input.sha256!==hash(bytes))throw error();}
 return {...context,root,id};
}
export async function withImageState(context,fn){
 if(context.transaction)return context.transaction(context,fn);
 const executable=process.env.MESH_CAPABILITIES_COMMAND;
 if(!executable||!path.isAbsolute(executable))throw Error('Нужен обновлённый нативный Enki для безопасного бюджета изображений.');
 const child=spawn(executable,['--image-state-lock',context.id],{stdio:['pipe','pipe','pipe'],windowsHide:true,cwd:context.directory});
 const lines=readline.createInterface({input:child.stdout,crlfDelay:Infinity});
 let size=0;child.stdout.on('data',chunk=>{size+=chunk.length;if(size>2*1048576)child.kill();});
 child.stderr.resume();
 let processError;child.on('error',e=>{processError=e;lines.close();});
 const exited=new Promise(resolve=>child.on('exit',code=>resolve(code)));
 const timer=setTimeout(()=>child.kill(),10000);
 try{
  const iterator=lines[Symbol.asyncIterator]();
  const first=await iterator.next();if(first.done||processError)throw Error('Не удалось получить блокировку состояния изображений. Обновите нативный Enki.');
  const state=JSON.parse(first.value);
  if(state.version!==1||!state.requests||!Array.isArray(state.jobs))throw error();
  const result=await fn(state);
  const json=JSON.stringify(state);if(Buffer.byteLength(json)>1048576)throw Error('Слишком большое состояние изображений');
  child.stdin.end(json+'\n');
  const ack=await iterator.next();if(ack.done||JSON.parse(ack.value).ok!==true)throw Error('Состояние изображений не сохранено; генерация не повторяется автоматически.');
  if(await exited!==0)throw Error('Запись состояния изображений прервалась');
  return result;
 }finally{clearTimeout(timer);lines.close();child.stdin.destroy();child.kill();}
}
export function imageRequestKey(context,key){return 'enki-'+hash(JSON.stringify([context.directory,context.engine,context.sessionID,context.messageID,key]));}
export async function reserveImage(context,key,payload){
 const fingerprint=hash(JSON.stringify(payload));
 return withImageState(context,state=>{
  const attempts=state.requests[context.messageID]??=[];
  const previous=attempts.find(a=>a.key===key);
  if(previous){if(previous.fingerprint!==fingerprint)throw Error('Этот request_key уже относится к другим параметрам. Не изменяйте принятый запрос.');if(previous.result)return {cached:previous.result};return {pending:true};}
  if(attempts.length>=2)throw Error('Достигнут предел: две попытки генерации на одну просьбу. Покажите лучший результат и его ограничения; следующую правку начните только после нового сообщения пользователя.');
  state.sequence=(state.sequence??0)+1;
  attempts.push({key,fingerprint,sequence:state.sequence});
  const messages=Object.keys(state.requests);while(messages.length>32)delete state.requests[messages.shift()];
  return {};
 });
}
export async function recordImage(context,key,result){
 return withImageState(context,state=>{
  const attempt=state.requests[context.messageID]?.find(a=>a.key===key);if(!attempt)throw error();
  // Receipts contain identifiers, not image pixels or verbose per-file prompts.
  attempt.result=result.enkiImages?result:{id:result.id,status:result.status,model:result.model};
  const job=result.id??result.job_id;if(typeof job==='string'&&/^[a-f0-9-]{36}$/.test(job)&&!state.jobs.includes(job)){state.jobs.push(job);state.jobs=state.jobs.slice(-200);state.jobOrder??={};state.jobOrder[job]=attempt.sequence;for(const id of Object.keys(state.jobOrder))if(!state.jobs.includes(id))delete state.jobOrder[id];}
 });
}
export async function latestImage(context){return withImageState(context,state=>state.latest);}
export async function rememberImage(context,job,name,bytes){
 return withImageState(context,state=>{
  // Results from an unrelated session cannot become this session's edit source.
  const sequence=state.jobOrder?.[job]??state.jobs.indexOf(job);
  if(state.jobs.includes(job)&&(!state.latest||sequence>=(state.latest.sequence??-1)))state.latest={job_id:job,name,sha256:hash(bytes),sequence};
 });
}
