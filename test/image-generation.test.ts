import {expect,it} from 'vitest';
// @ts-expect-error Shared Node module intentionally runs outside the WebView.
import {createImages as unscopedImages,validateConfig} from '../src-tauri/resources/shared/image-generation-core.mjs';
import {imageResult,turnImageResults} from '../src/images/results';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import crypto from 'node:crypto';
import {testImageTransaction} from './helpers/image-state';
const JOB='01234567-1234-1234-1234-123456789abc';
const png=(w=1024,h=1024)=>{const b=Buffer.alloc(33);b.write('89504e470d0a1a0a','hex');b.write('IHDR',12,'ascii');b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);return b;};
const health=JSON.stringify({status:'ready',model:{id:'qwen-image-edit-2511',steps:4,multiple:16,max_side:1536,max_pixels:1048576,max_items:8},engine:{name:'ComfyUI'},queue:{pending:0,running:0}});
const job=(over:any={})=>({id:JOB,state:'queued',mode:'text-to-image',progress:{phase:'queued',step:0,steps:4,percent:0},width:1024,height:1024,seed:42,images:[],...over});
function createImages(options:any){
 const sessionID=crypto.randomUUID(),identity={engine:'opencode',sessionID};
 const setup=(async()=>{const directory=await fs.realpath(options.cwd??process.cwd()),root=path.join(path.dirname(options.configFile),'image-context');await fs.mkdir(root,{recursive:true});const id=crypto.createHash('sha256').update(JSON.stringify([directory,'opencode',sessionID])).digest('hex');const images=(options.attachments??[]).map((bytes:Buffer,index:number)=>({name:`image-${index+1}.png`,mime:'image/png',data:bytes.toString('base64'),sha256:crypto.createHash('sha256').update(bytes).digest('hex'),width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)}));await fs.writeFile(path.join(root,id+'.json'),JSON.stringify({version:1,directory,engine:'opencode',sessionID,messageID:'test',images,supportsVision:true}));})();
 const run=unscopedImages({...options,stateTransaction:testImageTransaction});return async(name:string,args:any)=>{await setup;return run(name,{...args,__enkiImageContext:identity});};
}
it('accepts only a local-network or HTTPS hub without credentials in the URL',()=>{
 for(const endpoint of ['http://example.com','http://192.168.1.2.evil.test','https://key@example.com','https://a/?key=x','file:///tmp'])expect(()=>validateConfig({enabled:true,endpoint})).toThrow();
 expect(validateConfig({enabled:true,endpoint:'http://192.168.1.2/api/images/'}).endpoint).toBe('http://192.168.1.2/api/images');
 expect(validateConfig({enabled:true,endpoint:'https://hub.example.com/api/images'}).endpoint).toBe('https://hub.example.com/api/images');
});
it('creates one authenticated job with the hub contract and never replays a failed POST',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'enki-images-'));try{
 const config=path.join(dir,'settings.json');await fs.writeFile(config,JSON.stringify({enabled:true,endpoint:'http://127.0.0.1/api/images'}));
 const calls:any[]=[];const run=createImages({configFile:config,cwd:dir,token:()=> 'private-token',fetcher:async(url:string,options:any)=>{calls.push({url,options});return new Response(url.endsWith('/health')?health:JSON.stringify(job()),{status:url.endsWith('/jobs')?201:200})}});
 const created=await run('generate_icon_pack',{prompt:'flat blue icons',items:['sword','shield'],request_key:'stable'});
 expect(created.id).toBe(JOB);expect(calls.map(c=>c.options.method??'GET')).toEqual(['GET','POST']);
 const post=calls[1];expect(post.options.headers.Authorization).toBe('Bearer private-token');expect(post.options.headers['Idempotency-Key']).toBeUndefined();
 const body=JSON.parse(post.options.body);expect(body).toEqual({prompt:'flat blue icons',items:['sword','shield'],width:1024,height:1024,seed:42,quality:'fast'});
 await expect(run('generate_image',{prompt:'x',request_key:'k',width:801})).rejects.toThrow(/кратны 16/);expect(calls.filter(c=>(c.options.method??'GET')==='POST')).toHaveLength(1);
 let attempts=0;const failed=createImages({configFile:config,fetcher:async(url:string)=>{if(url.endsWith('/health'))return new Response(health);attempts++;throw Error('lost acknowledgement')}});
 await expect(failed('generate_image',{prompt:'x',request_key:'same'})).rejects.toThrow('lost acknowledgement');expect(attempts).toBe(1);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
it('saves returned PNGs without following symlinks and reports the job metadata',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'enki-images-'));try{
 const config=path.join(dir,'settings.json');await fs.writeFile(config,JSON.stringify({enabled:true,endpoint:'http://127.0.0.1/api/images'}));
 const fetcher=async(url:string,options:any)=>{if(url.endsWith('/health'))return new Response(health);if(options?.method==='POST')return new Response(JSON.stringify(job()),{status:201});if(url.endsWith('/metadata'))return new Response(JSON.stringify({id:JOB,state:'completed',request:{prompt:'a fox',items:[],width:1024,height:1024,seed:42,strength:null,source:false},inference:{model:'qwen-image-edit-2511',steps:4,guidance:1,sampler:'euler/simple'},images:[]}));if(url.endsWith('/images/image-01.png'))return new Response(png());return new Response(JSON.stringify(job({state:'completed',images:[{name:'image-01.png',prompt:'a fox',seed:42,width:1024,height:1024,bytes:33}]})))};
 const run=createImages({configFile:config,cwd:dir,fetcher});
 const created=await run('generate_image',{prompt:'a fox',request_key:'one'});
 const result=await run('get_images',{job_id:created.id,include_vision:true});
 expect(result.enkiImages).toBe(1);expect(result.images).toHaveLength(1);expect(result.images[0].name).toBe('image-01.png');
 expect(result.images[0].url).toMatch(/\.enki\/generated-images\/01234567-1234-1234-1234-123456789abc\/image-01\.png$/);
 expect(result.inference.steps).toBe(4);expect(result.vision).toHaveLength(1);
 expect(await fs.readFile(path.join(dir,'.enki','generated-images',JOB,'image-01.png'))).toEqual(png());
 const linked=await fs.mkdtemp(path.join(os.tmpdir(),'enki-images-link-'));try{
  const other=path.join(linked,'settings.json');await fs.writeFile(other,JSON.stringify({enabled:true,endpoint:'http://127.0.0.1/api/images'}));await fs.symlink(os.tmpdir(),path.join(linked,'.enki'),'junction');
  const runLinked=createImages({configFile:other,cwd:linked,fetcher});
  const createdLinked=await runLinked('generate_image',{prompt:'a fox',request_key:'two'});
  await expect(runLinked('get_images',{job_id:createdLinked.id})).rejects.toThrow('ссылкой');
 }finally{await fs.rm(linked,{recursive:true,force:true})}
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
it('keeps an edited source aspect inside the hub size limits',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'enki-images-'));try{
 const config=path.join(dir,'settings.json');await fs.writeFile(config,JSON.stringify({enabled:true,endpoint:'http://127.0.0.1/api/images'}));
 const bodies:any[]=[];const run=createImages({configFile:config,cwd:dir,attachments:[png(1536,768)],fetcher:async(url:string,options:any)=>{if(url.endsWith('/health'))return new Response(health);bodies.push(JSON.parse(options.body));return new Response(JSON.stringify(job({mode:'image-edit'})),{status:201})}});
 await run('edit_image',{prompt:'repaint the sky orange',source:'attachment:1',request_key:'edit'});
 const body=bodies[0];expect(body.source_image.data_base64.length).toBeGreaterThan(0);
 expect(body.width%16).toBe(0);expect(body.height%16).toBe(0);expect(body.width*body.height).toBeLessThanOrEqual(1048576);
 expect(body.width/body.height).toBeCloseTo(2,0);expect(body.strength).toBeUndefined();
 await expect(run('edit_image',{prompt:'x',source:'attachment:1',request_key:'edit2',strength:1.5})).rejects.toThrow('strength');
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
it('shows only job images of a session and ignores retired result names',()=>{
 const base='file:///tmp/.enki/generated-images/01234567-1234-1234-1234-123456789abc/';
 expect(imageResult(JSON.stringify({enkiImages:1,status:'completed',images:[{name:'image-01.png',url:base+'image-01.png'}]}))?.images).toHaveLength(1);
 expect(imageResult(JSON.stringify({enkiImages:1,status:'completed',images:[{name:'normal.png',url:base+'normal.png'}]}))).toBeNull();
 expect(imageResult(JSON.stringify({enkiImages:1,status:'completed',images:[{name:'image-01.png',url:'https://evil.test/x'}]}))).toBeNull();
 const output=JSON.stringify({enkiImages:1,status:'completed',images:[{name:'image-01.png',url:base+'image-01.png'}]});
 expect(turnImageResults([{state:{output}},{state:{output}},{state:{output:'unrelated'}}])).toHaveLength(1);
});
it('recovers a temporary read-only outage before submitting one generation',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'enki-images-'));try{
  const config=path.join(dir,'settings.json');await fs.writeFile(config,JSON.stringify({enabled:true,endpoint:'http://127.0.0.1/api/images'}));
  let reads=0,posts=0;const run=createImages({configFile:config,cwd:dir,fetcher:async(url:string,options:any)=>{if(options.method==='POST'){posts++;return new Response(JSON.stringify(job()),{status:201})}reads++;return reads===1?new Response('temporary',{status:502}):new Response(health)}});
  expect((await run('generate_image',{prompt:'stone',request_key:'one'})).id).toBe(JOB);expect(reads).toBe(2);expect(posts).toBe(1);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
