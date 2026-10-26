// Explicit post-publication handoff. A local signed-packet receipt must match
// HEAD; GitHub main must already contain that same commit. No Hub secrets.
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {nativeFingerprint} from './packet.mjs';import {REPO} from './github-packages.mjs';
const root=path.resolve(import.meta.dirname,'../..'),channel=process.argv[2]??'stable';
if(!['stable','preview'].includes(channel))throw Error('Invalid channel');
const run=(p,args)=>execFileSync(p,args,{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:1048576});
const commit=run('git',['rev-parse','HEAD']).trim(),{version}=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
const receipt=JSON.parse(fs.readFileSync(path.join(root,`.local/releases/${version}-${channel}.json`)));
if(receipt.commit!==commit||receipt.version!==version||receipt.channel!==channel||!receipt.verifiedAt||!receipt.revision||receipt.nativeFingerprint!==nativeFingerprint(path.join(root,'src-tauri'))||!receipt.artifacts?.source?.digest||!receipt.artifacts?.hot?.digest)throw Error('Verify this exact release on Hub before publishing GitHub packages');
if(run('git',['status','--porcelain']).trim())throw Error('Commit reviewed changes first');
const remote=JSON.parse(run('gh',['api',`repos/${REPO}/git/ref/heads/main`]));
if(remote.object.sha!==commit)throw Error('Push the verified commit to main before dispatching packages');
run('gh',['workflow','run','desktop.yml','--repo',REPO,'--ref','main','-f',`published_commit=${commit}`]);
console.log(`Package workflow dispatched for verified Enki ${version}, ${commit}. Hub clients will wait for all three packages.`);
