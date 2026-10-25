import { expect, it, vi } from 'vitest';
import { imageContextSources, imagePromptParts, stageImagePromptContext } from '../src/images/context';
import type { PromptRequest } from '../src/api/types';
const source = { type:'file' as const, filename:'photo.png', mime:'image/png', url:'data:image/png;base64,AQID' };
it('stages only actual prepared image bytes, never remote URLs, text markers or model paths', async () => {
  const parts: PromptRequest['parts'] = [source,{...source,filename:'remote.png',url:'https://private/secret.png'},{type:'text',text:'data:image/png;base64,AQID'},{...source,filename:'animated.gif',mime:'image/gif',url:'data:image/gif;base64,AQID'}];
  const invoke=vi.fn(async()=>undefined);
  await stageImagePromptContext({engine:'opencode',sessionId:'ses_actual',directory:'/actual',messageId:'msg_1',supportsVision:true,parts,local:true},invoke);
  expect(invoke).toHaveBeenCalledWith('image_prompt_context',expect.objectContaining({sessionId:'ses_actual',messageId:'msg_1',supportsVision:true,images:[{name:'photo.png',mime:'image/png',data:'AQID'}],unsupported:expect.arrayContaining([expect.objectContaining({name:'remote.png'}),expect.objectContaining({name:'animated.gif'})])}));
  expect(JSON.stringify(invoke.mock.calls)).not.toContain('https://private');
});
it('binds empty follow-up requests while keeping engines and remote work separate', async () => {
  const invoke=vi.fn(async()=>undefined);
  const context={engine:'pi',sessionId:'same',directory:'/project',messageId:'msg_2',supportsVision:false,parts:[],local:true};
  await stageImagePromptContext(context,invoke);
  expect(invoke).toHaveBeenCalledWith('image_prompt_context',{engine:'pi',sessionId:'same',directory:'/project',messageId:'msg_2',supportsVision:false,images:[],unsupported:[]});
  await stageImagePromptContext({...context,local:false},invoke);
  expect(invoke).toHaveBeenCalledTimes(1);
});
it('limits references without dropping unsupported files from the actual prompt', () => {
  const parts=Array.from({length:6},(_,n)=>({...source,filename:`${n}.png`}));
  expect(imageContextSources(parts).images).toHaveLength(4);
  expect(imageContextSources(parts).unsupported).toHaveLength(2);
  expect(imagePromptParts(parts,true,true)).toBe(parts);
  const text=imagePromptParts([source],false,true);
  expect(text).toEqual([expect.objectContaining({type:'text',text:expect.stringContaining('photo.png')})]);
  expect(JSON.stringify(text)).not.toContain('AQID');
  expect(JSON.stringify(text)).toContain('не поддерживает Vision');
  expect(imagePromptParts([source],false,false)).toEqual([source]);
});
// The former 4th case (OpenCode `access-policy.mjs` tool.execute.before hook) is
// held separately in `image-context-opencode-policy.test.ts` and retires with that
// dead module. The trusted image identity it protected is owned by the sole SDK
// runtime: `pi-shared-tools.test.ts` › "binds image calls…", "every image tool…",
// "a model-supplied image identity never reaches another server" and "an
// invalid SDK session identity is refused before any image call".
