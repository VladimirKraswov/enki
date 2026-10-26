// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {store} from '../src/state/store';
import {attachmentDrafts,attachmentScope} from '../src/attachments/drafts';
import {questionInputKey} from '../src/components/QuestionAnswerInput';
import {QuestionCard} from '../src/components/QuestionCard';
import {PiDialog} from '../src/components/PiDialog';
import {nativeDropTargetsQuestion} from '../src/attachments/native-drop';
import type {QuestionRequest} from '../src/api/types';
vi.mock('../src/components/VoiceInput',()=>({VoiceInput:({draftTarget}:{draftTarget:string})=>createElement('button',{
 'aria-label':'Надиктовать',onClick:()=>store.appendDictation('question-workspace',draftTarget,'Продиктованный ответ',crypto.randomUUID())
},'mic')}));
vi.hoisted(()=>{Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addEventListener(){},removeEventListener(){}})});});
let root:Root|undefined;let old:typeof store.state;let req:QuestionRequest;
beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);old=store.state;
 store.state={...old,prefs:{...old.prefs,workspaceKey:'question-workspace',drafts:{},dictationReceipts:[]},directory:'/question-project',activeSessionId:'question-session'};
 req={id:crypto.randomUUID(),sessionID:'question-session',questions:[{question:'Как сделать?',options:[{label:'Вариант'}]}]};
});
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;store.state=old;document.body.innerHTML='';vi.unstubAllGlobals();});
async function show(reply=vi.fn(async()=>true)) {
 if(!root){const div=document.createElement('div');document.body.append(div);root=createRoot(div);}
 await act(async()=>{root!.render(createElement(QuestionCard,{req,onReply:reply,onReject:vi.fn()}));});return reply;
}
function scope(){return attachmentScope('question-workspace','/question-project',`@question:${req.id}`);}
function send(){return [...document.querySelectorAll('button')].find(b=>b.textContent==='Отправить ответ')!;}
async function pasteFile(){
 const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{files:[new File(['заметка'],'note.txt',{type:'text/plain'})]}});
 await act(async()=>{document.querySelector('textarea')!.dispatchEvent(event);await attachmentDrafts.flush();});
}
it('dictation targets the question draft, survives remount, and leaves the ordinary prompt intact',async()=>{
 store.setDraft('Обычный запрос');await show();
 act(()=>document.querySelector<HTMLButtonElement>('[aria-label="Надиктовать"]')!.click());
 expect((document.querySelector('textarea')as HTMLTextAreaElement).value).toBe('Продиктованный ответ');expect(store.getDraft()).toBe('Обычный запрос');
 await act(async()=>root!.unmount());root=undefined;await show();expect((document.querySelector('textarea')as HTMLTextAreaElement).value).toBe('Продиктованный ответ');
});
it('pasted files belong only to the answer and survive a failed reply',async()=>{
 const reply=await show(vi.fn(async()=>false));await pasteFile();
 expect(attachmentDrafts.snapshot(scope())).toHaveLength(1);
 expect(attachmentDrafts.snapshot(attachmentScope('question-workspace','/question-project','question-session'))).toHaveLength(0);
 await act(async()=>{send().click();});expect(reply).toHaveBeenCalledWith([['См. приложенные файлы.']],expect.arrayContaining([expect.objectContaining({name:'note.txt'})]));
 expect(attachmentDrafts.snapshot(scope())).toHaveLength(1);expect(document.querySelector('[role="alert"]')?.textContent).toContain('сохранены');
});
it('successful acknowledgement clears only the answer, not the main prompt',async()=>{
 store.setDraft('Следующая задача');const reply=await show();await pasteFile();act(()=>store.setInputDraft(questionInputKey(req.id,0),'Вот файл'));
 await act(async()=>{send().click();await vi.waitFor(()=>expect(store.state.prefs.drafts[questionInputKey(req.id,0)]).toBe(''));});expect(reply).toHaveBeenCalledTimes(1);expect(attachmentDrafts.snapshot(scope())).toEqual([]);
 expect(store.state.prefs.drafts[questionInputKey(req.id,0)]).toBe('');expect(store.getDraft()).toBe('Следующая задача');
});
it('dictation replaces a single-choice selection without sending two conflicting answers',async()=>{
 const reply=await show();act(()=>document.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
 act(()=>document.querySelector<HTMLButtonElement>('[aria-label="Надиктовать"]')!.click());await act(async()=>{send().click();});
 expect(reply).toHaveBeenCalledWith([['Продиктованный ответ']],[]);
});
it('a rapid double click sends one answer while acknowledgement is pending',async()=>{
 let acknowledge:(value:boolean)=>void=()=>{};const reply=vi.fn(()=>new Promise<boolean>(resolve=>{acknowledge=resolve;}));
 await show(reply);act(()=>store.setInputDraft(questionInputKey(req.id,0),'Да'));
 await act(async()=>{send().click();send().click();});expect(reply).toHaveBeenCalledTimes(1);
 await act(async()=>{acknowledge(true);});
});
it('native drop hit-testing separates question files from the main composer at Retina scale',async()=>{
 await show();const field=document.querySelector('textarea')!;field.focus();
 const hit=vi.fn(()=>field);Object.defineProperty(document,'elementFromPoint',{configurable:true,value:hit});vi.stubGlobal('devicePixelRatio',2);
 expect(nativeDropTargetsQuestion({x:200,y:100})).toBe(true);expect(hit).toHaveBeenCalledWith(100,50);
 hit.mockReturnValue(document.body as any);expect(nativeDropTargetsQuestion({x:200,y:100})).toBe(false);
});
it('text extension dialogs use a separate durable microphone target too',async()=>{
 store.state={...store.state,ui:{...store.state.ui,agentDialog:{id:'dialog-mic',sessionID:'question-session',directory:'/question-project',method:'input',title:'Ответ расширению',deadline:Date.now()+60000}}};
 const div=document.createElement('div');document.body.append(div);root=createRoot(div);await act(async()=>root!.render(createElement(PiDialog)));
 act(()=>document.querySelector<HTMLButtonElement>('[aria-label="Надиктовать"]')!.click());
 expect(document.querySelector<HTMLInputElement>('[aria-label="Ответ расширению"] input')?.value).toBe('Продиктованный ответ');
 expect(store.state.prefs.drafts[questionInputKey('dialog:dialog-mic',0)]).toBe('Продиктованный ответ');
});
it('a long dictated answer is sent in full as a text attachment',async()=>{
 const text='Подробный ответ. '.repeat(800), reply=await show();
 act(()=>store.setInputDraft(questionInputKey(req.id,0),text));await act(async()=>{send().click();});
 const [answers,files]=reply.mock.calls[0] as unknown as [string[][],Array<{size:number;name:string}>];
 expect(answers[0][0]).toContain('Подробный ответ приложен');expect(files[0].name).toBe('Ответ на вопрос 1.txt');expect(files[0].size).toBe(new Blob([text.trim()]).size);
});
