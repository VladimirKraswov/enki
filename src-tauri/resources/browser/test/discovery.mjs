// Real daemon + official MCP schemas; discovery must not launch Chromium or
// allocate a workspace backend for every agent's temporary worktree.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const dependencies = process.argv[2]; assert(dependencies && path.isAbsolute(dependencies));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'enki-browser-discovery-'));
const runtime = path.join(root,'current'); let child, ready; let errors='';
try {
 await fs.mkdir(runtime);
 const source=fileURLToPath(new URL('../',import.meta.url));
 for(const name of await fs.readdir(source)) if(name.endsWith('.mjs')) await fs.copyFile(path.join(source,name),path.join(runtime,name));
 if(process.argv[3]) await fs.copyFile(process.argv[3],path.join(runtime,'daemon.mjs'));
 await fs.symlink(path.join(dependencies,'node_modules'),path.join(runtime,'node_modules'),process.platform==='win32'?'junction':'dir');
 child=spawn(process.execPath,[path.join(runtime,'daemon.mjs'),root],{stdio:['pipe','ignore','pipe'],env:{...process.env,OCDESKTOP_BROWSER_OWNER_PIPE:'1'}});
 child.stderr.on('data',b=>{errors=(errors+b).slice(-2000);});
 for(let i=0;i<150;i++) {try{ready=JSON.parse(await fs.readFile(path.join(root,'ready.json'),'utf8'));break;}catch{} if(child.exitCode!==null)throw Error(errors);await new Promise(r=>setTimeout(r,100));}
 assert(ready,'daemon ready'); let names;
 for(let i=0;i<40;i++) {
  const workspace=path.join(root,'worktrees',String(i)); await fs.mkdir(workspace,{recursive:true});
  const response=await fetch(`http://127.0.0.1:${ready.port}/rpc`,{method:'POST',headers:{Authorization:`Bearer ${ready.token}`,'Content-Type':'application/json'},body:JSON.stringify({method:'tools/list',workspace,access:i%2?'full':'project'}),signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200,`discovery ${i} failed`);
  const tools=(await response.json()).result.tools; assert(tools.length>20);
  const current=tools.map(t=>t.name); if(names)assert.deepEqual(current,names); else names=current;
 }
 assert.equal((await fs.readdir(path.join(root,'workspace'))).length,1,'one inventory backend, not40');
 assert(!(await fs.readdir(root)).some(n=>n.startsWith('temporary-profile-')),'metadata must not launch a browser');
 console.log(JSON.stringify({discoveries:40,stableToolCount:names.length,inventoryBackends:1,browserActions:0}));
} finally {
 if(child&&child.exitCode===null) {child.stdin.end();for(let i=0;i<100&&child.exitCode===null;i++)await new Promise(r=>setTimeout(r,100));assert.equal(child.exitCode,0,'own daemon clean shutdown');}
 await fs.rm(root,{recursive:true,force:true});
}
