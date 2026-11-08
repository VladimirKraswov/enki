import {expect,it} from 'vitest';
import type {AssistantMessage, Message, MessagePart} from '../src/api/types';
import {groupConversation, finalAnswer, visibleParts, turnMetrics, currentTurnActivity} from '../src/chat/turns';
const user=(id:string):Message=>({id,sessionID:'s',role:'user',time:{created:1}});
const assistant=(id:string,parentID='u',finish='tool-calls'):AssistantMessage=>({id,sessionID:'s',role:'assistant',parentID,finish,time:{created:2,completed:3},modelID:'qwen',tokens:{output:10}});
const text=(id='text',value='Answer'):MessagePart=>({id,sessionID:'s',messageID:'a',type:'text',text:value});
it('groups engine steps under their request without merging user steering, different parents or compaction',()=>{
 const rows=groupConversation([user('u'),assistant('a'),assistant('b'),user('v'),assistant('c','v'),assistant('d','other'),{...assistant('summary','other'),summary:true},assistant('e','other')]);
 expect(rows.map(r=>r.kind==='user'?[r.message.id]:r.messages.map(m=>m.id))).toEqual([['u'],['a','b'],['v'],['c'],['d'],['summary'],['e']]);
 expect(new Set(rows.map(r=>r.key)).size).toBe(rows.length);
});
it('keeps a turn key when older steps are prepended and when another live step arrives',()=>{
 const key=(list:Message[])=>groupConversation(list)[0].key;
 expect(key([assistant('b')])).toBe(key([assistant('a'),assistant('b'),assistant('c')]));
});
it('does not mark progress, abort, budget exhaustion, compaction or unfinished output as a final answer',()=>{
 for(const m of [assistant('a'),{...assistant('a','u','stop'),time:{created:2}},assistant('a','u','length'),{...assistant('a','u','stop'),error:{name:'MessageAbortedError'}},{...assistant('a','u','stop'),summary:true}])
  expect(finalAnswer(m,[text()])).toBe(false);
 expect(finalAnswer(assistant('a','u','stop'),[text()])).toBe(true);
 expect(finalAnswer(assistant('a','u','stop'),[text('t','  ')])).toBe(false);
 expect(finalAnswer(assistant('a','u','stop'),[text(),{...text('tool'),type:'tool',state:{status:'running'}}])).toBe(false);
});
it('removes invisible engine markers and blank placeholders but retains reasoning, tools and failures',()=>{
 expect(visibleParts([text('space','\n\n'),{...text('synthetic'),synthetic:true},{...text('ignored'),ignored:true},text('real'),{...text('reason'),type:'reasoning'}, {...text('tool'),type:'tool'}, {...text('finish'),type:'step-finish'}]).map(p=>p.id)).toEqual(['real','reason','tool']);
});
it('counts known output across steps and distinct model profiles without inventing missing usage',()=>{
 expect(turnMetrics([assistant('a'),{...assistant('b'),modelID:'deepseek',variant:'high',tokens:undefined}])).toEqual({profiles:['qwen','deepseek · high'],output:10,partial:true});
});
it('counts only current-turn tools and names the last one, so a question carries evidence of work',()=>{
 const messages=[user('u1'),assistant('a1','u1'),user('u2'),assistant('a2','u2'),assistant('a3','u2')];
 const tool=(id:string,name:string):MessagePart=>({...text(id),type:'tool',tool:name});
 const parts=(id:string):MessagePart[]=>id==='a1'?[tool('old','bash')]:id==='a2'?[tool('r','read'),tool('e','edit')]:id==='a3'?[tool('b','bash')]:[];
 expect(currentTurnActivity(messages,parts)).toEqual({actions:3,lastTool:'bash'});
 expect(currentTurnActivity([user('u1')],parts)).toBeNull();
 expect(currentTurnActivity([user('u1'),assistant('a1','u1')],()=>[])).toBeNull();
});
