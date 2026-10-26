// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {PermissionCard} from '../src/components/render';
vi.hoisted(()=>{Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addEventListener(){},removeEventListener(){}})});});
let root:Root;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const div=document.createElement('div');document.body.append(div);root=createRoot(div);});
afterEach(async()=>{await act(async()=>root.unmount());document.body.innerHTML='';vi.unstubAllGlobals();});
const req={id:'permission',sessionID:'session',permission:'bash',patterns:['printf fixture'],metadata:{tool:'bash',alwaysScope:'tool',alwaysTool:'bash'},tool:{callID:'call'}};
function always(){return [...document.querySelectorAll('button')].find(b=>b.textContent==='Разрешать Bash в этом чате')!;}
it('states Bash scope explicitly and sends one reply until the acknowledgement',async()=>{
 let finish!:(value:boolean)=>void;const reply=vi.fn(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
 await act(async()=>root.render(createElement(PermissionCard,{req,onReply:reply})));
 expect(always()).toBeTruthy();expect(document.querySelector('details')?.open).toBe(false);
 await act(async()=>{always().click();always().click();});expect(reply).toHaveBeenCalledOnce();
 expect([...document.querySelectorAll('button')].every(b=>b.disabled)).toBe(true);
 await act(async()=>finish(true));
});
it('keeps failed replies visible and allows an explicit retry',async()=>{
 const reply=vi.fn(async()=>false);await act(async()=>root.render(createElement(PermissionCard,{req,onReply:reply})));
 await act(async()=>always().click());expect(document.querySelector('[role="alert"]')?.textContent).toContain('не отправлен');expect(always().disabled).toBe(false);
});
it('does not claim a tool-wide grant for an older runtime or another tool',async()=>{
 await act(async()=>root.render(createElement(PermissionCard,{req:{...req,metadata:{tool:'bash',matching:'exact'}},onReply:vi.fn()})));
 expect(always()).toBeUndefined();expect(document.body.textContent).toContain('Запомнить это действие');
});
