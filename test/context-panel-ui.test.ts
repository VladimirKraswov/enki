// @vitest-environment jsdom
// Context panel over the runtime (shared route fixture behind store.maybeBackend).
//
// Fixed in the final UI review: children are read from the runtime
// (GET /sessions/:id/children) for every connected chat, and saving a
// recurrence awaits POST /schedules with the chat's model.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ScheduleDTO } from "../src-tauri/resources/agent/src/protocol";
import { emptySessionChat } from "../src/state/chatReducer";
import { TaskScheduler } from "../src/schedules/tasks";
import { registerComposer } from "../src/attachments/composerBridge";
import { attachmentScope } from "../src/attachments/drafts";
import { runtimeFixture, type RuntimeFixture } from "./helpers/runtime-fixture";
const fake=vi.hoisted(()=>({state:{} as any,draft:"user draft",setDraft:vi.fn(),setUi:vi.fn(),openChat:vi.fn(),loadOlder:vi.fn(),scheduler:null as any,backend:null as any}));
vi.mock("../src/state/store",()=>({useAppState:()=>fake.state,store:{currentHost:()=>null,loadOlderMessages:fake.loadOlder,engineIdFor:()=>"pi",getModelChoice:()=>({providerID:"p",modelID:"m",variant:"medium"}),getAgentChoice:()=>null,getDraft:()=>fake.draft,setDraft:fake.setDraft,setUi:fake.setUi,openChat:fake.openChat,maybeBackend:()=>fake.backend}}));
vi.mock("../src/schedules/tasks",async original=>({...await original<object>(),taskScheduler:()=>fake.scheduler}));
import { ContextPanel } from "../src/components/ContextPanel";
let root:Root,fx:RuntimeFixture,children:(c:{params:Record<string,string>;signal?:AbortSignal})=>unknown;
const dto=(id:string,extra:Partial<ScheduleDTO>={}):ScheduleDTO=>({id,directory:"/project",sessionID:"s",title:"t",prompt:"p",minutes:5,mode:"repeat",model:{providerID:"p",modelID:"m"},enabled:true,nextAt:Date.now()+60_000,state:"ready",...extra});
beforeEach(async()=>{
 HTMLDialogElement.prototype.showModal=vi.fn(function(this:HTMLDialogElement){this.open=true;});
 HTMLDialogElement.prototype.close=vi.fn(function(this:HTMLDialogElement){this.open=false;});
 vi.resetAllMocks();vi.unstubAllGlobals();vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);fake.draft="user draft";
 fx=runtimeFixture();fake.backend=fx.backend;children=()=>[];
 fx.on("GET","/sessions/:id/children",c=>children(c));
 fx.on("POST","/schedules",c=>dto("srv",{...(c.body as object)}));
 fake.scheduler=new TaskScheduler();fake.scheduler.attach(null,"local");fake.scheduler.attach(fx.backend,"local");
 await vi.waitFor(()=>expect(fake.scheduler.status().storage).toBe("ok"));
 const chat=emptySessionChat();chat.messageOrder=["u"];chat.messages.u={id:"u",sessionID:"s",role:"user",time:{created:1}};chat.partsByMessage.u=["f"];chat.parts.f={id:"f",messageID:"u",sessionID:"s",type:"file",filename:"source.pdf"};
 fake.state={prefs:{endpoint:"local",workspaceKey:"local"},directory:"/project",activeSessionId:"s",chat:{sessions:{s:chat}},connection:{phase:"connected"},ui:{sending:false},historyCursors:{},olderExhausted:{}};
 const node=document.createElement("div");document.body.append(node);root=createRoot(node);
});
afterEach(()=>{act(()=>root.unmount());document.body.innerHTML="";vi.useRealTimers();vi.unstubAllGlobals();});
const mount=()=>act(async()=>root.render(createElement(ContextPanel)));
const click=async(label:string)=>act(async()=>document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
const childReads=()=>fx.made("GET","/sessions/:id/children");

it("sources open a preview without jumping away and creating a result appends to the existing draft",async()=>{
 await mount();await act(async()=>Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="source.pdf")!.click());
 expect(document.querySelector('[aria-label="Файлы сессии"]')).not.toBeNull();
 expect(fake.setUi).not.toHaveBeenCalled();
 await click("Закрыть просмотр файлов");
 await click("Подготовить запрос на создание результата");expect(fake.setDraft).toHaveBeenCalledWith("user draft\n\nСоздай файл с результатом: ");
});

it("reads children from the runtime and cancels stale child responses after switching chat",async()=>{
 let resolve!:(v:unknown)=>void;children=()=>new Promise(r=>{resolve=r;});
 await mount();
 await vi.waitFor(()=>expect(childReads()).toHaveLength(1));
 expect(childReads()[0]).toMatchObject({path:"/sessions/s/children",query:{directory:"/project"}});
 const signal=childReads()[0].signal!;
 fake.state={...fake.state,activeSessionId:"other"};await mount();expect(signal.aborted).toBe(true);
 await act(async()=>resolve([{id:"child",parentID:"s",directory:"/project",title:"stale",projectID:"p",time:{created:1,updated:1}}]));
 expect(document.body.textContent).not.toContain("stale");
});

it("source plus uses the existing composer file picker and escape closes the disclosure",async()=>{
 const files=vi.fn(()=>true);const stop=registerComposer({scope:()=>attachmentScope("local","/project","s"),openFiles:files,focus:vi.fn()});
 await mount();await click("Добавить источник в черновик");expect(files).toHaveBeenCalledOnce();stop();
 await act(async()=>document.querySelector("aside")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));expect(fake.setUi).toHaveBeenCalledWith({contextOpen:false});
});

it("source plus never opens a composer editing another chat and says why instead of doing nothing",async()=>{
 const files=vi.fn(()=>true);const stop=registerComposer({scope:()=>attachmentScope("local","/project","other"),openFiles:files,focus:vi.fn()});
 await mount();await click("Добавить источник в черновик");stop();
 expect(files).not.toHaveBeenCalled();expect(document.querySelector('[role="alert"]')?.textContent).toContain("не принимает файлы");
});

it("labels only task-reported children as subagents and shows no count before the first answer",async()=>{
 let resolve!:(v:unknown)=>void;children=()=>new Promise(r=>{resolve=r;});
 const chat=fake.state.chat.sessions.s;chat.messageOrder=[...chat.messageOrder,"a"];chat.messages.a={id:"a",sessionID:"s",role:"assistant",time:{created:2}};
 chat.partsByMessage.a=["t"];chat.parts.t={id:"t",messageID:"a",sessionID:"s",type:"tool",tool:"task",state:{status:"completed",metadata:{sessionId:"sub"}}};
 await mount();expect(document.body.textContent).toContain("Субагенты и ветки · …");
 await vi.waitFor(()=>expect(childReads()).toHaveLength(1));
 await act(async()=>resolve([{id:"sub",parentID:"s",directory:"/project",title:"Research",projectID:"p",time:{created:1,updated:1}},{id:"fork",parentID:"s",directory:"/project",title:"Fork",projectID:"p",time:{created:1,updated:1}}]));
 const rows=Array.from(document.querySelectorAll("li")).map(li=>li.textContent);
 expect(rows.find(r=>r?.includes("Research"))).toContain("Субагент · вернул ответ");
 expect(rows.find(r=>r?.includes("Fork"))).toContain("Дочерняя сессия");expect(rows.find(r=>r?.includes("Fork"))).not.toContain("Субагент");
});

it("shows bidi-control file names inertly and keeps scheduled tasks of other chats out of this chat",async()=>{
 const rlo=String.fromCharCode(0x202e),mark=String.fromCharCode(0xfffd);
 fake.state.chat.sessions.s.parts.f={...fake.state.chat.sessions.s.parts.f,filename:`report${rlo}fdp.exe`};
 fake.scheduler.observe({type:"schedule.updated",properties:{task:dto("elsewhere",{sessionID:"elsewhere",title:"Other chat"})}});
 await mount();
 expect(document.body.textContent).not.toContain(rlo);expect(document.body.textContent).toContain(`report${mark}fdp.exe`);
 expect(document.body.textContent).not.toContain("Other chat");expect(document.body.textContent).toContain("других чатах этого сервера: 1");
});

it("updates sources from streaming events when the reducer retains the chat object",async()=>{
 await mount();
 const chat=fake.state.chat.sessions.s;
 const { reduceEvent }=await import("../src/state/chatReducer");
 reduceEvent(fake.state.chat,{type:"message.part.updated",properties:{part:{id:"f2",messageID:"u",sessionID:"s",type:"file",filename:"streamed-source.txt"}}});
 expect(fake.state.chat.sessions.s).toBe(chat);
 await mount();expect(document.body.textContent).toContain("streamed-source.txt");
});

it("cancels child reads when an SSH runtime's forwarded endpoint changes under the same workspace",async()=>{
 fake.state={...fake.state,prefs:{endpoint:"http://127.0.0.1:5001",workspaceKey:"same-host"}};
 let resolve!:(value:unknown)=>void;children=()=>new Promise(r=>{resolve=r;});await mount();
 await vi.waitFor(()=>expect(childReads()).toHaveLength(1));
 const signal=childReads()[0].signal!;
 children=()=>[];
 fake.state={...fake.state,prefs:{...fake.state.prefs,endpoint:"http://127.0.0.1:5002"}};await mount();
 expect(signal.aborted).toBe(true);
 await act(async()=>resolve([{id:"old-child",parentID:"s",directory:"/project",title:"OLD_ENDPOINT_CHILD",projectID:"p",time:{created:1,updated:1}}]));
 expect(document.body.textContent).not.toContain("OLD_ENDPOINT_CHILD");
});

it("prepares a common skill request in the selected chat without replacing its draft or starting work",async()=>{
 await mount();
 await act(async()=>[...document.querySelectorAll("button")].find(b=>b.textContent==="Подготовить создание навыка")!.click());
 const request=fake.setDraft.mock.calls[0][0] as string;
 expect(request).toMatch(/^user draft\n\n/);
 expect(request).toContain("create-shared-skill");
 expect(request).toContain("Если часть истории недоступна");
 expect(fake.openChat).not.toHaveBeenCalled();
 expect(fake.setUi).toHaveBeenCalledWith({contextOpen:false});
 expect(fx.made("POST","/commands")).toEqual([]);
});

it("opens all sources in a gallery and loads each older cursor only once",async()=>{
 const chat=fake.state.chat.sessions.s;
 for(let n=2;n<=6;n++){const id=`f${n}`;chat.partsByMessage.u.push(id);chat.parts[id]={id,sessionID:"s",messageID:"u",type:"file",filename:`source-${n}.txt`};}
 fake.state.historyCursors={s:"older-1"};fake.loadOlder.mockResolvedValue(undefined);
 await mount();expect(document.querySelectorAll("#context-sources-list li")).toHaveLength(3);
 await act(async()=>Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Показать все (6)")!.click());
 expect(document.querySelectorAll(".attachment-gallery-item")).toHaveLength(6);
 expect(fake.loadOlder).toHaveBeenCalledExactlyOnceWith("s");
 await mount();expect(fake.loadOlder).toHaveBeenCalledOnce();
 fake.state={...fake.state,activeSessionId:"other"};await mount();expect(document.querySelector(".attachment-viewer")).toBeNull();
});

it("saving a recurrence keeps its chat and reasoning model in the runtime without starting inference",async()=>{
 await mount();await click("Добавить таймер");
 await act(async()=>{
  const inputs=document.querySelectorAll("input");const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!;
  setter.call(inputs[0],"CI check");inputs[0].dispatchEvent(new Event("input",{bubbles:true}));
  const text=document.querySelector("textarea")!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(text,"Check CI");text.dispatchEvent(new Event("input",{bubbles:true}));
 });
 await act(async()=>document.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 await vi.waitFor(()=>expect(fx.made("POST","/schedules")).toHaveLength(1));
 expect(fx.made("POST","/schedules")[0].body).toEqual({directory:"/project",sessionID:"s",title:"CI check",prompt:"Check CI",minutes:15,mode:"repeat",model:{providerID:"p",modelID:"m",variant:"medium"}});
 await vi.waitFor(()=>expect(document.body.textContent).toContain("Следующий запуск"));
 expect(fake.setDraft).not.toHaveBeenCalled();
 expect(fx.made("POST","/commands")).toEqual([]);
});
