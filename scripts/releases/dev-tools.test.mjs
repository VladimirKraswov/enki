import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {checkedDownload} from '../dev-tools.mjs';
const digest=v=>crypto.createHash('sha256').update(v).digest('hex');
test('a pinned tool is verified before promotion and a valid cache needs no network',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'enki-dev-tools-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'tool.zip'),body=Buffer.from('pinned archive');let calls=0;
 const fetcher=async()=>{calls++;return new Response(body);};
 await checkedDownload('https://example.invalid/tool',file,digest(body),fetcher);
 await checkedDownload('https://example.invalid/tool',file,digest(body),fetcher);
 assert.equal(calls,1);assert.deepEqual(fs.readFileSync(file),body);
});
test('a corrupt download cannot replace a prior cache or reach extraction',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'enki-dev-tools-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'tool.zip');fs.writeFileSync(file,'old cache');
 await assert.rejects(checkedDownload('https://example.invalid/tool',file,digest('expected'),async()=>new Response('tampered')),/SHA256/);
 assert.equal(fs.readFileSync(file,'utf8'),'old cache');assert.deepEqual(fs.readdirSync(root),['tool.zip']);
 await assert.rejects(checkedDownload('http://example.invalid/tool',file,digest('expected')),/HTTPS/);
});
