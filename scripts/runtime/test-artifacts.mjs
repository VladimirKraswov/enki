// Public packaging test entry. Windows fixtures require the exact native
// directory durability port; bootstrap it from this checkout before the suite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootstrapRunner } from './build-runner.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const env={...process.env};let owned;
try {
 if(process.platform==='win32'){
  const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'enki-artifact-tests-')));
  // A failed/unsettled bootstrap keeps its own evidence; never remove it here.
  const receipt=await bootstrapRunner({repo,base});owned=base;
  env.ENKI_TEST_NATIVE_RUNNER=receipt.path;env.ENKI_TEST_NATIVE_RUNNER_SHA256=receipt.sha256;
 }
 const tests=fs.readdirSync(path.join(repo,'scripts/runtime')).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>path.join(repo,'scripts/runtime',n));
 const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--experimental-transform-types','--test',...tests],{cwd:repo,env,stdio:'inherit',windowsHide:true});child.once('error',reject);child.once('close',(code,signal)=>resolve(signal?1:code??1));});
 process.exitCode=code;
} finally {if(owned&&process.exitCode===0)fs.rmSync(owned,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
