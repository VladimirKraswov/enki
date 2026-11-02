import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepareChange,main} from '../workshop.mjs';
const identity=async()=>'a'.repeat(64);

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'enki-workshop-test-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
 fs.writeFileSync(path.join(root,'change.ts'),'old\n');fs.writeFileSync(path.join(root,'remove.ts'),'remove\n');
 git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
 fs.writeFileSync(path.join(root,'change.ts'),'committed\n');fs.unlinkSync(path.join(root,'remove.ts'));
 fs.mkdirSync(path.join(root,'.pi'));fs.writeFileSync(path.join(root,'.pi','TASK.md'),'private checkpoint');
 git('add','-A');git('commit','-qm','change');
 return {root,base,git};
}
test('source exchange sends committed bytes and deletions, excludes private checkpoints and leaves working changes intact',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.root,'change.ts'),'uncommitted experiment');
 const candidate=prepareChange(f.root,f.base,{agent:'workshop',session:'s',requestId:'stable-id'});
 assert.equal(Buffer.from(candidate.files['change.ts'],'base64').toString(),'committed\n');
 assert.equal(candidate.files['remove.ts'],null);assert.equal(candidate.files['.pi/TASK.md'],undefined);
 assert.equal(candidate.commit,f.git('rev-parse','HEAD'));
 assert.equal(fs.readFileSync(path.join(f.root,'change.ts'),'utf8'),'uncommitted experiment');
});
test('a lost response leaves a private request that retries the exact logical mutation',async t=>{
 const f=fixture(t);let sent;
 await assert.rejects(main(['push','--base',f.base,'--agent','workshop','--session','s'],f.root,{identity,workshop:async(route,body)=>{sent={origin:await identity(),route,body};throw Error('lost response');}}));
 const dir=path.join(f.root,'.local/workshop/outbox'),file=path.join(dir,fs.readdirSync(dir)[0]);
 assert.deepEqual(JSON.parse(fs.readFileSync(file)),sent);
 let sentToOther=false;
 await assert.rejects(main(['retry','--file',file],f.root,{identity:async()=>'b'.repeat(64),workshop:async()=>{sentToOther=true;}}),/Hub or device changed/);
 assert.equal(sentToOther,false);
 const result=await main(['retry','--file',file],f.root,{identity,workshop:async(route,body)=>{assert.deepEqual({origin:await identity(),route,body},sent);return {accepted:true};}});
 assert.equal(result.accepted,true);
 if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o077,0);
});
test('received source remains a JSON review artifact and cannot overwrite an existing path',async t=>{
 const f=fixture(t),out=path.join(f.root,'.local','received.json');fs.mkdirSync(path.dirname(out));
 const data={payload:{files:{'change.ts':Buffer.from('received').toString('base64')}}};
 const transport={identity,workshop:async()=>data};
 await main(['change','--id','a'.repeat(64),'--out',out],f.root,transport);
 assert.deepEqual(JSON.parse(fs.readFileSync(out)),data);
 assert.equal(fs.readFileSync(path.join(f.root,'change.ts'),'utf8'),'committed\n');
 await assert.rejects(main(['change','--id','a'.repeat(64),'--out',out],f.root,transport));
});
