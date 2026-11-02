import { describe,it,expect } from 'vitest';
import { record,redact } from '../src/hub/records';
import type { AssistantMessage,MessagePart } from '../src/api/types';
const session={id:'s',title:'Task',directory:'/Users/owner/project'};
const msg:AssistantMessage={id:'m',sessionID:'s',role:'assistant',time:{created:100,completed:200},modelID:'actual',providerID:'local',variant:'medium',tokens:{input:10,output:20,reasoning:12,cache:{read:30,write:2}}};
const part=(type:string,text?:string):MessagePart=>({id:type,sessionID:'s',messageID:'m',type,text});
describe('private session records',()=>{
 it('reports actual model and reasoning as subset, with no private paths',()=>{const r=record('pi',session,msg,[part('text','result')],true)!;expect(r.model).toBe('actual');expect(r.variant).toBe('medium');expect(r.tokens.total).toBe(62);expect(r.tokens.reasoning).toBe(12);expect(r.project).toBe('project');expect(JSON.stringify(r)).not.toContain('/Users');});
 it('does not serialize reasoning, files or tool raw payloads',()=>{const tool:MessagePart={...part('tool'),tool:'browser',state:{status:'completed',input:{password:'PRIVATE_INPUT'},output:'PRIVATE_OUTPUT',time:{start:110,end:180}}};const r=record('opencode',session,msg,[part('reasoning','PRIVATE_REASONING'),{...part('file'),url:'data:image/png;base64,PRIVATE_FILE'},tool],true)!;expect(JSON.stringify(r)).not.toContain('PRIVATE_');expect(r.tools[0].durationMs).toBe(70);});
 it('only queues completed assistant messages',()=>{expect(record('pi',session,{...msg,time:{created:100}},[part('text','partial')],true)).toBeNull();});
 it('queues a failed tool before the answer completes without sending its command or raw output',()=>{
  const tool:MessagePart={...part('tool'),tool:'bash',callID:'call1',state:{status:'error',input:{command:'PRIVATE_COMMAND'},output:'PRIVATE_OUTPUT',error:'password=hidden failed',time:{start:110,end:180}}};
  const r=record('pi',session,{...msg,time:{created:100}},[part('text','partial'),tool],false)!;
  expect(r.completed).toBe(0);expect(r.tools[0]).toMatchObject({id:'call1',status:'error',durationMs:70});
  expect(r.text).toBe('');expect(JSON.stringify(r)).not.toMatch(/PRIVATE_|hidden|partial/);
 });
 it('can send metrics without visible text',()=>{expect(record('pi',session,msg,[part('text','visible')],false)?.text).toBe('');});
 it('strips known credential formats before durable storage',()=>{const x=redact('apiKey: sk-abcdefghijk password="hidden" https://u:p@host/?token=secret C:\\Users\\private\\file');expect(x).not.toMatch(/abcdefgh|hidden|secret|private|u:p/);});
 it('redacts shorthand and Russian passwords',()=>{expect(redact('pas=private-value пароль: another-value')).not.toMatch(/private-value|another-value/);});
 it('preserves filtered text across queue, server and replay redaction',()=>{
  for(const raw of ['apiKey: sk-abcdefghijk','password=hidden','Bearer secret-token','https://host/?token=hidden&x=1','authorization: Bearer hidden','C:\\Users\\owner\\file']){
   const once=redact(raw);expect(redact(once)).toBe(once);expect(redact(redact(once))).toBe(once);expect(once).not.toContain('hidden');
  }
 });
 it('bounds final answers and marks truncation',()=>{const r=record('pi',session,msg,[part('text','z'.repeat(18000))],true)!;expect(r.text.length).toBe(16000);expect(r.truncated).toBe(true);});
 it('never serializes an error object including private request headers',()=>{const r=record('pi',session,{...msg,error:{name:'Failure',data:{message:'apiKey=hidden',headers:{Authorization:'UNSAFE'}}}},[],true)!;expect(JSON.stringify(r)).not.toContain('UNSAFE');expect(r.error).not.toContain('hidden');});
 it('does not invent token usage when provider has none',()=>{const r=record('pi',session,{...msg,tokens:undefined},[],true)!;expect(r.tokens.total).toBe(0);});
});
