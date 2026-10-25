// @vitest-environment jsdom
import {act,createElement,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
const fixture=vi.hoisted(()=>({state:null as any,listeners:new Set<()=>void>()}));
vi.mock('../src/state/store',()=>({
 useAppState:()=>useSyncExternalStore(cb=>{fixture.listeners.add(cb);return()=>fixture.listeners.delete(cb);},()=>fixture.state),
 // Mirrors the actual store port ChatView uses (single runtime: engine tag 'pi';
 // isLegacySession decides whether live stream status applies).
 store:{get state(){return fixture.state;},pendingInteraction:()=>({permissions:[],questions:[]}),setConversationAtBottom:()=>{},engineIdFor:()=> 'pi',handoffOrigin:()=>null,isPiSession:()=>true,
 isLegacySession:(id:string|null)=>!!id&&!!fixture.state?.legacy?.includes(id),isProjectless:()=>false,
 setUi:(patch:any)=>{fixture.state={...fixture.state,ui:{...fixture.state.ui,...patch}};for(const cb of fixture.listeners)cb();}},
}));
vi.mock('../src/components/WorkspacePicker',()=>({WorkspacePicker:()=>null}));
vi.mock('../src/components/render',()=>({
 UserMessageView:({message}:any)=>createElement('span',{'data-scroll-anchor':message.id},message.id),
 AssistantTurnView:({messages,active}:any)=>createElement('span',{'data-active':active},messages.map((m:any)=>m.id).join(' ')),
 PermissionCard:()=>null,QuestionCard:()=>null,
}));
import {ChatView} from '../src/components/ChatView';
import {emptySessionChat,type SessionChatState} from '../src/state/chatReducer';
// Faithful SessionChatState (the reducer's own empty slot): every message has its
// text part recorded in `parts` + `partsByMessage`, exactly as the reducer stores it.
function append(slot:SessionChatState,id:string){slot.messageOrder.push(id);slot.messages[id]={id,sessionID:'s',role:'user',time:{created:1}} as any;slot.parts[id+':t']={id:id+':t',messageID:id,sessionID:'s',type:'text',text:id} as any;slot.partsByMessage[id]=[id+':t'];}
function chat(prefix:string,n:number):SessionChatState{const slot={...emptySessionChat(),status:{type:'busy'} as const};for(let i=0;i<n;i++)append(slot,prefix+i);return slot;}
let cleanup=()=>{};
afterEach(()=>{cleanup();vi.unstubAllGlobals();document.body.innerHTML='';fixture.listeners.clear();});
it('mounts bounded tails across live growth and repeated chat switches, and preserves reading/reveal/navigation',()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 const a=chat('a',20000),b=chat('b',5000);
 fixture.state={prefs:{endpoint:'test'},directory:'fixture',activeSessionId:'a',chat:{sessions:{a,b}},ui:{},connection:{streamState:'open'},historyCursors:{},olderExhausted:{}};
 const el=document.createElement('div');document.body.append(el);const root=createRoot(el);cleanup=()=>act(()=>root.unmount());
 act(()=>root.render(createElement(ChatView)));
 const ids=()=>Array.from(el.querySelectorAll<HTMLElement>('[data-message-ids]'),x=>x.dataset.messageIds);
 const publish=(patch:any)=>act(()=>{fixture.state={...fixture.state,...patch};for(const cb of fixture.listeners)cb();});
 const click=(label:string)=>act(()=>{const button=Array.from(el.querySelectorAll('button')).find(x=>(x.textContent??'').includes(label));expect(button).toBeTruthy();button!.click();});
 expect(ids()).toHaveLength(60);expect(ids()[0]).toBe('a19940');
 for(let n=0;n<100;n++){append(a,'live'+n);publish({});expect(ids()).toHaveLength(60);}
 for(let n=0;n<10;n++){publish({activeSessionId:'b'});expect(ids()).toHaveLength(60);publish({activeSessionId:'a'});expect(ids()).toHaveLength(60);}
 click('предыдущих');expect(ids()).toHaveLength(120);const first=ids()[0];
 append(a,'another');publish({});expect(ids()[0]).toBe(first);expect(ids()).toHaveLength(120);
 publish({activeSessionId:'b'});publish({activeSessionId:'a'});expect(ids()[0]).toBe(first);expect(ids()).toHaveLength(120);
 publish({ui:{revealMessage:{sessionID:'a',directory:'fixture',server:'test',messageID:'a500'}}});expect(ids()[0]).toBe('a500');expect(document.activeElement?.getAttribute('data-message-ids')).toBe('a500');
 click('Следующие сообщения');expect(ids()[0]).toBe('a560');expect(ids()).toHaveLength(120);
 click('Вниз');expect(ids()).toHaveLength(60);expect(ids().at(-1)).toBe('another');
});
it('a broken stream marks a live chat unconfirmed, never a read-only legacy archive',()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 fixture.state={prefs:{endpoint:'test'},directory:'fixture',activeSessionId:'a',chat:{sessions:{a:chat('a',3),old:chat('old',3)}},ui:{},connection:{streamState:'reconnecting'},historyCursors:{},olderExhausted:{},legacy:['old']};
 const el=document.createElement('div');document.body.append(el);const root=createRoot(el);cleanup=()=>act(()=>root.unmount());
 act(()=>root.render(createElement(ChatView)));
 expect(el.querySelector('.status-line[role="alert"]')).toBeTruthy();
 act(()=>{fixture.state={...fixture.state,activeSessionId:'old'};for(const cb of fixture.listeners)cb();});
 expect(el.querySelector('.status-line[role="alert"]')).toBeNull();
 expect(Array.from(el.querySelectorAll<HTMLElement>('[data-message-ids]'),x=>x.dataset.messageIds)).toEqual(['old0','old1','old2']);
});
// A busy slot seen through a broken stream (or failed status check) is not
// confirmed running: the alert replaces the "working" spinner, never both.
it('an unconfirmed live chat shows the alert instead of the working spinner',()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 fixture.state={prefs:{endpoint:'test'},directory:'fixture',activeSessionId:'a',chat:{sessions:{a:chat('a',3)}},ui:{},connection:{streamState:'reconnecting'},historyCursors:{},olderExhausted:{}};
 const el=document.createElement('div');document.body.append(el);const root=createRoot(el);cleanup=()=>act(()=>root.unmount());
 const publish=(connection:any)=>act(()=>{fixture.state={...fixture.state,connection};for(const cb of fixture.listeners)cb();});
 act(()=>root.render(createElement(ChatView)));
 expect(el.querySelector('.status-line[role="alert"]')?.textContent).toContain('Выполнение не подтверждено');
 expect(el.textContent).not.toContain('Агент работает');
 publish({streamState:'open'});
 expect(el.querySelector('.status-line[role="alert"]')).toBeNull();
 expect(el.querySelector('.status-line[role="status"]')?.textContent).toContain('Агент работает');
 publish({streamState:'open',statusError:'нет доступа'});
 expect(el.querySelector('.status-line[role="alert"]')?.textContent).toContain('Не удалось проверить состояние чата: нет доступа');
 expect(el.textContent).not.toContain('Агент работает');
});
