import {expect,it} from 'vitest';
import {partsPresentation} from '../src/chat/presentation';
import {emptyChatRoot,reduceEvent} from '../src/state/chatReducer';
import {selectedSnapshot,shallowEqual} from '../src/state/notifications';
import type {AppState} from '../src/state/types';
it('keeps message presentation stable through background deltas but sees same-tick in-place slot updates',()=>{
 const state={chat:emptyChatRoot(),connection:{}} as AppState;
 const delta=(sessionID:string,partID:string)=>reduceEvent(state.chat,{type:'message.part.delta',properties:{sessionID,messageID:'m',partID,field:'text',delta:'x'}});
 delta('visible','p');
 const select=selectedSnapshot(()=>state,partsPresentation('visible',['m'],()=>state.chat.sessions.visible.status.type,()=>true),shallowEqual);
 const initial=select();
 for(let i=0;i<1000;i++){delta('background','other');expect(select()).toBe(initial);}
 const oldSlot=state.chat.sessions.visible;
 delta('visible','p');expect(state.chat.sessions.visible).toBe(oldSlot);
 const next=select();expect(next).not.toBe(initial);expect(next.parts[0].text).toBe('xx');
 reduceEvent(state.chat,{type:'message.part.removed',properties:{sessionID:'visible',partID:'p'}});
 expect(select().parts).toHaveLength(0);
 state.chat.sessions.visible.status={type:'busy'};expect(select().status).toBe('busy');
});
it('scopes waiting-for-user evidence to the matching chat',()=>{
 const state={chat:emptyChatRoot()} as AppState;
 const select=partsPresentation('visible',[],()=> 'busy',()=>true);
 state.chat.questions.q={id:'q',sessionID:'other',questions:[]} as never;
 expect(select(state).waitingForUser).toBe(false);
 state.chat.questions.q={id:'q',sessionID:'visible',questions:[]} as never;
 expect(select(state).waitingForUser).toBe(true);
 delete state.chat.questions.q;expect(select(state).waitingForUser).toBe(false);
});
