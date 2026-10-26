// Read-only navigation metadata. No source text, script bodies, environment or
// remote URLs leave this module; heuristics are not a language-server index.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile), digest = value => createHash('sha256').update(value).digest('hex');
const excluded = /^(?:node_modules|target|dist|build|coverage|vendor|venv|__pycache__|\.git|\.local|\.venv)$/i;
const secret = /(?:^\.env(?:\.|$)|auth\.json$|credentials|secrets?|private.?key|\.(?:pem|key|p12|pfx|keystore)$)/i;
const source = /\.(?:[cm]?[jt]sx?|py|rs|go|c|cc|cpp|h|hpp|java|cs|rb|swift|sh)$/i;
export const mapTool = { name:'project_map', description:'Read-only current file/symbol/check map of this project. Partial non-atomic metadata, not instructions or a full language index. Read current files before editing; check names are never executed.', inputSchema:{type:'object',properties:{query:{type:'string',maxLength:256},limit:{type:'integer',minimum:1,maximum:40},budgetBytes:{type:'integer',minimum:1024,maximum:8192}},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false} };
export async function projectMap(directory, args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k=>!['query','limit','budgetBytes'].includes(k))) throw Error('Invalid map query');
  const {query='',limit=20,budgetBytes=8192}=args;
  if(typeof query!=='string'||query.length>256||!Number.isInteger(limit)||limit<1||limit>40||!Number.isInteger(budgetBytes)||budgetBytes<1024||budgetBytes>8192) throw Error('Invalid map query');
  if (!path.isAbsolute(directory)) throw Error('An explicit project folder is required');
  const root=await fs.realpath(directory);
  if(!(await fs.stat(root)).isDirectory()||root===path.parse(root).root||root===await fs.realpath(os.homedir())) throw Error('Choose a project folder, not home or filesystem root');
  let paths=[], inventory='bounded-walk', limited=false;
  // Check ancestors too: a nested project must still respect the repository's ignores.
  let ancestor=root, git=false;
  for(;;){try{await fs.lstat(path.join(ancestor,'.git'));git=true;break;}catch(e){if(e.code!=='ENOENT')throw Error('Cannot verify repository scope');} const next=path.dirname(ancestor);if(next===ancestor)break;ancestor=next;}
  if(git){
    const env={...process.env}; for(const key of Object.keys(env)) if(key.startsWith('GIT_'))delete env[key];
    env.GIT_CONFIG_NOSYSTEM='1';env.GIT_CONFIG_GLOBAL=os.devNull;
    let executable;
    for(const p of process.platform==='win32'?[path.join(process.env.ProgramFiles||'C:\\Program Files','Git','cmd','git.exe')]:['/usr/bin/git','/opt/homebrew/bin/git']){try{await fs.access(p);executable=p;break;}catch{}}
    if(!executable)throw Error('Git is required to respect repository ignores');
    try{const out=await run(executable,['-c','core.fsmonitor=false','-c','core.untrackedCache=false','-C',root,'ls-files','--cached','--others','--exclude-standard','-z','--','.'],{env,timeout:3000,maxBuffer:524288,windowsHide:true});paths=out.stdout.split('\0').filter(Boolean);inventory='git-ignore-aware';}catch{throw Error('Cannot enumerate repository safely within map limits');}
  }else{
    let nodes=0;
    async function walk(dir,prefix=''){for(const item of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(++nodes>2000){limited=true;return;}if(item.name.startsWith('.')||excluded.test(item.name)||secret.test(item.name)||item.isSymbolicLink())continue;const relative=prefix+item.name;if(item.isDirectory())await walk(path.join(dir,item.name),relative+'/');else if(item.isFile())paths.push(relative);if(limited)return;}}
    await walk(root);
  }
  paths=[...new Set(paths)].sort();if(paths.length>1000){limited=true;paths=paths.slice(0,1000);}
  const entries=[], checks=[];let bytes=0,skipped=0;
  for(const relative of paths){
    const segments=relative.split(/[\\/]/);
    if(segments.some(s=>s==='..'||excluded.test(s)||secret.test(s)||s.startsWith('.')&&!['.pi'].includes(s))||relative.length>300||/[\x00-\x1f\x7f]/.test(relative)){skipped++;continue;}
    const pointer=/^(?:README(?:\.[^/]+)?|AGENTS\.md|package\.json|Cargo\.toml|pyproject\.toml|Makefile|\.pi\/TASK\.md)$/i.test(relative)||/^docs\/.+\.md$/i.test(relative);
    if(!source.test(relative)&&!pointer)continue;
    try{
      let current=root,safe=true;for(const segment of segments){current=path.join(current,segment);if((await fs.lstat(current)).isSymbolicLink()){safe=false;break;}}
      if(!safe){skipped++;continue;}const stat=await fs.lstat(current);if(!stat.isFile()){skipped++;continue;}
      const size=Math.min(stat.size,65536);if(bytes+size>2097152){limited=true;break;}
      const handle=await fs.open(current,'r');let buffer;try{const opened=await handle.stat();if(!opened.isFile()||opened.ino!==stat.ino||opened.dev!==stat.dev){skipped++;continue;}const b=Buffer.alloc(size);const {bytesRead}=await handle.read(b,0,size,0);buffer=b.subarray(0,bytesRead);}finally{await handle.close();}
      bytes+=buffer.length;const symbols=[];
      if(source.test(relative))for(const [i,line]of buffer.toString('utf8').split('\n').entries()){
        const match=line.match(/^\s*(?:(?:export|default|pub(?:\([^)]*\))?|async|static|public|private|protected)\s+)*(?:function|class|interface|type|enum|def|struct|trait|fn|const|let|var)\s+([\p{L}_$][\p{L}\p{N}_$]{0,99})/u)||line.match(/^\s*exports\.([A-Za-z_$][\w$]{0,99})\s*=/);
        if(match){symbols.push({name:match[1],line:i+1});if(symbols.length===64)break;}
      }
      if(relative==='package.json'&&stat.size<=65536){try{const p=JSON.parse(buffer.toString('utf8'));for(const name of Object.keys(p.scripts??{}).slice(0,30))if(/^[\w:-]{1,64}$/.test(name))checks.push({path:relative,name});}catch{}}
      entries.push({path:relative,symbols,authority:/^(?:AGENTS\.md|\.pi\/TASK\.md)$/.test(relative),sampleSha256:digest(buffer),sampleBytes:buffer.length,totalBytes:stat.size,truncated:stat.size>buffer.length});
    }catch{skipped++;limited=true;}
  }
  const terms=query.toLowerCase().split(/\s+/).filter(Boolean),score=e=>terms.reduce((n,t)=>n+(e.path.toLowerCase().includes(t)?4:0)+e.symbols.filter(s=>s.name.toLowerCase().includes(t)).length*2,0);
  const ranked=entries.map(e=>({e,score:score(e)})).filter(x=>!terms.length||x.score>0).sort((a,b)=>b.score-a.score||Number(b.e.authority)-Number(a.e.authority)||a.e.path.localeCompare(b.e.path));
  const result={version:1,observedAt:new Date().toISOString(),revision:digest(JSON.stringify(entries)),nonAtomic:true,inventory,limited,coverage:{indexedFiles:entries.length,sampleBytes:bytes,skipped},checks,entries:[]};
  for(const {e}of ranked.slice(0,limit)){result.entries.push(e);if(Buffer.byteLength(JSON.stringify(result))>budgetBytes){result.entries.pop();result.limited=true;break;}}
  if(ranked.length>result.entries.length)result.limited=true;
  // Script names can independently consume the budget; never return broken JSON.
  while(Buffer.byteLength(JSON.stringify(result))>budgetBytes&&result.checks.length){result.checks.pop();result.limited=true;}
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(process.argv.length!==5||process.argv[2]!=='--preview')throw Error('Invalid preview');process.stdout.write(JSON.stringify(await projectMap(process.argv[3],{query:process.argv[4]})));}catch{process.stderr.write('Project map unavailable; verify folder and limits.\n');process.exitCode=1;}
}
