import {afterEach,expect,it} from 'vitest';
import {harness,type Harness} from './helpers.ts';
let h:Harness;
afterEach(async()=>{await h?.stop();});
it('refuses configuration changes during runtime work even if the UI says idle, and preserves CAS',async()=>{
 h=await harness();
 const before=await h.request<{content:string}>('GET','/config/models');
 const release=h.runtime.admission.reserve('broker');
 try {
  const blocked=await h.request('PUT','/config/models',{expected:before.body.content,content:'{"providers":{}}'});
  expect(blocked.status).toBe(409);
  expect((await h.request<{content:string}>('GET','/config/models')).body.content).toBe(before.body.content);
 } finally {release();}
 const own=h.runtime.admitMutation();
 try {
  expect((await h.request('PUT','/config/models',{expected:before.body.content,content:'{"providers":{}}'})).status).toBe(200);
  const another=h.runtime.admitMutation();
  try{expect((await h.request('PUT','/config/models',{expected:'{"providers":{}}',content:'{}'})).status).toBe(409);}
  finally{another();}
  expect((await h.request('PUT','/config/models',{expected:'stale',content:'{}'})).status).toBe(409);
 } finally {own();}
});
