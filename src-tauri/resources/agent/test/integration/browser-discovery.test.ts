import {afterEach,expect,it} from 'vitest';
import {attachBrowser} from '../../../browser/pi-extension.ts';
import {fauxAssistantMessage,fauxToolCall} from '../../src/sdk/testing.ts';
import {extension,harness,newSession,promptCommand,type Harness} from '../helpers.ts';
let h:Harness;afterEach(async()=>{await h?.stop();});
it('the real SDK first turn receives browser tools after delayed discovery, with exactly one browser call',async()=>{
 let calls=0; let seen:string[]=[];
 h=await harness({extraExtensions:()=>[extension('browser-discovery',pi=>attachBrowser(pi,{command:()=>'/abs/enki',access:()=> 'full'},async()=>({
  connect:async()=>{await new Promise(resolve=>setTimeout(resolve,30));},
  listTools:async()=>({tools:[{name:'browser_navigate',description:'fixture',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}),
  callTool:async()=>{calls++;return {content:[{type:'text',text:'one browser call'}]};},close:async()=>{},
 })))]});
 const dir=h.project('browser');const id=await newSession(h,dir,{permission:[{permission:'*',pattern:'*',action:'allow'}]});
 h.scripted.setResponses([async context=>{seen=(context.tools??[]).map(tool=>tool.name);return fauxAssistantMessage([fauxToolCall('desktop_browser_browser_navigate',{})],{stopReason:'toolUse'});},fauxAssistantMessage('done')]);
 await h.command(promptCommand(h,'browser-first',id,dir,'use browser'));
 await h.waitReceipt('browser-first',['completed']);
 expect(seen).toContain('desktop_browser_browser_navigate');expect(calls).toBe(1);
});
