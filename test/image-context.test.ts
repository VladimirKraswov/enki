import { expect, it, vi } from 'vitest';
import { imageContextSources, imagePromptParts, stageImagePromptContext } from '../src/images/context';
import accessPolicy from '../src-tauri/resources/browser/access-policy.mjs';
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
it('uses the always-installed policy hook for trusted image identity even without browser tools', async () => {
  const hook=(await accessPolicy({} as any))['tool.execute.before'];
  for(const tool of ['mesh_enki_images_image_inputs','mesh_enki_images_edit_image','mesh_enki_images_get_images']) {
    const args={__enkiImageContext:{engine:'pi',sessionID:'forged'},input:'current'};
    await hook({tool,sessionID:'ses_real'},{args});
    expect(args.__enkiImageContext).toEqual({engine:'opencode',sessionID:'ses_real'});
    expect(args.input).toBe('current');
  }
  const other={args:{__enkiImageContext:{engine:'pi',sessionID:'keep'}}};
  await hook({tool:'mesh_other_read',sessionID:'ses_real'},other);
  expect(other.args.__enkiImageContext.sessionID).toBe('keep');
  await expect(hook({tool:'mesh_enki_images_edit_image',sessionID:'../escape'},{args:{}})).rejects.toThrow('session');
});
