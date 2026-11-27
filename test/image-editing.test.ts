import {it,expect} from 'vitest';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
// @ts-expect-error Shared Node runtime.
import {createImages} from '../src-tauri/resources/shared/image-generation-core.mjs';
import {testImageTransaction} from './helpers/image-state';
const scopedImages=(options:any)=>createImages({...options,stateTransaction:testImageTransaction});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4l8AAAAASUVORK5CYII=','base64');
const job='01234567-1234-1234-1234-123456789abc';
const health=JSON.stringify({status:'ready',model:{id:'qwen-image-edit-2511',steps:4,multiple:16,max_side:1536,max_pixels:1048576,max_items:8},engine:{name:'ComfyUI'},queue:{pending:0,running:0}});
const view=(over:any={})=>({id:job,state:'queued',mode:'text-to-image',progress:{phase:'queued',step:0,steps:4,percent:0},width:1024,height:1024,seed:42,images:[],...over});
const completed=(over:any={})=>view({state:'completed',progress:{phase:'done',step:4,steps:4,percent:100},images:[{name:'image-01.png',prompt:'x',seed:42,width:1024,height:1024,bytes:png.length}],...over});
async function fixture(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'enki-edit-')),configFile=path.join(dir,'images.json'),root=path.join(dir,'image-context');await fs.mkdir(root);
 await fs.writeFile(configFile,JSON.stringify({enabled:true,endpoint:'http://127.0.0.1/api/images'}));
 const identity={engine:'opencode',sessionID:'session-a'},id=crypto.createHash('sha256').update(JSON.stringify([await fs.realpath(dir),identity.engine,identity.sessionID])).digest('hex');
 const stage=async(messageID:string,images=true,vision=true)=>fs.writeFile(path.join(root,id+'.json'),JSON.stringify({version:1,directory:await fs.realpath(dir),...identity,messageID,supportsVision:vision,images:images?[{name:'original.png',mime:'image/png',data:png.toString('base64'),sha256:crypto.createHash('sha256').update(png).digest('hex'),width:1,height:1}]:[]}));
 await stage('human-one');const posts:any[]=[];
 const fetcher=async(url:string,o:any={})=>{
  if(o.method==='POST'){posts.push(JSON.parse(o.body));return new Response(JSON.stringify(view()),{status:201});}
  if(url.endsWith('/health'))return new Response(health);
  if(url.endsWith('/metadata'))return new Response(JSON.stringify({id:job,state:'completed',request:{prompt:'x',items:[],width:1024,height:1024,seed:42,strength:null,source:false},inference:{model:'qwen-image-edit-2511',steps:4,guidance:1,sampler:'euler/simple'},images:[]}));
  if(url.includes('/images/image-'))return new Response(png);
  if(url.includes('/jobs?'))return new Response(JSON.stringify({items:[]}));
  return new Response(JSON.stringify(completed()));
 };
 const run=scopedImages({configFile,cwd:dir,fetcher});
 const call=(name:string,args:any={})=>run(name,{...args,__enkiImageContext:identity});
 return {dir,configFile,run,call,posts,stage,identity,cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
it('uses actual attachment bytes, remembers latest across process restart and edits the previous output',async()=>{
 const f=await fixture();try{
  expect((await f.call('image_inputs')).inputs[0].source).toBe('attachment:1');
  await f.call('edit_image',{prompt:'same portrait, blue hair',source:'attachment:1',request_key:'first'});
  expect(f.posts[0].source_image).toEqual({data_base64:png.toString('base64')});expect(f.posts[0].strength).toBeUndefined();
  expect(f.posts[0].width%16).toBe(0);expect(f.posts[0].height%16).toBe(0);
  await f.call('get_images',{job_id:job});
  await f.stage('human-two',false);
  const restarted=scopedImages({configFile:f.configFile,cwd:f.dir,fetcher:async(url:string,o:any={})=>{if(url.endsWith('/health'))return new Response(health);if(o.method==='POST'){f.posts.push(JSON.parse(o.body));return new Response(JSON.stringify(view()),{status:201});}throw Error('The server pruned this old image; the local immutable copy must be used');}});
  await restarted('edit_image',{source:'latest',prompt:'same portrait, red hair',request_key:'next',__enkiImageContext:f.identity});
  expect(f.posts[1].source_image.data_base64).toBe(png.toString('base64'));
 }finally{await f.cleanup();}
});
it('keeps the newest generation when POST acknowledgements and later retrievals arrive in reverse order',async()=>{
 const f=await fixture();try{
  const a='11234567-1234-1234-1234-123456789abc',b='21234567-1234-1234-1234-123456789abc';
  const run=scopedImages({configFile:f.configFile,cwd:f.dir,fetcher:async(url:string,o:any={})=>{
   if(url.endsWith('/health'))return new Response(health);
   if(o.method==='POST'){const prompt=JSON.parse(o.body).prompt;if(prompt==='first')await new Promise(resolve=>setTimeout(resolve,80));return new Response(JSON.stringify(view({id:prompt==='first'?a:b})),{status:201});}
   if(url.endsWith('/metadata'))return new Response('{}');
   if(url.includes('/images/image-'))return new Response(png);
   return new Response(JSON.stringify(completed()));
  }});
  const call=(name:string,args:any={})=>run(name,{...args,__enkiImageContext:f.identity});
  await Promise.all([call('generate_image',{prompt:'first',request_key:'a'}),call('generate_image',{prompt:'second',request_key:'b'})]);
  await call('get_images',{job_id:b});await call('get_images',{job_id:a});
  expect((await call('image_inputs')).latest.job_id).toBe(b);
 }finally{await f.cleanup();}
});
it('enforces TWO total jobs across generation, packs and editing with a new human reset',async()=>{
 const f=await fixture();try{
  const first={prompt:'anime portrait',request_key:'a'};
  await f.call('generate_image',first);await f.call('generate_image',first);expect(f.posts).toHaveLength(1);
  await f.call('edit_image',{prompt:'redraw',source:'attachment:1',request_key:'b'});
  await expect(f.call('generate_icon_pack',{prompt:'icons',items:['sword'],request_key:'c'})).rejects.toThrow('две попытки');expect(f.posts).toHaveLength(2);
  await f.stage('human-two');await f.call('generate_image',{prompt:'new request',request_key:'d'});expect(f.posts).toHaveLength(3);
 }finally{await f.cleanup();}
});
it('does not borrow another session’s sources, bypass Vision or silently ignore a missing image',async()=>{
 const f=await fixture();try{
  await expect(f.run('edit_image',{source:'attachment:1',prompt:'x',request_key:'a'})).rejects.toThrow('контекст');
  await expect(f.run('image_inputs',{__enkiImageContext:{engine:'opencode',sessionID:'other'}})).rejects.toThrow();
  await expect(f.call('edit_image',{source:'latest',prompt:'x',request_key:'a'})).rejects.toThrow('ещё нет');
  await f.stage('human-two',true,false);
  await expect(f.call('get_images',{job_id:job,include_vision:true})).rejects.toThrow('не поддерживает Vision');
  expect(f.posts).toHaveLength(0);
 }finally{await f.cleanup();}
});
it('reserves concurrent attempts atomically and preserves a lost-acknowledgement reservation',async()=>{
 const f=await fixture();try{
  const results=await Promise.allSettled([0,1,2,3].map(i=>f.call('generate_image',{prompt:'x',request_key:'concurrent-'+i})));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);expect(f.posts).toHaveLength(2);
  await f.stage('lost');let calls=0;
  const run=scopedImages({configFile:f.configFile,cwd:f.dir,fetcher:async(url:string,options:any={})=>{if(url.endsWith('/health'))return new Response(health);if(options.method==='POST'){calls++;throw Error('lost ack');}if(url.includes('/jobs?'))return new Response(JSON.stringify({items:[]}));return new Response('not found',{status:404});}});
  const args={prompt:'x',request_key:'lost',__enkiImageContext:f.identity};
  await expect(run('generate_image',args)).rejects.toThrow('lost ack');
  await expect(run('generate_image',args)).rejects.toThrow('мог быть отправлен');
  expect(calls).toBe(1);
 }finally{await f.cleanup();}
});
it('recovers a lost accepted reply by matching the live queue, never by a second POST',async()=>{
 const f=await fixture();try{
  let posts=0;
  const run=scopedImages({configFile:f.configFile,cwd:f.dir,fetcher:async(url:string,o:any={})=>{
   if(url.endsWith('/health'))return new Response(health);
   if(o.method==='POST'){posts++;throw Error('lost accepted reply');}
   if(url.includes('/jobs?state=running'))return new Response(JSON.stringify({items:[view({state:'running',prompt:'x'})]}));
   if(url.includes('/jobs?state=queued'))return new Response(JSON.stringify({items:[]}));
   if(url.endsWith('/metadata'))return new Response(JSON.stringify({request:{prompt:'x',items:[],width:1024,height:1024,seed:42,strength:null,source:false}}));
   return new Response('not found',{status:404});
  }});
  const args={prompt:'x',request_key:'same',__enkiImageContext:f.identity};
  await expect(run('generate_image',args)).rejects.toThrow('lost accepted');
  expect((await run('generate_image',args)).id).toBe(job);expect(posts).toBe(1);
 }finally{await f.cleanup();}
});
