import test from 'node:test';import assert from 'node:assert/strict';
import {packageManifest,publishPackages,missingAssets} from './github-packages.mjs';import {hash} from './packet.mjs';
const identity={version:'2.0.6',commit:'a'.repeat(40),fingerprint:'f'.repeat(64),runId:71};
const fixture=()=>[['macos','arm64','aarch64.dmg'],['windows','x64','x64-setup.exe'],['linux','x64','amd64.deb']].map(([platform,arch,tail])=>{
 const bytes=Buffer.alloc(2048,platform.length);return {bytes,receipt:{schema:1,version:identity.version,commit:identity.commit,nativeFingerprint:identity.fingerprint,runId:71,platform,arch,artifact:'Enki_2.0.6_'+tail,bytes:bytes.length,sha256:hash(bytes),liveAcceptance:'not-run'}};
});
test('all three exact packages produce immutable links with checksums',()=>{
 const m=packageManifest(fixture(),identity);assert.equal(Object.keys(m.packages).length,3);assert.equal(m.packages['windows-x64'].url,'https://github.com/VladimirKraswov/enki/releases/download/v2.0.6/Enki_2.0.6_x64-setup.exe');
});
test('different head, workflow, fingerprint, missing platforms or damaged bytes cannot publish',()=>{
 for(const [key,value] of [['commit','b'.repeat(40)],['runId',72],['nativeFingerprint','b'.repeat(64)],['artifact','../Enki_2.0.6_x.dmg'],['liveAcceptance','passed']]){const f=fixture();f[0].receipt[key]=value;assert.throws(()=>packageManifest(f,identity));}
 const f=fixture();f[0].bytes[0]^=1;assert.throws(()=>packageManifest(f,identity));assert.throws(()=>packageManifest(fixture().slice(0,2),identity));assert.throws(()=>packageManifest([...fixture(),fixture()[0]],identity));
});
test('push/PR or a different published commit cannot start publication',()=>{
 for(const env of [{},{GITHUB_REPOSITORY:'VladimirKraswov/enki',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'push'},{GITHUB_REPOSITORY:'VladimirKraswov/enki',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',ENKI_PUBLISHED_COMMIT:'b'.repeat(40),GITHUB_SHA:'a'.repeat(40)}])assert.throws(()=>publishPackages('/not-read',env,()=>assert.fail('must not publish')),/post-Hub dispatch/);
});
test('an exact interrupted draft resumes only missing assets; published or changed bytes are never replaced',()=>{
 const expected=new Map([['one',{bytes:2,sha256:'a'.repeat(64)}],['two',{bytes:3,sha256:'b'.repeat(64)}]]);
 const release={draft:true,target_commitish:identity.commit,assets:[{name:'one',size:2,digest:'sha256:'+'a'.repeat(64),state:'uploaded'}]};
 assert.deepEqual(missingAssets(release,expected,identity.commit),['two']);
 assert.throws(()=>missingAssets({...release,draft:false},expected,identity.commit));
 assert.throws(()=>missingAssets({...release,target_commitish:'x'},expected,identity.commit));
 assert.throws(()=>missingAssets({...release,assets:[{...release.assets[0],size:4}]},expected,identity.commit));
 assert.throws(()=>missingAssets({...release,draft:false},expected,identity.commit,true));
 assert.deepEqual(missingAssets({...release,draft:false},new Map([['one',expected.get('one')]]),identity.commit,true),[]);
});

import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {nativeFingerprint} from './packet.mjs';
test('publication verifies the uploaded draft through the authenticated list before exposing it',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'enki-draft-'));const version=JSON.parse(fs.readFileSync('package.json')).version;
 const commit='a'.repeat(40),fp=nativeFingerprint('src-tauri');let created=false,published=false,assets=[];
 try {
  for(const [i,item] of fixture().entries()){
   const dir=path.join(root,String(i));fs.mkdirSync(dir);item.receipt.version=version;item.receipt.artifact=item.receipt.artifact.replace('2.0.6',version);item.receipt.nativeFingerprint=fp;
   fs.writeFileSync(path.join(dir,item.receipt.artifact),item.bytes);fs.writeFileSync(path.join(dir,'ci-artifacts.json'),JSON.stringify(item.receipt));
  }
  const env={GITHUB_REPOSITORY:'VladimirKraswov/enki',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',ENKI_PUBLISHED_COMMIT:commit,GITHUB_SHA:commit,GITHUB_RUN_ID:'71'};
  publishPackages(root,env,(_command,args)=>{
   if(args[0]==='api'){assert.ok(args[1].endsWith('/releases?per_page=100'),'tag endpoint returns 404 for drafts');return JSON.stringify(created?[{tag_name:'v'+version,draft:true,target_commitish:commit,assets}]:[]);}
   if(args[1]==='create'){created=true;assets=args.slice(3,args.indexOf('--repo')).map(file=>{const bytes=fs.readFileSync(file);return {name:path.basename(file),size:bytes.length,digest:'sha256:'+hash(bytes),state:'uploaded'};});return '';}
   assert.equal(args[1],'edit');assert.ok(created);published=true;return '';
  });
  assert.ok(published);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
