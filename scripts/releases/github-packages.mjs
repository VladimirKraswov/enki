// Runs only after the three platform jobs, following an explicit post-Hub dispatch.
// CI receives the repository token, never the Enki signing key or Hub credentials.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {hash,nativeFingerprint} from './packet.mjs';
export const REPO='VladimirKraswov/enki';
const PLATFORMS={'macos-arm64':'.dmg','windows-x64':'-setup.exe','linux-x64':'.deb'};
export function packageManifest(receipts,{version,commit,fingerprint,runId}){
  if(!/^[0-9a-f]{40}$/.test(commit)||!/^[0-9a-f]{64}$/.test(fingerprint)||!Number.isSafeInteger(runId)||runId<=0)throw Error('Invalid workflow identity');
  const packages={};
  for(const {receipt:r,bytes} of receipts){
    const key=`${r.platform}-${r.arch}`;
    if(!PLATFORMS[key]||packages[key]||r.schema!==1||r.version!==version||r.commit!==commit||r.nativeFingerprint!==fingerprint||r.runId!==runId||r.liveAcceptance!=='not-run')throw Error('Package receipt identity mismatch');
    if(!/^Enki_[A-Za-z0-9_.+-]+$/.test(r.artifact)||!r.artifact.startsWith(`Enki_${version}_`)||!r.artifact.endsWith(PLATFORMS[key])||r.bytes!==bytes.length||r.bytes<1024||r.bytes>512*1024*1024||r.sha256!==hash(bytes))throw Error('Package receipt checksum mismatch');
    packages[key]={name:r.artifact,bytes:r.bytes,sha256:r.sha256,url:`https://github.com/${REPO}/releases/download/v${version}/${r.artifact}`};
  }
  if(Object.keys(packages).length!==3)throw Error('All three qualified packages are required');
  return {schemaVersion:1,kind:'native',version,nativeFingerprint:fingerprint,commit,runId,packages};
}
function walk(root,depth=0){
  if(depth>12)throw Error('Artifact nesting limit');
  return fs.readdirSync(root,{withFileTypes:true}).flatMap(e=>{
    if(e.isSymbolicLink())throw Error('Artifact symlink refused');
    const p=path.join(root,e.name);return e.isDirectory()?walk(p,depth+1):[p];
  });
}
export function missingAssets(release,expected,commit,allowPublished=false){
  if((!release.draft&&!allowPublished)||release.target_commitish!==commit)throw Error('Existing release is published or belongs to another commit');
  const names=new Set();
  for(const a of release.assets??[]){
    const e=expected.get(a.name);
    if(!e||a.size!==e.bytes||a.digest!==`sha256:${e.sha256}`||a.state!=='uploaded'||names.has(a.name))throw Error('Existing draft contains different assets; nothing replaced');
    names.add(a.name);
  }
  const missing=[...expected.keys()].filter(name=>!names.has(name));
  if(!release.draft&&missing.length)throw Error('Published release is incomplete; nothing replaced');
  return missing;
}
export function publishPackages(root,env=process.env,run=execFileSync){
  if(env.GITHUB_REPOSITORY!==REPO||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.ENKI_PUBLISHED_COMMIT!==env.GITHUB_SHA)throw Error('Publication requires a post-Hub dispatch of the exact main commit');
  const {version}=JSON.parse(fs.readFileSync('package.json'));
  const files=walk(root),receipts=files.filter(f=>path.basename(f)==='ci-artifacts.json').map(file=>{
    const receipt=JSON.parse(fs.readFileSync(file));const matches=files.filter(f=>path.basename(f)===receipt.artifact);
    if(matches.length!==1)throw Error('Ambiguous package filename');
    return {receipt,bytes:fs.readFileSync(matches[0]),file:matches[0]};
  });
  const manifest=packageManifest(receipts,{version,commit:env.GITHUB_SHA,fingerprint:nativeFingerprint('src-tauri'),runId:Number(env.GITHUB_RUN_ID)});
  const gh=(args)=>run('gh',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000,maxBuffer:1048576});
  // An interrupted upload can resume an exact draft; never replace any asset.
  const existing=JSON.parse(gh(['api',`repos/${REPO}/releases?per_page=100`]));
  const file=path.join(root,'enki-native.json');fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');
  const paths=new Map([...receipts.map(r=>[r.receipt.artifact,r.file]),['enki-native.json',file]]);
  const expected=new Map([...receipts.map(r=>[r.receipt.artifact,{bytes:r.receipt.bytes,sha256:r.receipt.sha256}]),['enki-native.json',{bytes:fs.statSync(file).size,sha256:hash(fs.readFileSync(file))}]]);
  const previous=existing.find(r=>r.tag_name===`v${version}`);
  if(previous&&!previous.draft){missingAssets(previous,expected,env.GITHUB_SHA,true);return manifest;}
  if(previous){const missing=missingAssets(previous,expected,env.GITHUB_SHA);if(missing.length)gh(['release','upload',`v${version}`,...missing.map(name=>paths.get(name)),'--repo',REPO]);}
  else gh(['release','create',`v${version}`,...paths.values(),'--repo',REPO,'--target',env.GITHUB_SHA,'--title',`Enki ${version}`,'--notes','Готовые пакеты Enki. Контракты и сборка проверены CI на macOS, Windows и Linux. Живая приёмка на устройствах выполняется отдельно.','--draft']);
  // GitHub's tag endpoint can return 404 for a draft. The authenticated list
  // includes drafts; re-read it after upload and identify the exact tag.
  const uploaded=JSON.parse(gh(['api',`repos/${REPO}/releases?per_page=100`])).find(r=>r.tag_name===`v${version}`);
  if(!uploaded)throw Error('Uploaded release draft not found');
  if(missingAssets(uploaded,expected,env.GITHUB_SHA).length)throw Error('Upload incomplete; draft retained');
  // Create as draft, upload all, then expose atomically. Hub still waits for this
  // workflow to finish successfully and independently checks GitHub digests.
  gh(['release','edit',`v${version}`,'--repo',REPO,'--draft=false',...(/-/.test(version)?['--prerelease']:[])]);
  return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))publishPackages(path.resolve(process.argv[2]??'.local/packages'));
