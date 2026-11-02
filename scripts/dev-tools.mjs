#!/usr/bin/env node
// Project-local build tools; no shell profiles, global npm, Git, CLI installs,
// provider settings or user databases are changed by setup/run.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(import.meta.dirname,'..'),tools=path.join(root,'.local/tools');
const runtime=JSON.parse(fs.readFileSync(path.join(root,'src-tauri/resources/agent/runtime-lock.json')));
const contract=JSON.parse(fs.readFileSync(path.join(root,'scripts/dev-tools.json')));
const platform=process.platform+'-'+process.arch;
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(program,args,options={}){
 const r=spawnSync(program,args,{cwd:root,stdio:'inherit',shell:false,timeout:40*60_000,...options});
 if(r.error)throw r.error;
 if(r.status!==0)throw Error(`Build command failed (${r.status ?? r.signal})`);
}
function directory(dir){
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 if(!fs.lstatSync(dir).isDirectory()||fs.lstatSync(dir).isSymbolicLink())throw Error('Tool directory must be owned and link-free');
}
export async function checkedDownload(url,file,expected,fetcher=fetch){
 if(!/^[a-f0-9]{64}$/.test(expected)||!url.startsWith('https://'))throw Error('Pinned HTTPS download required');
 if(fs.existsSync(file)&&sha(file)===expected)return;
 const response=await fetcher(url,{signal:AbortSignal.timeout(120_000)});
 if(!response.ok||!response.body)throw Error('Tool download failed');
 const partial=file+'.'+crypto.randomUUID()+'.part';let length=0;
 const fd=fs.openSync(partial,'wx',0o600),hash=crypto.createHash('sha256');
 try{
  for await(const chunk of response.body){length+=chunk.length;if(length>160*1024*1024)throw Error('Tool archive exceeds160MiB');hash.update(chunk);fs.writeFileSync(fd,chunk);}
  if(hash.digest('hex')!==expected)throw Error('Tool archive SHA256 mismatch');
  fs.fsyncSync(fd);
 }catch(e){fs.closeSync(fd);fs.rmSync(partial,{force:true});throw e;}
 fs.closeSync(fd);fs.renameSync(partial,file);
}
async function install(name,spec,url,binaries){
 const dest=path.join(tools,name+'-'+platform),cache=path.join(tools,'cache');directory(cache);
 const archive=path.join(cache,spec.file);
 const prior=path.join(root,'src-tauri/target/enki-agent/cache',spec.file);
 if(!fs.existsSync(archive)&&fs.existsSync(prior)&&sha(prior)===spec.sha256)fs.copyFileSync(prior,archive);
 await checkedDownload(url,archive,spec.sha256);
 const stage=fs.mkdtempSync(path.join(tools,'.stage-'));
 try{
  const tar=process.platform==='win32'?path.join(process.env.SystemRoot??'C:\\Windows','System32/tar.exe'):'/usr/bin/tar';
  run(tar,['-xf',archive,'-C',stage],{timeout:120_000});
  const binary=binaries.map(p=>path.join(stage,p)).find(p=>fs.existsSync(p)&&fs.lstatSync(p).isFile());
  if(!binary)throw Error('Pinned tool binary missing');
  if(fs.existsSync(dest)){
   const existing=path.join(dest,path.relative(stage,binary));
   if(!fs.existsSync(existing)||!fs.lstatSync(existing).isFile()||sha(existing)!==sha(binary))throw Error('Tool destination changed; preserve it for inspection');
   return existing;
  }
  fs.renameSync(stage,dest);return path.join(dest,path.relative(stage,binary));
 }finally{fs.rmSync(stage,{recursive:true,force:true});}
}
function checkedReceipt(){
 const r=JSON.parse(fs.readFileSync(path.join(tools,'receipt.json'),'utf8'));
 if(r.schema!==1||r.platform!==platform)throw Error('Run npm run dev:setup for this host');
 for(const key of ['node','gh']){
  if(typeof r[key]?.path!=='string'||!r[key].path.startsWith(tools+path.sep)||!fs.lstatSync(r[key].path).isFile()||sha(r[key].path)!==r[key].sha256)throw Error('Local tool changed; inspect it before rebuilding');
 }
 return r;
}
export async function main(argv){
 const [mode,...args]=argv;
 if(mode==='setup'){
  const node=runtime.node.artifacts[platform],gh=contract.githubCli.artifacts[platform];
  if(!node||!gh)throw Error('Unsupported development host');
  directory(tools);for(const name of ['gh-config','npm-cache','cargo'])directory(path.join(tools,name));
  for(const name of ['empty-user.npmrc','empty-global.npmrc'])if(!fs.existsSync(path.join(tools,name)))fs.writeFileSync(path.join(tools,name),'',{mode:0o600});
  if(fs.existsSync(path.join(tools,'receipt.json'))){const r=checkedReceipt();if(r.node.version===runtime.node.version&&r.gh.version===contract.githubCli.version){console.log('Pinned project tools already verified');return;}}
  const nodePath=await install('node-'+runtime.node.version,node,new URL(node.file,runtime.node.source).href,[node.file.replace(/\.(tar\.(gz|xz)|zip)$/,'')+'/'+node.binary]);
  const ghPath=await install('gh-'+contract.githubCli.version,gh,'https://github.com/cli/cli/releases/download/v'+contract.githubCli.version+'/'+gh.file,
    ['bin/gh'+(process.platform==='win32'?'.exe':''),gh.file.replace(/\.(tar\.gz|zip)$/,'')+'/bin/gh'+(process.platform==='win32'?'.exe':'')]);
  const receipt={schema:1,platform,node:{path:nodePath,version:runtime.node.version,sha256:sha(nodePath)},gh:{path:ghPath,version:contract.githubCli.version,sha256:sha(ghPath)}};
  fs.writeFileSync(path.join(tools,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
  run(nodePath,['--version']);run(ghPath,['--version']);run('cargo',['--version']);run('rustc',['--version']);
  console.log('Project tools installed; GitHub authentication is separate.');return;
 }
 if(mode!=='run'||!args.length)throw Error('Use setup or run COMMAND [ARGS]');
 const r=checkedReceipt(),nodeBin=path.dirname(r.node.path),env={...process.env,
  PATH:[nodeBin,path.dirname(r.gh.path),process.env.PATH].join(path.delimiter),
  GH_CONFIG_DIR:path.join(tools,'gh-config'),CARGO_BUILD_JOBS:'2',CARGO_HOME:path.join(tools,'cargo'),
  npm_config_cache:path.join(tools,'npm-cache'),npm_config_userconfig:path.join(tools,'empty-user.npmrc'),npm_config_globalconfig:path.join(tools,'empty-global.npmrc'),
  NODE_OPTIONS:process.env.NODE_OPTIONS??'--max-old-space-size=768'};
 delete env.NODE_PATH;
 if(!env.ENKI_HUB_DEVICE_CONFIG&&fs.existsSync(path.join(root,'.local/workshop/device.json')))env.ENKI_HUB_DEVICE_CONFIG=path.join(root,'.local/workshop/device.json');
 const [command,...rest]=args;
 if(command==='npm'){
  const home=process.platform==='win32'?nodeBin:path.dirname(nodeBin);
  run(r.node.path,[path.join(home,process.platform==='win32'?'node_modules/npm/bin/npm-cli.js':'lib/node_modules/npm/bin/npm-cli.js'),...rest],{env});
 }else run(command==='node'?r.node.path:command==='gh'?r.gh.path:command,rest,{env});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
