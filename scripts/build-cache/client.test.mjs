import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheProxy, descriptor, withBuildCache } from './client.mjs';
const config={endpoint:'https://hub.example',platform:`${process.platform}-${process.arch}`,token:'a'.repeat(43),certificate:''};
test('capability only accepts the exact HTTPS origin and host platform',()=>{
 assert.equal(descriptor(config).endpoint,config.endpoint);
 for(const value of [{...config,endpoint:'http://hub.example'},{...config,endpoint:'https://hub.example/a'},{...config,endpoint:'https://a@hub.example'},{...config,platform:'foreign'},{...config,token:'x'}])assert.throws(()=>descriptor(value));
});
test('private proxy restricts credentials/paths/methods and passes only compiler objects',async()=>{
 const seen=[];const proxy=await cacheProxy(config,{transport:async(c,method,key,bytes)=>{seen.push([method,key,bytes]);return {code:method==='PUT'?201:200,body:Buffer.from('cached')};}});
 try {
  const url=proxy.endpoint+'a'.repeat(64),headers={Authorization:`Bearer ${proxy.token}`};
  assert.equal((await fetch(url)).status,403);
  assert.equal((await fetch(proxy.endpoint+'..%2Fsecrets',{headers})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers})).status,403);
  assert.equal((await fetch(proxy.endpoint+'/'+'a'.repeat(64),{headers})).status,200);
  assert.equal((await fetch(url,{method:'PUT',headers,body:'compiled'})).status,201);
  assert.deepEqual(seen.map(x=>x[0]),['GET','PUT']);assert.equal(seen[1][2].toString(),'compiled');assert.equal(proxy.stats().hits,1);
 }finally{await proxy.close();}
});
test('two transport failures disable remote lookups for this build without retry loops',async()=>{
 let calls=0;const proxy=await cacheProxy(config,{transport:async()=>{calls++;throw Error('offline');}});
 try {for(let i=0;i<5;i++)assert.equal((await fetch(proxy.endpoint+'b'.repeat(64),{headers:{Authorization:`Bearer ${proxy.token}`}})).status,404);assert.equal(calls,2);assert.equal(proxy.stats().state,'unavailable');}finally{await proxy.close();}
});
test('ordinary builds do not start a cache or change the environment',async()=>{
 const env={PATH:'test'};let calls=0;assert.equal(await withBuildCache({env,repo:'/unused'},async e=>{calls++;assert.equal(e,env);return 7;}),7);assert.equal(calls,1);
});
