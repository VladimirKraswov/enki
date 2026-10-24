import {it,expect} from 'vitest';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
// @ts-expect-error Native-lock adapter is shared Node code.
import {withImageState} from '../src-tauri/resources/shared/image-generation-context.mjs';
it.skipIf(process.platform==='win32')('reports a broken native lock pipe instead of crashing the MCP process',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'enki-image-lock-')),file=path.join(dir,'lock.mjs'),old=process.env.MESH_CAPABILITIES_COMMAND;
 try{
  await fs.writeFile(file,'#!/usr/bin/env node\nimport fs from "node:fs";fs.closeSync(0);process.stdout.write(JSON.stringify({version:1,requests:{},jobs:[],latest:null})+"\\n");setTimeout(()=>process.exit(0),500);',{mode:0o700});
  process.env.MESH_CAPABILITIES_COMMAND=file;
  await expect(withImageState({id:'a'.repeat(64),directory:dir},async()=>{await new Promise(resolve=>setTimeout(resolve,100));})).rejects.toThrow();
 }finally{if(old===undefined)delete process.env.MESH_CAPABILITIES_COMMAND;else process.env.MESH_CAPABILITIES_COMMAND=old;await fs.rm(dir,{recursive:true,force:true});}
});
