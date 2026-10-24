import {expect,it} from 'vitest';
// @ts-expect-error Shared Node module intentionally runs outside the WebView.
import {createImages as unscopedImages,validateConfig} from '../src-tauri/resources/shared/image-generation-core.mjs';
import {imageResult,turnImageResults} from '../src/images/results';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import crypto from 'node:crypto';
import {testImageTransaction} from './helpers/image-state';
function createImages(options:any){
 const sessionID=crypto.randomUUID(),identity={engine:'opencode',sessionID};
 const setup=(async()=>{const directory=await fs.realpath(options.cwd??process.cwd()),root=path.join(path.dirname(options.configFile),'image-context');await fs.mkdir(root,{recursive:true});const id=crypto.createHash('sha256').update(JSON.stringify([directory,'opencode',sessionID])).digest('hex');await fs.writeFile(path.join(root,id+'.json'),JSON.stringify({version:1,directory,engine:'opencode',sessionID,messageID:'test',images:[],supportsVision:true}));})();
 const run=unscopedImages({...options,stateTransaction:testImageTransaction});return async(name:string,args:any)=>{await setup;return run(name,{...args,__enkiImageContext:identity});};
}
it('rejects public HTTP, credential URLs and malicious image references',()=>{
 for(const endpoint of ['http://example.com','http://192.168.1.2.evil.test','https://key@example.com','https://a/?key=x','file:///tmp'])expect(()=>validateConfig({enabled:true,provider:'enki',model:'m',endpoint})).toThrow();
 expect(validateConfig({enabled:true,provider:'enki',model:'m',endpoint:'http://192.168.1.2/api/'}).endpoint).toBe('http://192.168.1.2/api');
 expect(imageResult(JSON.stringify({enkiImages:1,status:'completed',images:[{name:'image-01.png',url:'https://evil.test/x'}]}))).toBeNull();
 expect(imageResult(JSON.stringify({enkiImages:1,status:'completed',images:[{name:'image-01.png',url:'file:///tmp/.enki/generated-images/01234567-1234-1234-1234-123456789abc/image-01.png'}]}))?.images).toHaveLength(1);
});
it('creates bounded idempotent jobs with auth and never replays a failed POST',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'enki-images-'));try{
 const config=path.join(dir,'settings.json');await fs.writeFile(config,JSON.stringify({enabled:true,provider:'enki',model:'m',endpoint:'http://127.0.0.1/api'}));
 const calls:any[]=[];const run=createImages({configFile:config,cwd:dir,token:()=> 'private-token',fetcher:async(url:string,options:any)=>{calls.push({url,options});return new Response(url.endsWith('/health')?'{"status":"ready"}':'{"id":"job","status":"queued"}',{status:202})}});
 expect(await run('generate_icon_pack',{prompt:'flat blue icons',items:['sword','shield'],request_key:'stable'})).toEqual({id:'job',status:'queued'});
 expect(calls).toHaveLength(2);expect(calls[1].options.headers.Authorization).toBe('Bearer private-token');expect(calls[1].options.headers['Idempotency-Key']).toMatch(/^enki-[a-f0-9]{64}$/);expect(JSON.parse(calls[1].options.body).items).toEqual(['sword','shield']);
 await expect(run('generate_image',{prompt:'x',request_key:'k',width:801})).rejects.toThrow();expect(calls).toHaveLength(2);
 let attempts=0;const failed=createImages({configFile:config,fetcher:async(url:string)=>{if(url.endsWith('/health'))return new Response('{"status":"ready"}');attempts++;throw Error('lost acknowledgement')}});
 await expect(failed('generate_image',{prompt:'x',request_key:'same'})).rejects.toThrow('lost acknowledgement');expect(attempts).toBe(1);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
it('preserves existing files and refuses symlink destinations',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'enki-images-'));try{
 const config=path.join(dir,'settings.json');await fs.writeFile(config,JSON.stringify({enabled:true,provider:'openai',model:'m',endpoint:'https://example.com/v1'}));await fs.symlink(os.tmpdir(),path.join(dir,'.enki'),'junction');
 const run=createImages({configFile:config,cwd:dir,fetcher:async()=>new Response(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4l8AAAAASUVORK5CYII='}]}))});
 await expect(run('generate_image',{prompt:'x',request_key:'k'})).rejects.toThrow('ссылкой');
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

it('keeps one visible set of generated images after repeated tool retrievals',()=>{
 const output=JSON.stringify({enkiImages:1,status:'completed',images:[{name:'image-01.png',url:'file:///tmp/.enki/generated-images/01234567-1234-1234-1234-123456789abc/image-01.png'}]});
 expect(turnImageResults([{state:{output}},{state:{output}},{state:{output:'unrelated'}}])).toHaveLength(1);
});

it('defaults quality jobs to native-size output and keeps LCM an explicit draft',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'enki-image-quality-'));try{
  const config=path.join(dir,'settings.json');const bodies:any[]=[];
  const run=createImages({configFile:config,cwd:dir,fetcher:async(url:string,o:any)=>{if(url.endsWith('/health'))return new Response('{"status":"ready"}');bodies.push(JSON.parse(o.body));return new Response('{"id":"j","status":"queued"}')}});
  for(const model of ['enki-image-auto','lcm-dreamshaper-v7']){
   await fs.writeFile(config,JSON.stringify({enabled:true,provider:'enki',model,endpoint:'http://127.0.0.1/api'}));
   await run('generate_image',{prompt:'anime portrait',request_key:model});
  }
  expect(bodies.map(b=>[b.model,b.width,b.height])).toEqual([['enki-image-auto',1024,1024],['lcm-dreamshaper-v7',512,512]]);
  await fs.writeFile(config,JSON.stringify({enabled:true,provider:'enki',model:'enki-image-auto',endpoint:'http://127.0.0.1/api'}));
  await expect(run('generate_image',{prompt:'x',request_key:'large',width:1536,height:1536})).rejects.toThrow();
  expect(bodies).toHaveLength(2);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

it('accepts only the bounded material map names and keeps their previews visible',()=>{
 const base='file:///tmp/.enki/generated-images/01234567-1234-1234-1234-123456789abc/';
 expect(imageResult(JSON.stringify({enkiImages:1,status:'completed',images:[{name:'normal.png',url:base+'normal.png',previewUrl:base+'preview-normal.png'}]}))?.images[0].name).toBe('normal.png');
 expect(imageResult(JSON.stringify({enkiImages:1,status:'completed',images:[{name:'private.png',url:base+'private.png'}]}))).toBeNull();
});
it('recovers a temporary read-only outage before submitting one generation',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'enki-images-'));try{
  const config=path.join(dir,'settings.json');await fs.writeFile(config,JSON.stringify({enabled:true,provider:'enki',model:'m',endpoint:'http://127.0.0.1/api'}));
  let reads=0,posts=0;const run=createImages({configFile:config,fetcher:async(_url:string,options:any)=>{if(options.method==='POST'){posts++;return new Response('{"id":"j","status":"queued"}',{status:202})}reads++;return reads===1?new Response('temporary',{status:502}):new Response('{"status":"ready"}')}});
  expect(await run('generate_image',{prompt:'stone',request_key:'one'})).toEqual({id:'j',status:'queued'});expect(reads).toBe(2);expect(posts).toBe(1);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
