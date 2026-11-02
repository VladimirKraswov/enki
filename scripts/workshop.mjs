#!/usr/bin/env node
// Explicit, cross-platform owner-device exchange. No automatic checkout,
// execution, release, task dispatch or acknowledgement of received messages.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {snapshotGit, safePath} from './releases/packet.mjs';
import {deviceTransport} from './releases/device.mjs';

const excluded = name => name.split('/').some(p => ['.git','.local','.pi','node_modules','target'].includes(p) || p.startsWith('.env'));
function readJson(file){
 const resolved=path.resolve(file),stat=fs.lstatSync(resolved);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw Error('Expected a regular JSON file up to2MiB');
 const bytes=fs.readFileSync(resolved);if(bytes.length>2*1024*1024)throw Error('JSON grew beyond its bound');
 return JSON.parse(bytes);
}
export function prepareChange(root, base, {agent,session,summary='',requestId=crypto.randomUUID()} = {}) {
  const git = args => execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024});
  const baseCommit=git(['rev-parse','--verify','--end-of-options',base+'^{commit}']).trim();
  const commit=git(['rev-parse','HEAD']).trim();
  git(['merge-base','--is-ancestor',baseCommit,commit]);
  const names=git(['diff','--name-only','-z',baseCommit,commit,'--']).split('\0').filter(n=>n&&!excluded(n));
  if(!names.length||names.length>200||names.some(n=>!safePath(n)))throw Error('Expected1–200 safe committed paths');
  const present=new Set(git(['ls-tree','-r','--name-only','-z','HEAD']).split('\0'));
  const blobs=snapshotGit(root,names.filter(n=>present.has(n)));
  const files=Object.fromEntries(names.map(n=>[n,present.has(n)?blobs[n]:null]));
  if(Object.values(files).reduce((n,v)=>n+(v?Buffer.from(v,'base64').length:0),0)>1024*1024)throw Error('Change exceeds1MiB; split the commit');
  return {requestId,agent,session,baseCommit,commit,summary,files};
}

export async function main(argv, root=path.resolve(import.meta.dirname,'..'), transport) {
  const [command,...rest]=argv, opts={};
  for(let i=0;i<rest.length;i+=2){if(!rest[i].startsWith('--')||!rest[i+1]||rest[i+1].startsWith('--'))throw Error('Use --option value');opts[rest[i].slice(2)]=rest[i+1];}
  if(!['status','changes','change','inbox','messages','logs','push','submit','retry'].includes(command))throw Error('Use status|changes|change|inbox|messages|logs|push|submit|retry. See docs/WORKSHOP-EXCHANGE.md');
  let route,body,savedOrigin;
  if(command==='retry'){
    const saved=readJson(opts.file);route=saved.route;body=saved.body;savedOrigin=saved.origin;
  } else if(command==='push'){
    if(!opts.base||!opts.agent||!opts.session)throw Error('push requires --base, --agent and --session');
    route='changes';body=prepareChange(root,opts.base,{agent:opts.agent,session:opts.session,summary:opts.summary,requestId:opts['request-id']});
  } else if(command==='submit'){
    if(!['messages','logs','ack'].includes(opts.kind)||!opts.file)throw Error('submit requires --kind messages|logs|ack and --file JSON');
    route=opts.kind;body=readJson(opts.file);
    if(route!=='ack'&&!body.requestId)body.requestId=crypto.randomUUID();
  } else if(command==='change'){
    if(!/^[a-f0-9]{64}$/.test(opts.id??'')||!opts.out)throw Error('change requires --id SHA256 and --out JSON');
    route='changes/'+opts.id;
  } else {
    route=command;
    const query=new URLSearchParams();
    for(const k of ['agent','session','device','operation','after','limit'])if(opts[k])query.set(k,opts[k]);
    if(query.size)route+='?'+query;
  }
  if(!/^(?:status|changes(?:\/[a-f0-9]{64})?|inbox|messages|logs|ack)(?:\?[^#\r\n]*)?$/.test(route))throw Error('Invalid workshop route');
  const privateConfig=path.join(root,'.local/workshop/device.json');
  transport??=deviceTransport({configFile:process.env.ENKI_HUB_DEVICE_CONFIG??(fs.existsSync(privateConfig)?privateConfig:undefined)});
  const origin=await transport.identity();
  if(!/^[a-f0-9]{64}$/.test(origin)||command==='retry'&&savedOrigin!==origin)throw Error('Hub or device changed; saved request was not sent');
  if(body){
    const outbox=path.join(root,'.local/workshop/outbox');fs.mkdirSync(outbox,{recursive:true,mode:0o700});
    const id=crypto.createHash('sha256').update(JSON.stringify({origin,route,body})).digest('hex');
    const file=path.join(outbox,id+'.json'),serialized=JSON.stringify({origin,route,body},null,2)+'\n';
    if(fs.existsSync(file)){
      if(fs.lstatSync(file).isSymbolicLink()||fs.readFileSync(file,'utf8')!==serialized)throw Error('Saved request was replaced');
    }else{
      const fd=fs.openSync(file,'wx',0o600);
      try{fs.writeFileSync(fd,serialized);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    }
    process.stderr.write('Durable request: '+file+'\n');
  }
  const response=await transport.workshop(route,body);
  if(command==='change')fs.writeFileSync(path.resolve(opts.out),JSON.stringify(response,null,2)+'\n',{mode:0o600,flag:'wx'});
  return response;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main(process.argv.slice(2)).then(r=>process.stdout.write(JSON.stringify(r,null,2)+'\n'),()=>{process.stderr.write('Workshop exchange failed. No delivery is claimed. Retry the saved request with the same ID; see docs/WORKSHOP-EXCHANGE.md.\n');process.exitCode=1;});
}
