import {expect,it,vi,afterEach} from 'vitest';
import {taskDiagnostics} from '../src/diagnostics/tasks';
import {applyHistory,emptyChatRoot,reduceEvent} from '../src/state/chatReducer';
import type {Message,MessagePart} from '../src/api/types';
const u:Message={id:'u',sessionID:'s',role:'user',time:{created:1000}};
const a:Message={id:'a',sessionID:'s',role:'assistant',parentID:'u',time:{created:2000,completed:6000},finish:'stop',tokens:{input:20,output:10}};
const tool=(id:string,start:number,end:number):MessagePart=>({id,sessionID:'s',messageID:'a',callID:id,type:'tool',tool:'read',state:{status:'completed',time:{start,end}}});
afterEach(()=>vi.useRealTimers());
it('bounds each request, deduplicates calls, unions phase overlap and never calls idle a verified result',()=>{
 const root=emptyChatRoot();applyHistory(root,'s',[{info:u,parts:[]},{info:a,parts:[tool('t',2000,4000),tool('t',2000,4000),tool('t2',3000,5000),{id:'r',sessionID:'s',messageID:'a',type:'reasoning',time:{start:2500,end:3500}}]},{info:{...u,id:'u2',time:{created:7000}},parts:[]}]);
 const d=taskDiagnostics(root.sessions.s,'u')!;expect(d.wallMs).toBe(5000);expect(d.toolMs).toBe(3000);expect(d.reasoningMs).toBe(1000);expect(d.unattributedMs).toBe(2000);expect(d.calls).toBe(2);expect(d.repeatedCalls).toBe(1);expect(d.firstResponseMs).toBeNull();expect(d.reasoning).toBeNull();expect(d.state).toBe('ended');expect(taskDiagnostics(root.sessions.s)?.wallMs).toBeNull();
});
it('keeps unknown Pi history duration and missing/partial token usage unknown',()=>{
 const root=emptyChatRoot();applyHistory(root,'s',[{info:{...u,timingSource:'entry'},parts:[]},{info:{...a,timingSource:'entry',time:{created:6000,completed:6000},tokens:undefined},parts:[tool('t',6000,6500)]}]);
 const d=taskDiagnostics(root.sessions.s)!;expect(d.wallMs).toBeNull();expect(d.toolMs).toBeNull();expect(d.output).toBeNull();expect(d.usageComplete).toBe(false);
});
it('measures dispatch/queue/preparation and live response once; retains stable Pi observation identity after history resync',()=>{
 vi.useFakeTimers();const root=emptyChatRoot();applyHistory(root,'s',[]);root.sessions.s.pendingTiming={dispatchAt:1500,preparationMs:300,queueMs:200};
 vi.setSystemTime(1600);reduceEvent(root,{type:'message.updated',properties:{info:{...u,timingSource:'live',timingKey:'pi:user:1600'}}});
 vi.setSystemTime(1800);reduceEvent(root,{type:'message.updated',properties:{info:{...a,time:{created:1800}}}});
 vi.setSystemTime(2200);reduceEvent(root,{type:'message.part.delta',id:'delta',properties:{sessionID:'s',messageID:'a',partID:'p',field:'text',delta:'private'}});
 vi.setSystemTime(2400);reduceEvent(root,{type:'message.part.delta',id:'delta',properties:{sessionID:'s',messageID:'a',partID:'p',field:'text',delta:'private'}});
 vi.setSystemTime(6000);reduceEvent(root,{type:'session.idle',properties:{sessionID:'s'}});
 applyHistory(root,'s',[{info:{...u,id:'durable',timingSource:'entry',timingKey:'pi:user:1600'},parts:[]},{info:{...a,timingSource:'entry'},parts:[]}]);
 const d=taskDiagnostics(root.sessions.s,'durable')!;expect(d.queueMs).toBe(200);expect(d.preparationMs).toBe(300);expect(d.firstResponseMs).toBe(700);expect(d.wallMs).toBe(5000);expect(JSON.stringify(d)).not.toContain('private');expect(root.sessions.s.pendingTiming).toBeUndefined();
});
it('does not attribute an older explicit parent to a steered task or invent unobserved dispatch',()=>{
 vi.useFakeTimers();const root=emptyChatRoot();applyHistory(root,'s',[{info:u,parts:[]}]);
 vi.setSystemTime(7000);reduceEvent(root,{type:'message.updated',properties:{info:{...u,id:'u2'}}});reduceEvent(root,{type:'message.updated',properties:{info:a}});
 reduceEvent(root,{type:'message.part.delta',properties:{sessionID:'s',messageID:'a',partID:'p',field:'text',delta:'late old answer'}});
 expect(taskDiagnostics(root.sessions.s,'u2')?.firstResponseMs).toBeNull();expect(taskDiagnostics(root.sessions.s,'u2')?.preparationMs).toBeNull();
});
it('distinguishes error/abort and refuses ambiguous observation identities',()=>{
 const root=emptyChatRoot();applyHistory(root,'s',[{info:u,parts:[]},{info:{...a,error:{name:'MessageAbortedError'}},parts:[]}]);expect(taskDiagnostics(root.sessions.s)?.state).toBe('aborted');
 applyHistory(root,'s',[{info:{...u,timingKey:'collision'},parts:[]},{info:{...u,id:'u2',timingKey:'collision'},parts:[]},{info:{...a,parentID:'u2',error:{message:'fail'}},parts:[]}]);root.sessions.s.taskObservations={collision:{dispatchAt:0,preparationMs:100,queueMs:100,startedAt:0,firstAt:10,retries:0,tools:{}}};expect(taskDiagnostics(root.sessions.s)?.firstResponseMs).toBeNull();expect(taskDiagnostics(root.sessions.s)?.state).toBe('error');
});
// The runtime's SDK translator (src-tauri/resources/agent/src/sdk) replaced the
// frontend Pi CLI translator; the reducer/diagnostics consume its DTO events.
it('links actual runtime translator events to actual durable entries without retaining user content',async()=>{
 const {StreamTranslator}=await import('../src-tauri/resources/agent/src/sdk/translate');
 const {entriesToMessages}=await import('../src-tauri/resources/agent/src/sdk/history');vi.useFakeTimers();
 const root=emptyChatRoot();applyHistory(root,'s',[]);root.sessions.s.pendingTiming={dispatchAt:1000,preparationMs:100,queueMs:0};const tr=new StreamTranslator('s');
 const deliver=(events:unknown[],now:number)=>{vi.setSystemTime(now);for(const e of events)reduceEvent(root,e as any);};
 const userEntry={id:'durable-user',type:'message',timestamp:new Date(1100).toISOString(),message:{role:'user',timestamp:1100,content:'synthetic request'}};
 const assistantEntry={id:'durable-assistant',type:'message',timestamp:new Date(1950).toISOString(),message:{role:'assistant',timestamp:1200,content:[{type:'text',text:'synthetic answer'}],stopReason:'stop',provider:'p',model:'m'}};
 deliver(tr.translate({type:'message_start',message:userEntry.message} as any),1100);
 // The worker publishes the persisted user entry: the live echo is replaced under the same timing key.
 deliver(tr.appended(userEntry as any),1150);
 deliver(tr.translate({type:'message_start',message:{role:'assistant',timestamp:1200,content:[]}} as any),1200);
 deliver(tr.translate({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'synthetic answer'}} as any),1500);
 deliver(tr.translate({type:'message_end',message:assistantEntry.message} as any),1900);
 deliver(tr.appended(assistantEntry as any),1950);
 deliver(tr.translate({type:'agent_settled'} as any),2000);
 expect(root.sessions.s.messageOrder).toEqual(['durable-user','durable-assistant']);
 applyHistory(root,'s',entriesToMessages('s',[userEntry,assistantEntry] as any) as any);
 const d=taskDiagnostics(root.sessions.s,'durable-user');
 expect(d).toMatchObject({source:'observed',firstResponseMs:500,wallMs:1100,state:'ended'});
 expect(JSON.stringify(d)).not.toContain('synthetic');
});
