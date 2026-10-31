// Publish with a paired device identity. No release signing/admin key on clients.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import https from 'node:https';
import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {snapshot,snapshotGit,nativeFingerprint,validateVersions,hash} from './packet.mjs';import {privateFile} from './operator.mjs';
export const CHECKS=['frontend','build','architecture','bundle','publisher','hub','asr','rust-fmt','rust-test','rust-clippy'];
export function verifyEnvelope(envelope,digest,version,wrappedPublic){
 const raw=Buffer.from(envelope.payload,'base64');if(hash(raw)!==digest)throw Error('Downloaded release digest mismatch');
 const pub=Buffer.from(Buffer.from(wrappedPublic.trim(),'base64').toString().trim().split('\n')[1],'base64');
 const lines=Buffer.from(envelope.signature,'base64').toString().trim().split('\n');const sig=Buffer.from(lines[1]??'','base64');
 if(pub.length!==42||pub.subarray(0,2).toString()!=='Ed'||sig.length!==74||!pub.subarray(2,10).equals(sig.subarray(2,10))||!lines[2]?.startsWith('trusted comment: '))throw Error('Invalid release signature');
 const comment=lines[2].slice('trusted comment: '.length);if(!comment.split('\t').includes('version:'+version))throw Error('Signed version mismatch');
 const key=crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),pub.subarray(10)]),format:'der',type:'spki'});
 const algo=sig.subarray(0,2).toString();const message=algo==='ED'?crypto.createHash('blake2b512').update(raw).digest():algo==='Ed'?raw:null;
 if(!message||!crypto.verify(null,message,key,sig.subarray(10))||!crypto.verify(null,Buffer.concat([sig.subarray(10),Buffer.from(comment)]),key,Buffer.from(lines[3]??'','base64')))throw Error('Release signature verification failed');
 return JSON.parse(raw);
}
export function deviceTransport(){
 if(process.env.ENKI_HUB_DEVICE_CONFIG){
  const cfg=JSON.parse(privateFile(process.env.ENKI_HUB_DEVICE_CONFIG));const origin=new URL(cfg.endpoint);
  if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw Error('Device Hub requires HTTPS origin');
  const key=privateFile(cfg.keyFile).trim(),ca=fs.readFileSync(cfg.certificateFile);if(key.length<20||key.length>256||/[\r\n]/.test(key))throw Error('Invalid device key');
  const request=(route,body)=>new Promise((resolve,reject)=>{
   const raw=body?Buffer.from(JSON.stringify(body)):undefined;
   const q=https.request(new URL(route,origin),{method:raw?'POST':'GET',ca,agent:false,timeout:120000,headers:{Authorization:'Bearer '+key,...(raw?{'Content-Type':'application/json','Content-Length':raw.length}:{})}},r=>{
    let n=0;const parts=[];r.on('data',b=>{n+=b.length;if(n>64*1048576)r.destroy(Error('Hub response too large'));else parts.push(b);});r.on('error',reject);r.on('end',()=>{try{if(r.statusCode!==200)throw Error('Hub HTTP '+r.statusCode+'; publication not confirmed');resolve(JSON.parse(Buffer.concat(parts)));}catch(e){reject(e);}});
   });q.on('error',()=>reject(Error('Hub connection failed; publication not confirmed')));q.on('timeout',()=>q.destroy(Error('Hub timeout')));q.end(raw);
  });
  return {head:channel=>request('/api/updates/enki/'+channel),publish:body=>request('/api/updates/device',body),artifact:digest=>request('/api/updates/artifacts/'+digest)};
 }
 const candidates=[process.env.ENKI_NATIVE_EXECUTABLE,...(process.platform==='darwin'?['/Applications/Enki.app/Contents/MacOS/enki']:process.platform==='win32'?[path.join(process.env.LOCALAPPDATA??'','Enki','enki.exe'),path.join(process.env.LOCALAPPDATA??'','Programs','Enki','enki.exe')]:['/usr/bin/enki','/usr/local/bin/enki'])];
 const exe=candidates.find(p=>p&&path.isAbsolute(p)&&fs.existsSync(p));if(!exe)throw Error('Set ENKI_NATIVE_EXECUTABLE to installed Enki0.2.104+ or configure a paired headless device');
 const call=(...args)=>JSON.parse(execFileSync(exe,args,{encoding:'utf8',maxBuffer:64*1048576,timeout:180000,windowsHide:true}));
 const status=call('--hub-update-status');const v=status.nativeVersion?.split('.').map(Number);if(!v||v.some(x=>!Number.isInteger(x))||v[0]===0&&(v[1]<2||v[1]===2&&v[2]<104))throw Error('Install native Enki0.2.104+ first; device publication is unavailable in older binaries');
 let identity;
 return {head:async channel=>{const r=call('--hub-release','head',channel,identity??'');if(!/^[0-9a-f]{64}$/.test(r.identity)||(identity&&identity!==r.identity))throw Error('Hub profile changed');identity=r.identity;return r.head;},artifact:async digest=>call('--hub-release','artifact',digest,identity),publish:async body=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'enki-device-release-'));fs.chmodSync(dir,0o700);const file=path.join(dir,'candidate.json');
  try{fs.writeFileSync(file,JSON.stringify(body),{mode:0o600});return call('--hub-release','publish',file,identity);}finally{fs.rmSync(dir,{recursive:true,force:true});}
 }};
}
export async function publishDevice(root,channel,transport=deviceTransport()){
 if(!['stable','preview'].includes(channel))throw Error('Use stable or preview');
 if(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim())throw Error('Commit reviewed changes before publication');
 const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;validateVersions(root,version);const fp=nativeFingerprint(path.join(root,'src-tauri'));
 const names=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(n=>n&&!n.startsWith('.pi/')&&!n.startsWith('.local/'));
 const ui=[];function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const q=path.join(p,e.name);if(e.isDirectory())walk(q);else ui.push(path.relative(path.join(root,'dist'),q).split(path.sep).join('/'));}}walk(path.join(root,'dist'));
 const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();const body={channel,expectedRevision:null,validation:{checks:CHECKS,platform:process.platform,commit}};const digests={};
 for(const [kind,files] of [['source',snapshotGit(root,names)],['hot',snapshot(path.join(root,'dist'),ui)]]){const raw=Buffer.from(JSON.stringify({schemaVersion:1,kind,version,nativeFingerprint:fp,notes:'',files}));if(raw.length>24*1048576)throw Error('Encoded release payload too large');body[kind]=raw.toString('base64');digests[kind]=hash(raw);}
 let head=await transport.head(channel);body.expectedRevision=head.revision;
 const matches=h=>h.version===version&&h.nativeFingerprint===fp&&['source','hot'].every(k=>h.artifacts?.[k]?.digest===digests[k]);
 // Identical bytes alone do not prove HEAD is still the published commit: a
 // tracked checkpoint made after publication must fail loudly here instead of
 // rewriting the receipt over an immutable Hub publication or dispatching a
 // commit that CI will refuse (published_commit must equal github.sha).
 const publishedCommit=head.publication?.commit;
 if(matches(head)&&publishedCommit&&publishedCommit!==commit)
  throw Error(`Enki ${version} is already published from commit ${publishedCommit}, HEAD is ${commit}. Final tracked docs and checkpoints must be committed before release:local (operational summaries belong in .local); the Hub release stays immutable.`);
 if(!matches(head)){
  try{await transport.publish(body);}catch(error){head=await transport.head(channel);if(!matches(head))throw error;}
  head=await transport.head(channel);
 }
 if(!matches(head))throw Error('Hub head does not contain this build');
 const finalCommit=head.publication?.commit;
 if(finalCommit&&finalCommit!==commit)throw Error(`Hub published Enki ${version} from commit ${finalCommit}, not the verified HEAD ${commit}; no receipt was written.`);
 const publicKey=fs.readFileSync(path.join(root,'src-tauri/updater.pub'),'utf8');
 for(const kind of ['source','hot']){const envelope=await transport.artifact(digests[kind]);const packet=verifyEnvelope(envelope,digests[kind],version,publicKey);if(packet.kind!==kind||packet.nativeFingerprint!==fp||envelope.payload!==body[kind])throw Error('Hub served different release bytes');}
 const receipt={...head,channel,commit,verifiedAt:new Date().toISOString(),publication:'paired-device',...(finalCommit?{publishedCommit:finalCommit}:{})};const receipts=path.join(root,'.local/releases');fs.mkdirSync(receipts,{recursive:true,mode:0o700});fs.writeFileSync(path.join(receipts,version+'-'+channel+'.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
 console.log('Verified Enki '+version+' via paired device: Hub head, both exact packets and pinned signatures.');return receipt;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await publishDevice(path.resolve(import.meta.dirname,'../..'),process.argv[2]??'stable');}catch(e){console.error(e.message);process.exitCode=1;}
}
