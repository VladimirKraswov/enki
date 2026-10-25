// Builds reviewed source + UI, signs both with the existing offline release key,
// then publishes by compare-and-swap. No token/key is accepted on the command line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {assertSignedForClients,publishAndVerify} from './verify.mjs';
import {nativeFingerprint,snapshot,snapshotGit,hash,validateVersions} from './packet.mjs';
const root=path.resolve(import.meta.dirname,'../..');
const channel=process.argv[2]??'stable';if(!['stable','preview'].includes(channel))throw Error('Use stable or preview');
const run=(program,args)=>execFileSync(program,args,{cwd:root,stdio:'inherit',timeout:40*60000});
if(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim())throw Error('Commit reviewed changes before publishing');
const setting=name=>process.env['ENKI_'+name]??process.env['ARVELA_'+name];
const endpoint=new URL(setting('HUB_URL')??'');
if(endpoint.protocol!=='https:'||endpoint.pathname!=='/'||endpoint.search||endpoint.hash||endpoint.username||endpoint.password)throw Error('ENKI_HUB_URL must be an HTTPS origin');
if(!setting('HUB_ADMIN_TOKEN')||!process.env.TAURI_SIGNING_PRIVATE_KEY_PATH)throw Error('Provide ENKI_HUB_ADMIN_TOKEN and TAURI_SIGNING_PRIVATE_KEY_PATH in the environment');
const ca=setting('HUB_CA_FILE')?fs.readFileSync(setting('HUB_CA_FILE')):undefined;
function request(method,route,body,limit=65536){return new Promise((resolve,reject)=>{
  const data=body?Buffer.from(JSON.stringify(body)):undefined;
  const req=https.request(new URL(route,endpoint),{method,ca,agent:false,timeout:120000,headers:{Authorization:`Bearer ${setting('HUB_ADMIN_TOKEN')}`,...(data?{'Content-Type':'application/json','Content-Length':data.length}:{})}},r=>{
    let size=0;const chunks=[];r.on('data',b=>{size+=b.length;if(size>limit)r.destroy(Error('Hub response too large'));else chunks.push(b);});r.on('error',reject);r.on('end',()=>{if(r.statusCode<200||r.statusCode>=300)return reject(Error(`Hub HTTP ${r.statusCode}`));try{resolve(JSON.parse(Buffer.concat(chunks)));}catch(e){reject(e);}});
  });req.on('timeout',()=>req.destroy(Error('Hub timeout')));req.on('error',reject);req.end(data);
});}
run(process.execPath,['node_modules/typescript/bin/tsc']);run(process.execPath,['node_modules/vite/bin/vite.js','build']);
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;
validateVersions(root,version);
const fp=nativeFingerprint(path.join(root,'src-tauri'));
const sourceNames=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(n=>n&&!n.startsWith('.pi/')&&!n.startsWith('.local/'));
const uiNames=[];function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const q=path.join(p,e.name);if(e.isDirectory())walk(q);else uiNames.push(path.relative(path.join(root,'dist'),q).split(path.sep).join('/'));}}walk(path.join(root,'dist'));
const work=fs.mkdtempSync(path.join(os.tmpdir(),'enki-publish-'));fs.chmodSync(work,0o700);
try{
  const envelopes={};for(const [kind,files]of [['hot',snapshot(path.join(root,'dist'),uiNames)],['source',snapshotGit(root,sourceNames)]]){
    const payload=Buffer.from(JSON.stringify({schemaVersion:1,kind,version,nativeFingerprint:fp,notes:setting('RELEASE_NOTES')??'',files}));
    if(payload.length>24*1048576)throw Error('Encoded payload exceeds limit');
    const file=path.join(work,`${kind}.json`);fs.writeFileSync(file,payload,{mode:0o600});
    run(process.execPath,['node_modules/@tauri-apps/cli/tauri.js','signer','sign','--private-key-path',process.env.TAURI_SIGNING_PRIVATE_KEY_PATH,'--app-version',version,file]);
    envelopes[kind]={payload:payload.toString('base64'),signature:fs.readFileSync(file+'.sig','utf8').trim()};
    console.log(`${kind}: ${payload.length} bytes, SHA256 ${hash(payload)}`);
  }
  // Nothing is sent unless clients would accept both signatures.
  assertSignedForClients(envelopes,{version,nativeFingerprint:fp},fs.readFileSync(path.join(root,'src-tauri/updater.pub'),'utf8'));
  const current=await request('GET',`/api/updates/enki/${channel}`);
  const receipt=await publishAndVerify(
    ()=>request('POST','/api/updates',{channel,expectedRevision:current.revision,...envelopes}),
    ()=>request('GET',`/api/updates/enki/${channel}`),
    {version,nativeFingerprint:fp},envelopes,
    digest=>request('GET',`/api/updates/artifacts/${digest}`,undefined,40*1048576));
  const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const receipts=path.join(root,'.local','releases');fs.mkdirSync(receipts,{recursive:true,mode:0o700});
  const file=path.join(receipts,`${version}-${channel}.json`);
  fs.writeFileSync(file,JSON.stringify({...receipt,channel,commit,verifiedAt:new Date().toISOString()},null,2)+'\n',{mode:0o600});
  console.log(`Verified Enki ${receipt.version} on Hub/${channel}: head + both downloadable signed packets. Receipt: ${path.relative(root,file)}`);
}finally{fs.rmSync(work,{recursive:true,force:true});}
