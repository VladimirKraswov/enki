import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assertDebianPayload } from '../scripts/artifact-policy.mjs';
const script=fileURLToPath(new URL('../scripts/ci-artifacts.mjs',import.meta.url));
async function fixture(run:(root:string,dir:string,bytes:Buffer)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'arvela-ci-receipt-'));const dir=join(root,'src-tauri','target','release','bundle','nsis');
 try {await mkdir(dir,{recursive:true});await writeFile(join(root,'package.json'),'{"version":"0.2.33"}');const bytes=Buffer.alloc(1024);bytes.write('MZ');await run(root,dir,bytes);}finally{await rm(root,{recursive:true,force:true});}
}
const invoke=(root:string,platform='windows')=>execFileSync(process.execPath,[script,platform],{cwd:root,env:{...process.env,GITHUB_OUTPUT:join(root,'job-output')},timeout:10000,stdio:'pipe'});
it('receipt binds the exact package bytes/version/commit and never claims live acceptance',async()=>fixture(async(root,dir,bytes)=>{
 await writeFile(join(dir,'Enki_0.2.32_x64-setup.exe'),bytes); // cached prior build must not be uploaded
 await writeFile(join(dir,'Enki_0.2.33_x64-setup.exe'),bytes);invoke(root);
 const receipt=JSON.parse(await readFile(join(root,'.local','ci-artifacts.json'),'utf8'));
 expect(receipt.version).toBe('0.2.33');expect(receipt.bytes).toBe(1024);expect(receipt.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));expect(receipt.liveAcceptance).toBe('not-run');
 expect(await readFile(join(root,'job-output'),'utf8')).toBe(`artifact=${join('src-tauri','target','release','bundle','nsis','Enki_0.2.33_x64-setup.exe')}\n`);
}));
it('accepts dpkg tar-relative and dot-prefixed paths with the exact regular executable',()=>{
 const line='-rwxr-xr-x 0/0        12404680 2026-10-08 12:55 ';
 for(const prefix of ['', './', '/'])expect(()=>assertDebianPayload(`${line}${prefix}usr/bin/enki\n`)).not.toThrow();
});
it('rejects absent, nonexecutable, indirect or wrong-platform Debian payloads',()=>{
 const line='-rwxr-xr-x 0/0        12404680 2026-10-08 12:55 ';
 for(const listing of ['', `${line}usr/bin/enki.old`,`${line.replace('-rwxr-xr-x','-rw-r--r--')}usr/bin/enki`, `${line.replace('-rwxr-xr-x','drwxr-xr-x')}usr/bin/enki`, `${line.replace('-rwxr-xr-x','lrwxrwxrwx')}usr/bin/enki -> elsewhere`,`${line}usr/bin/enki\n${line}usr/share/icon.icns`,`${line}usr/bin/enki\n${line}usr/share/Info.plist`,`${line}usr/bin/enki\n${line}usr/share/Entitlements.plist`])expect(()=>assertDebianPayload(listing)).toThrow('Debian payload/platform isolation failed');
});
it('cannot substitute an old package, empty file, or non-PE payload',async()=>fixture(async(root,dir,bytes)=>{
 await writeFile(join(dir,'Enki_0.2.32_x64-setup.exe'),bytes);expect(()=>invoke(root)).toThrow();
 const file=join(dir,'Enki_0.2.33_x64-setup.exe');await writeFile(file,'');expect(()=>invoke(root)).toThrow();
 await writeFile(file,Buffer.alloc(1024));expect(()=>invoke(root)).toThrow();
}));
it('refuses ambiguous packages and unsupported platforms instead of publishing a partial receipt',async()=>fixture(async(root,dir,bytes)=>{
 for(const arch of ['x64','arm64'])await writeFile(join(dir,`Enki_0.2.33_${arch}-setup.exe`),bytes);
 expect(()=>invoke(root)).toThrow();expect(()=>invoke(root,'other')).toThrow();
 await expect(readFile(join(root,'.local','ci-artifacts.json'))).rejects.toThrow();
 await expect(readFile(join(root,'job-output'))).rejects.toThrow();
}));

it('checks every member beyond the old 1 MiB subprocess listing bound',()=>{
 const line='-rwxr-xr-x 0/0        12404680 2026-10-08 12:55 ';
 const listing=`${line}usr/bin/enki\n`+`${line}usr/lib/Enki/agent-runtime/app/node_modules/package/file.js\n`.repeat(12000);
 expect(Buffer.byteLength(listing)).toBeGreaterThan(1024*1024);
 expect(()=>assertDebianPayload(listing)).not.toThrow();
 expect(()=>assertDebianPayload(`${listing}${line}usr/share/Info.plist\n`)).toThrow('Debian payload/platform isolation failed');
});
