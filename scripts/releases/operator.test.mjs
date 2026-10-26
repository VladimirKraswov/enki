import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseWithOperator,operatorEnvironment,privateFile,operatorFile} from './operator.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
test('all gates precede credentials and canonical publication; failed tests cannot publish',()=>{
 const calls=[];let secrets=0;
 releaseWithOperator('stable',(program,args,env)=>calls.push({program,args,env}),()=>{secrets++;return {ONLY:'publisher'};});
 assert.equal(secrets,1);assert.ok(calls.some(c=>c.args.includes('services/asr/tests')));assert.ok(calls.some(c=>c.program==='cargo'&&c.args[0]==='test'));
 assert.ok(calls.filter(c=>c.program==='cargo'&&c.args[0]!=='fmt').every(c=>c.args.includes('--locked')),'every compiling cargo gate uses the reviewed Cargo.lock');
 assert.deepEqual(calls.at(-1),{program:'node',args:['scripts/releases/publish.mjs','stable'],env:{ONLY:'publisher'}});
 assert.ok(calls.slice(0,-1).every(c=>c.env===undefined));
 secrets=0;assert.throws(()=>releaseWithOperator('stable',(p,a)=>{if(p==='npm'&&a[0]==='test')throw Error('regression');},()=>{secrets++;return{};}));assert.equal(secrets,0);
 assert.throws(()=>releaseWithOperator('arbitrary',()=>{},()=>{}));
});
test('operator reads only private files and does not turn metadata into shell commands',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'arvela-operator-'));
 const file=(name,text)=>{const p=path.join(root,name);fs.writeFileSync(p,text,{mode:0o600});return p;};
 try {
  const config=file('operator.json',JSON.stringify({hubUrl:'https://localhost:8443',caFile:file('ca.pem','public'),adminTokenFile:file('token','fixture-secret'),signingKeyFile:file('key','fixture-key')}));
  assert.equal(operatorEnvironment(config).ARVELA_HUB_ADMIN_TOKEN,'fixture-secret');
  assert.throws(()=>privateFile('relative'));
  if(process.platform!=='win32'){fs.chmodSync(config,0o644);assert.throws(()=>operatorEnvironment(config));}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('operator migration preserves private bytes and old absolute credential paths, and refuses split stores',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'enki-operator-migration-'));
 try{
  const old=path.join(root,'arvela-release');fs.mkdirSync(old,{mode:0o700});
  fs.writeFileSync(path.join(old,'operator.json'),'fixture',{mode:0o600});
  const current=operatorFile(root);assert.equal(fs.readFileSync(current,'utf8'),'fixture');
  assert.equal(fs.realpathSync(old),fs.realpathSync(path.join(root,'enki-release')));assert.equal(operatorFile(root),current);
  fs.unlinkSync(old);assert.equal(operatorFile(root),current);assert.equal(fs.existsSync(old),false,'retired alias stays retired');
  fs.mkdirSync(old);fs.writeFileSync(path.join(old,'operator.json'),'other');
  assert.throws(()=>operatorFile(root));assert.equal(fs.readFileSync(current,'utf8'),'fixture');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

// Exact canonical gate order. Bundled-runtime and standalone-runner gates are
// unconditional and precede any credential request.
const py=process.platform==='win32'?['py',['-3']]:['python3',[]];
const workers=process.env.ENKI_RELEASE_TEST_WORKERS;
const AGENT='src-tauri/resources/agent',RUNNER='src-tauri/build-runner/Cargo.toml';
const GATES=[
 ['git',['diff','--exit-code']],
 ['npm',workers?['test','--','--maxWorkers='+workers]:['test']],['npm',['run','build']],['npm',['run','check:architecture']],['npm',['run','check:bundle']],['npm',['run','test:releases']],
 ['npm',['run','sdk:check']],['npm',['ci','--prefix',AGENT,'--ignore-scripts']],['npm',['rebuild','--prefix',AGENT,'node-pty']],
 ['npm',['--prefix',AGENT,'run','typecheck']],['npm',['run','test:runtime']],['npm',['run','test:runtime-artifact']],
 [py[0],[...py[1],'-m','unittest','discover','-s','services/hub/tests']],[py[0],[...py[1],'-m','unittest','discover','-s','services/asr/tests']],
 ['cargo',['fmt','--manifest-path','src-tauri/Cargo.toml','--check']],['cargo',['test','--manifest-path','src-tauri/Cargo.toml','--locked']],
 ['cargo',['clippy','--manifest-path','src-tauri/Cargo.toml','--locked','--all-targets','--','-D','warnings']],
 ['cargo',['fmt','--manifest-path',RUNNER,'--check']],['cargo',['test','--manifest-path',RUNNER,'--locked']],
 ['cargo',['clippy','--manifest-path',RUNNER,'--locked','--all-targets','--','-D','warnings']],
];
test('exact gate order: runtime, SDK contract, artifact/installer and standalone runner gates precede credentials',()=>{
 for(const mode of ['operator','device']){
  const calls=[];let requestedAt=-1;
  releaseWithOperator('stable',(program,args,env)=>calls.push([program,args,env]),()=>{requestedAt=calls.length;return {ONLY:'publisher'};},mode);
  assert.deepEqual(calls.slice(0,-1).map(([p,a])=>[p,a]),GATES,mode);
  assert.ok(calls.slice(0,-1).every(([,,env])=>env===undefined),'no gate receives credentials');
  if(mode==='operator'){assert.equal(requestedAt,GATES.length,'credentials requested only after every gate');assert.deepEqual(calls.at(-1),['node',['scripts/releases/publish.mjs','stable'],{ONLY:'publisher'}]);}
  else{assert.equal(requestedAt,-1);assert.deepEqual(calls.at(-1).slice(0,2),['node',['scripts/releases/device.mjs','stable']]);}
 }
});
test('any failing bundled-runtime or standalone-runner gate stops before credentials and publication',()=>{
 const first=GATES.findIndex(([p,a])=>p==='npm'&&a[1]==='sdk:check');
 const targets=GATES.map((gate,index)=>({gate,index})).filter(({gate:[p,a],index})=>index>=first&&(p==='npm'||a.includes(RUNNER)));
 assert.equal(targets.length,9);
 for(const {gate:[program,args]} of targets){
  let secrets=0;const seen=[];
  assert.throws(()=>releaseWithOperator('stable',(p,a)=>{seen.push(p);if(p===program&&JSON.stringify(a)===JSON.stringify(args))throw Error('gate failed');},()=>{secrets++;return{};}),/gate failed/);
  assert.equal(secrets,0,args.join(' '));assert.ok(!seen.includes('node'),'publisher never ran');
 }
});
test('paired-device mode runs all gates without ever reading operator credentials',()=>{
 const calls=[];releaseWithOperator('stable',(p,a)=>calls.push({p,a}),()=>{throw Error('must not read signing/admin credentials');},'device');
 assert.deepEqual(calls.at(-1),{p:'node',a:['scripts/releases/device.mjs','stable']});
 assert(calls.some(x=>x.p==='cargo'&&x.a.includes('clippy')));
 assert(calls.some(x=>x.a.includes('services/hub/tests')));
});
