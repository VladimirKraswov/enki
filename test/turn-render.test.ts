// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {createElement,act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import type {AssistantMessage,MessagePart} from '../src/api/types';
const data=vi.hoisted(()=>({parts:{} as Record<string,MessagePart>,partsByMessage:{} as Record<string,string[]>,messageOrder:[] as string[],status:"busy",connected:true}));
vi.mock('../src/state/store',()=>({useAppState:()=>({chat:{sessions:{s:data}},connection:{phase:'connected',streamState:data.connected?'open':'closed'}}),useAppSelector:(select:any)=>select({chat:{sessions:{s:data}},connection:{phase:'connected',streamState:data.connected?'open':'closed'}}),store:{isRunning:()=>true,activityStatus:()=>({type:data.status}),isPiSession:()=>false,isLegacySession:(id:string)=>id==='archive'}}));
import {AssistantTurnView,UserMessageView} from '../src/components/render';
import {MessageEdit} from '../src/components/MessageEdit';
let root:Root|undefined;
afterEach(()=>{if(root)act(()=>root!.unmount());root=undefined;document.body.innerHTML='';data.parts={};data.partsByMessage={};data.status='busy';data.connected=true;vi.unstubAllGlobals();});
const message=(id:string,finish='tool-calls'):AssistantMessage=>({id,sessionID:'s',role:'assistant',parentID:'u',finish,time:{created:1000,completed:2000},modelID:'local',tokens:{output:10}});
function parts(id:string,values:Partial<MessagePart>[]) {data.partsByMessage[id]=values.map((p,i)=>{const key=`${id}_${i}`;data.parts[key]={id:key,messageID:id,sessionID:'s',type:'text',...p};return key;});}
function mount(messages:AssistantMessage[],active=false) {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 if(!root){const el=document.createElement('div');document.body.append(el);root=createRoot(el);}
 act(()=>root!.render(createElement(AssistantTurnView,{sessionId:'s',messages,active})));
}
const toggle=()=>document.querySelector<HTMLButtonElement>('.turn-progress-toggle')!;
it('renders a completed task with one final copy/footer and readable, expandable progress',async()=>{
 const clipboard=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,'clipboard',{value:{writeText:clipboard},configurable:true});
 parts('a',[{type:'reasoning',text:'Thinking privately'},{text:'Проверяю сборку'},{type:'tool',tool:'bash',state:{status:'completed',title:'npm test',input:{command:'npm test',description:'Проверка тестов'},output:'PASS',time:{start:100,end:101}}}]);
 parts('b',[{text:'## Готово\n\nТесты прошли.'}]);mount([message('a'),message('b','stop')]);
 expect(toggle().getAttribute('aria-expanded')).toBe('false');expect(document.querySelector('.turn-step')?.hasAttribute('hidden')).toBe(true);
 expect(document.querySelectorAll('.message-footer')).toHaveLength(1);expect(document.querySelectorAll('[aria-label="Копировать весь ответ"]')).toHaveLength(1);
 act(()=>toggle().click());expect(document.querySelector('.turn-step')?.hasAttribute('hidden')).toBe(false);
 expect(document.querySelector('.tool .fold-head')?.textContent).toContain('Проверка тестов');expect(document.querySelector('.tool-duration')?.textContent).toBe('<0,1 с');
 expect(document.querySelector('.reasoning button')?.getAttribute('aria-expanded')).toBe('false');
 await act(async()=>(document.querySelector('[aria-label="Копировать весь ответ"]') as HTMLButtonElement).click());
 expect(clipboard).toHaveBeenCalledWith('## Готово\n\nТесты прошли.');
});
it('keeps live history open and existing anchors/folds intact when the final answer arrives',()=>{
 parts('a',[{type:'reasoning',text:'Reasoning'},{text:'Doing work'}]);mount([message('a')],true);
 act(()=>(document.querySelector('.reasoning button') as HTMLButtonElement).click());
 const step=document.querySelector('[data-scroll-anchor="message:a"]');
 parts('b',[{text:'Final answer'}]);mount([message('a'),message('b','stop')]);
 expect(toggle().getAttribute('aria-expanded')).toBe('true');expect(document.querySelector('[data-scroll-anchor="message:a"]')).toBe(step);
 expect(document.querySelector('.reasoning button')?.getAttribute('aria-expanded')).toBe('true');
});
it('keeps explicit collapse through updates while surfacing tool errors and aborted/budget-limited turns',()=>{
 parts('a',[{type:'tool',tool:'bash',state:{status:'error',error:'FAIL'}}]);mount([message('a')],true);
 act(()=>toggle().click());parts('b',[{text:'Partial answer'}]);mount([message('a'),{...message('b','length')}]);
 expect(toggle().getAttribute('aria-expanded')).toBe('false');expect(toggle().textContent).toContain('Ошибок инструментов: 1');
 expect(document.querySelector('.finish-note')?.closest('[hidden]')).toBeNull();expect(document.querySelector('.turn-answer')).toBeNull();
 mount([message('a'),{...message('b','stop'),error:{name:'MessageAbortedError'}}]);
 expect(document.querySelector('[role="alert"]')?.textContent).toBe('Ответ остановлен.');expect(document.querySelector('[role="alert"]')?.closest('[hidden]')).toBeNull();
});
it('does not show a final copy or phantom whitespace for an in-progress tool-only step',()=>{
 parts('a',[{type:'step-start'},{text:'\n\n'},{type:'tool',tool:'bash',state:{status:'running'}},{type:'step-finish'}]);mount([{...message('a'),time:{created:1000},finish:undefined}],true);
 expect(document.querySelectorAll('.msg-assistant > [data-scroll-anchor]')).toHaveLength(1);
 expect(document.querySelector('.message-footer')).toBeNull();expect(document.querySelector('.turn-answer')).toBeNull();
});
it('restores the user disclosure state when returning to a conversation',()=>{
 const progressState:Record<string,boolean>={};parts('a',[{text:'Reading progress'}]);
 mount([message('a')],true);
 act(()=>root!.render(createElement(AssistantTurnView,{sessionId:'s',messages:[message('a')],active:true,progressState,progressKey:'turn:u'})));
 expect(progressState['turn:u']).toBe(true);
 act(()=>root!.unmount());root=undefined;
 parts('b',[{text:'Done'}]);mount([message('a'),message('b','stop')]);
 // A different key simulates the conversation component remount on navigation.
 act(()=>root!.render(createElement(AssistantTurnView,{key:'restored',sessionId:'s',messages:[message('a'),message('b','stop')],progressState,progressKey:'turn:u'})));
 expect(toggle().getAttribute('aria-expanded')).toBe('true');
 act(()=>toggle().click());expect(progressState['turn:u']).toBe(false);
});
it('keeps internal compaction summaries folded and never calls them unfinished answers',()=>{
 parts('summary',[{text:'Large internal checkpoint'}]);mount([{...message('summary','stop'),summary:true}]);
 expect(toggle().textContent).toContain('Сжатие контекста');expect(toggle().getAttribute('aria-expanded')).toBe('false');
 expect(document.querySelector('.turn-step')?.hasAttribute('hidden')).toBe(true);
 expect(document.querySelector('[aria-label="Копировать незавершённый ответ"]')).toBeNull();
 expect(document.querySelector('[aria-label="Копировать сводку"]')).not.toBeNull();
});

it("historical unfinished tools do not claim execution when the server is idle",()=>{
 parts('a',[{type:'tool',tool:'bash',state:{status:'running'}}]);
 mount([message('a','stop')]);
 expect(document.querySelector('.tool-spinner')).toBeNull();
 expect(document.body.textContent).toContain('выполнение не подтверждено сервером');
});

it('unfinished historical tools require both a busy server and live connection',()=>{
 parts('a',[{type:'tool',tool:'bash',state:{status:'running'}}]);
 const unfinished={...message('a'),finish:undefined,time:{created:1000}};
 data.status='idle';mount([unfinished]);expect(document.querySelector('.tool-spinner')).toBeNull();
 expect(document.body.textContent).toContain('выполнение не подтверждено сервером');
 data.status='busy';data.connected=false;mount([{...unfinished}],true);expect(document.querySelector('.tool-spinner')).toBeNull();
 expect(document.body.textContent).toContain('статус не подтверждён: нет связи');
});

it('a correction renders as a labelled compact note, ordinary user messages stay ordinary',()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 parts('u',[{text:'Учитывай Windows',metadata:{arvelaSteering:1}},{text:'hidden guidance',synthetic:true}]);
 const el=document.createElement('div');document.body.append(el);root=createRoot(el);
 const message={id:'u',sessionID:'s',role:'user' as const,time:{created:1000}};
 act(()=>root!.render(createElement(UserMessageView,{message})));
 expect(el.querySelector('.user-message-steering')).not.toBeNull();expect(el.textContent).toContain('Уточнение');expect(el.textContent).not.toContain('hidden guidance');
 parts('u',[{text:'Новая задача'}]);act(()=>root!.render(createElement(UserMessageView,{message})));
 expect(el.querySelector('.user-message-steering')).toBeNull();expect(el.textContent).not.toContain('Уточнение');
});
// Regression: the edit action was hidden for EVERY chat by a constant
// isPiSession()===true; only read-only archives lack it now.
it('a live sent message offers "edit in a new branch"; a read-only archive does not',()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 parts('u',[{text:'Сделай отчёт'}]);
 const el=document.createElement('div');document.body.append(el);root=createRoot(el);
 act(()=>root!.render(createElement(UserMessageView,{message:{id:'u',sessionID:'s',role:'user' as const,time:{created:1000}}})));
 const edit=el.querySelector<HTMLButtonElement>('[aria-label="Редактировать сообщение"]');
 expect(edit).not.toBeNull();
 expect(edit!.disabled).toBe(true); // the mocked chat is running: wait for it to finish
 act(()=>root!.render(createElement(MessageEdit,{message:{id:'u',sessionID:'archive',role:'user' as const,time:{created:1000}},text:'x'})));
 expect(el.querySelector('[aria-label="Редактировать сообщение"]')).toBeNull();
});
it('does not parse or mount folded historical steps until opened, then preserves their local state',()=>{
 parts('a',[{text:'```js\nconst hidden = 1;\n```'}]);parts('b',[{text:'Final'}]);
 mount([message('a'),message('b','stop')]);
 expect(document.querySelector('.turn-step .md')).toBeNull();
 act(()=>toggle().click());
 expect(document.querySelector('.turn-step .code-block')).not.toBeNull();
 act(()=>(document.querySelector('[aria-label="Изменить копию кода"]') as HTMLButtonElement).click());
 const editor=document.querySelector('textarea');
 act(()=>toggle().click());act(()=>toggle().click());
 expect(document.querySelector('textarea')).toBe(editor);
});
it('does not serialize a large tool input while its card is closed',()=>{
 const serialize=vi.fn(()=>({command:'large data'}));
 parts('a',[{type:'tool',tool:'bash',state:{status:'completed',input:{toJSON:serialize},output:'PASS'}}]);
 mount([message('a')],true);
 expect(serialize).not.toHaveBeenCalled();
 act(()=>(document.querySelector('.tool .fold-head') as HTMLButtonElement).click());
 expect(serialize).toHaveBeenCalledOnce();expect(document.querySelector('.fold-body')?.textContent).toContain('large data');
});
