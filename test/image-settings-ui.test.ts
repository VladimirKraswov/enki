// @vitest-environment jsdom
import {act,createElement} from 'react';import {createRoot} from 'react-dom/client';import {expect,it,vi} from 'vitest';
const calls=vi.hoisted(()=>({invoke:vi.fn(),invalidate:vi.fn()}));
vi.mock('../src/capabilities/integration',()=>({capabilityNative:calls.invoke,invalidateCapabilities:calls.invalidate}));
import Settings from '../src/components/ImageGenerationSettings';
it('loads redacted settings, changes API without inference and saves a key only when explicitly replacing',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const settings={enabled:false,endpoint:'http://127.0.0.1/api/images'};
 calls.invoke.mockImplementation(async(_cmd,args)=>({settings:args.settings??settings,hasKey:true}));
 const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
 try{await act(async()=>root.render(createElement(Settings)));
 expect(calls.invoke.mock.calls[0]).toEqual(['image_settings',{settings:null,apiKey:null}]);
 expect(document.body.textContent).toContain('сохранён');expect(document.querySelector('input[type=password]')).toBeNull();
 await act(async()=>{document.querySelector<HTMLInputElement>('[aria-label="Включить генерацию"]')!.click()});
 await act(async()=>{Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Сохранить генератор')!.click()});
 expect(calls.invoke.mock.calls.at(-1)).toEqual(['image_settings',{settings:{...settings,enabled:true},apiKey:null}]);expect(calls.invalidate).toHaveBeenCalledOnce();
 expect(calls.invoke.mock.calls.every(([cmd])=>cmd==='image_settings')).toBe(true);
 }finally{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals()}
});
