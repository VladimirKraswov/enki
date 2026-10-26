// Explicit acceptance with a disposable local Hub and the real pinned compiler
// wrapper. No user vault, model, UI or production services are accessed.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
import {once} from 'node:events';import {promisify} from 'node:util';import {execFile} from 'node:child_process';const exec=promisify(execFile);import {withBuildCache} from './client.mjs';
const root=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'enki-cache-acceptance-'));
const fixture=path.join(root,'fixture.py');
const service=path.resolve('services/hub/server.py');
const toolArchive=process.argv[2] === '--tool-archive' ? path.resolve(process.argv[3]) : undefined;
fs.writeFileSync(fixture,`import importlib.util, json, ssl, subprocess, sys\nfrom pathlib import Path\np=Path(sys.argv[1]);spec=importlib.util.spec_from_file_location('hub',sys.argv[2]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nh=m.Hub(p/'db');a=h.provision('cache-acceptance','macos');actor=h.authenticate(a['token']);grant=h.build_cache.lease(actor,sys.argv[3]);grant2=h.build_cache.lease(actor,sys.argv[3])\nsubprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1','-keyout',str(p/'key'),'-out',str(p/'cert')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\ns=m.Server(('127.0.0.1',0),h,Path(sys.argv[2]).parent/'web');ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(p/'cert',p/'key');s.socket=ctx.wrap_socket(s.socket,server_side=True,do_handshake_on_connect=False)\n(p/'config.json').write_text(json.dumps({'endpoint':'https://127.0.0.1:'+str(s.server_port),'certificate':(p/'cert').read_text(),'platform':sys.argv[3],'token':grant['token']}));(p/'config2.json').write_text(json.dumps({'endpoint':'https://127.0.0.1:'+str(s.server_port),'certificate':(p/'cert').read_text(),'platform':sys.argv[3],'token':grant2['token']}));print('ready',flush=True);s.serve_forever()\n`);
const hub=spawn('python3',[fixture,root,service,`${process.platform}-${process.arch}`],{stdio:['ignore','pipe','inherit']});
let info='';hub.stdout.on('data',chunk=>{info+=chunk;});
try {
 const start=Date.now();while(!info.includes('ready')&&Date.now()-start<15000)await new Promise(r=>setTimeout(r,50));if(!info.includes('ready'))throw Error('Fixture startup failed');
 const results=[];
 for(const attempt of [1,2]) {
  const repo=path.join(root,'build-'+attempt);fs.mkdirSync(repo);fs.mkdirSync(path.join(repo,'src'));fs.writeFileSync(path.join(repo,'Cargo.toml'),'[package]\nname="cache_probe"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nitoa="=1.0.18"\n');fs.writeFileSync(path.join(repo,'src/lib.rs'),'pub fn format(n:u64)->String { itoa::Buffer::new().format(n).to_owned() }\n');
  const env={...process.env,ENKI_BUILD_CACHE_CONFIG:path.join(root,attempt===1?'config.json':'config2.json')};
  await withBuildCache({repo,env,toolArchive,log:console.log,observe:v=>{if(v.error)console.error(v);}},async e=>{
   if(!e.RUSTC_WRAPPER)throw Error('Cache was not enabled');
   await exec('cargo',['build','--release','--offline','--jobs','2'],{env:e,cwd:repo,timeout:60000});
   console.log((await exec(e.RUSTC_WRAPPER,['--show-stats'],{env:e,timeout:2000})).stdout);
   if(!fs.existsSync(path.join(repo,'target/release/libcache_probe.rlib')))throw Error('Compiler produced no library');
  });
  results.push(JSON.parse(fs.readFileSync(path.join(repo,'.enki-build-cache-status.json'))));
  fs.rmSync(repo,{recursive:true}); // next attempt has no local binaries, daemon or target
 }
 console.log(JSON.stringify(results));
 if(results[0].writes<1||results[1].hits<1)throw Error('No remote reuse after clean rebuild in another directory');
}finally{hub.kill();await once(hub,'exit');fs.rmSync(root,{recursive:true,force:true});}
