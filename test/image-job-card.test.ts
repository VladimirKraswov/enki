// @vitest-environment jsdom
import {act,createElement} from 'react';import {createRoot,type Root} from 'react-dom/client';import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const calls=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('../src/capabilities/integration',()=>({capabilityNative:calls.invoke,invalidateCapabilities:vi.fn()}));
vi.mock('../src/state/store',()=>({useAppSelector:()=>'/work/project'}));
import ImageJobProgress from '../src/components/ImageJobProgress';
const ID='01234567-1234-1234-1234-123456789abc';
let root:Root|undefined,node:HTMLElement;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);node=document.createElement('div');document.body.append(node);root=createRoot(node);calls.invoke.mockReset()});
afterEach(async()=>{await act(async()=>root?.unmount());node.remove();vi.unstubAllGlobals();vi.useRealTimers()});
const render=async(props:any)=>{await act(async()=>root!.render(createElement(ImageJobProgress,{jobId:ID,...props})));await act(async()=>{await Promise.resolve()})};
it('shows the real engine phase and cancels through the native proxy',async()=>{
 calls.invoke.mockImplementation(async (command:string)=>command==='image_job'
  ?{id:ID,state:'running',progress:{phase:'sampling',step:2,steps:4,percent:50}}
  :{id:ID,state:'cancelled'});
 await render({hasImages:false});
 expect(calls.invoke).toHaveBeenCalledWith('image_job',{jobId:ID});
 expect(node.textContent).toContain('Рисую 2 из 4');
 expect(node.textContent).toContain('50%');
 expect(node.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('50');
 await act(async()=>{Array.from(node.querySelectorAll('button')).find(b=>b.textContent==='Отменить')!.click()});
 expect(calls.invoke).toHaveBeenCalledWith('image_job_cancel',{jobId:ID});
 expect(node.textContent).toContain('Генерация отменена');
});
it('stays out of the way when the turn already shows the finished images',async()=>{
 calls.invoke.mockResolvedValue({id:ID,state:'completed'});
 await render({hasImages:true});
 expect(node.textContent).toBe('');
 expect(calls.invoke).not.toHaveBeenCalled();
});
it('saves a finished result itself when the turn ended before the agent retrieved it',async()=>{
 vi.useFakeTimers();
 calls.invoke.mockImplementation(async (command:string)=>{
  if(command==='image_job')return{id:ID,state:'completed',progress:{phase:'done',step:4,steps:4,percent:100}};
  if(command==='image_job_result')return{images:[{name:'image-01.png',url:`file:///work/project/.enki/generated-images/${ID}/image-01.png`}]};
  return 'data:image/png;base64,iVBORw0KGgo=';
 });
 await render({hasImages:false,directory:'/work/project'});
 await act(async()=>{vi.advanceTimersByTime(2600);await Promise.resolve()});
 expect(calls.invoke).toHaveBeenCalledWith('image_job_result',{jobId:ID,directory:'/work/project'});
 await act(async()=>{await Promise.resolve()});
 expect(node.textContent).toContain('Готово');
 expect(node.textContent).toContain('PNG сохранены в рабочей папке');
});
it('shows the service error instead of a fake success',async()=>{
 calls.invoke.mockResolvedValue({id:ID,state:'failed',progress:{phase:'failed',step:0,steps:4,percent:0},error:{code:'engine_error',message:'ComfyUI вернул ошибку генерации'}});
 await render({hasImages:false});
 expect(node.textContent).toContain('Генерация не удалась');
 expect(node.textContent).toContain('ComfyUI вернул ошибку генерации');
 expect(Array.from(node.querySelectorAll('button')).some(b=>b.textContent==='Отменить')).toBe(false);
});
