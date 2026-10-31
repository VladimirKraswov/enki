import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {verifyEnvelope} from './device.mjs';import {hash} from './packet.mjs';
function fixture(version='1.2.3'){
 const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');const id=crypto.randomBytes(8),bytes=Buffer.from('{"kind":"hot"}');
 const pub=Buffer.concat([Buffer.from('Ed'),id,publicKey.export({format:'der',type:'spki'}).subarray(-32)]);
 const sig=crypto.sign(null,crypto.createHash('blake2b512').update(bytes).digest(),privateKey),packet=Buffer.concat([Buffer.from('ED'),id,sig]);const comment='timestamp:1\tversion:'+version;
 const text='untrusted comment: fixture\n'+packet.toString('base64')+'\ntrusted comment: '+comment+'\n'+crypto.sign(null,Buffer.concat([sig,Buffer.from(comment)]),privateKey).toString('base64')+'\n';
 return {envelope:{payload:bytes.toString('base64'),signature:Buffer.from(text).toString('base64')},digest:hash(bytes),pub:Buffer.from('untrusted comment: fixture\n'+pub.toString('base64')+'\n').toString('base64')};
}
test('paired-device publisher verifies pinned minisign signature, bytes and version',()=>{
 const f=fixture();assert.equal(verifyEnvelope(f.envelope,f.digest,'1.2.3',f.pub).kind,'hot');
 assert.throws(()=>verifyEnvelope(f.envelope,f.digest,'1.2.4',f.pub));
 const altered={...f.envelope,payload:Buffer.from('{}').toString('base64')};assert.throws(()=>verifyEnvelope(altered,hash(Buffer.from('{}')),'1.2.3',f.pub));
 assert.throws(()=>verifyEnvelope(f.envelope,f.digest,'1.2.3',fixture().pub));
});
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {publishDevice} from './device.mjs';
function repository(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'enki-device-test-'));const keys=crypto.generateKeyPairSync('ed25519'),id=crypto.randomBytes(8);
 const pub=Buffer.concat([Buffer.from('Ed'),id,keys.publicKey.export({format:'der',type:'spki'}).subarray(-32)]);
 const wrapped=Buffer.from('untrusted comment: fixture\n'+pub.toString('base64')+'\n').toString('base64');
 const put=(name,value)=>{const p=path.join(root,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,value);};
 put('.gitignore','dist/\n.local/\n');put('package.json',JSON.stringify({version:'1.2.3'}));put('package-lock.json',JSON.stringify({version:'1.2.3',packages:{'':{version:'1.2.3'}}}));
 put('src-tauri/tauri.conf.json',JSON.stringify({version:'1.2.3',identifier:'dev.local.opencodedesktop',productName:'Enki'}));put('src-tauri/updater.pub',wrapped);
 put('src-tauri/Cargo.toml','[package]\nname = "enki"\nversion = "1.2.3"\n');put('src-tauri/Cargo.lock','[[package]]\nname = "enki"\nversion = "1.2.3"\n');put('dist/index.html','UI');
 const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:'pipe'});git('init','-q');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
 const sign=payload=>{const raw=Buffer.from(payload,'base64'),sig=crypto.sign(null,crypto.createHash('blake2b512').update(raw).digest(),keys.privateKey),packet=Buffer.concat([Buffer.from('ED'),id,sig]),comment='timestamp:1\tversion:1.2.3';return {payload,signature:Buffer.from('untrusted comment: fixture\n'+packet.toString('base64')+'\ntrusted comment: '+comment+'\n'+crypto.sign(null,Buffer.concat([sig,Buffer.from(comment)]),keys.privateKey).toString('base64')+'\n').toString('base64')};};
 return {root,sign};
}
test('device publication recovers lost acknowledgment once, verifies both packets, and writes receipt only on success',async()=>{
 const f=repository();let head={available:false,revision:null},posts=0;const packets={};
 const transport={head:async()=>head,publish:async body=>{posts++;const p=JSON.parse(Buffer.from(body.source,'base64'));head={available:true,version:p.version,nativeFingerprint:p.nativeFingerprint,revision:'r1',artifacts:{}};for(const kind of ['source','hot']){const digest=hash(Buffer.from(body[kind],'base64'));packets[digest]=f.sign(body[kind]);head.artifacts[kind]={digest};}throw Error('lost acknowledgment');},artifact:async digest=>packets[digest]};
 try{
  const receipt=await publishDevice(f.root,'stable',transport);assert.equal(posts,1);assert.equal(receipt.version,'1.2.3');assert(fs.existsSync(path.join(f.root,'.local/releases/1.2.3-stable.json')));
  await publishDevice(f.root,'stable',transport);assert.equal(posts,1);
  fs.rmSync(path.join(f.root,'.local/releases'),{recursive:true});transport.artifact=async()=>({payload:'e30=',signature:''});
  await assert.rejects(publishDevice(f.root,'stable',transport));assert(!fs.existsSync(path.join(f.root,'.local/releases/1.2.3-stable.json')));assert.equal(posts,1);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

import {snapshotGit,validateVersions} from './packet.mjs';
test('a tracked checkpoint made after publication fails loudly and never rewrites the immutable receipt',async()=>{
 const f=repository();let head={available:false,revision:null},posts=0;const packets={};
 const sha=()=>execFileSync('git',['rev-parse','HEAD'],{cwd:f.root,encoding:'utf8'}).trim();
 const transport={head:async()=>head,publish:async body=>{posts++;const p=JSON.parse(Buffer.from(body.source,'base64'));
  head={available:true,version:p.version,nativeFingerprint:p.nativeFingerprint,revision:'r1',artifacts:{},publication:{device:'fixture',commit:sha(),platform:'darwin',checks:'device-attested'}};
  for(const kind of ['source','hot']){const digest=hash(Buffer.from(body[kind],'base64'));packets[digest]=f.sign(body[kind]);head.artifacts[kind]={digest};}
 },artifact:async digest=>packets[digest]};
 try{
  const first=await publishDevice(f.root,'stable',transport);assert.equal(posts,1);assert.equal(first.publishedCommit,sha());
  const receiptFile=path.join(f.root,'.local/releases/1.2.3-stable.json');const before=fs.readFileSync(receiptFile,'utf8');
  // Same release bytes, but HEAD now carries a later tracked checkpoint.
  fs.mkdirSync(path.join(f.root,'.pi'),{recursive:true});fs.writeFileSync(path.join(f.root,'.pi/TASK.md'),'checkpoint\n');
  execFileSync('git',['add','.'],{cwd:f.root});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','checkpoint'],{cwd:f.root});
  await assert.rejects(()=>publishDevice(f.root,'stable',transport),/already published from commit [0-9a-f]{40}/);
  assert.equal(posts,1);assert.equal(fs.readFileSync(receiptFile,'utf8'),before);
  assert.equal(JSON.parse(before).commit,JSON.parse(before).publishedCommit);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('Windows CRLF checkouts preserve manifest validation and canonical committed source bytes',()=>{
 const f=repository();try{
  execFileSync('git',['config','core.autocrlf','true'],{cwd:f.root});
  for(const n of ['src-tauri/Cargo.toml','src-tauri/Cargo.lock']){const file=path.join(f.root,n);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replaceAll('\n','\r\n'));}
  validateVersions(f.root,'1.2.3');
  const files=snapshotGit(f.root,['src-tauri/Cargo.toml','src-tauri/Cargo.lock']);
  for(const n of Object.keys(files)){const canonical=execFileSync('git',['show','HEAD:'+n],{cwd:f.root});assert(Buffer.from(files[n],'base64').equals(canonical));assert(!canonical.includes(Buffer.from('\r\n')));}
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
