// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_PREFS } from "../src/state/prefs";
import { captureErrorMessage } from "../src/voice/captureError";
import { resetPlatformCache } from "../src/native/platform";

const fake = vi.hoisted(() => ({
  records: new Map<string,any>(), state: {} as any, setUi: vi.fn(), appendDictation: vi.fn(), transcribe: vi.fn(),
}));
vi.mock("../src/state/store", () => ({ store: fake }));
vi.mock('../src/voice/journal',async(original)=>({
 ...await original<typeof import('../src/voice/journal')>(),
 dictationJournal:{ready:async()=>{},list:async(scope:string)=>[...fake.records.values()].filter(r=>r.scope===scope),put:async(s:any)=>{fake.records.set(s.id,{...s,parts:[...s.parts]});},remove:async(id:string)=>{fake.records.delete(id);}}
}));
vi.mock("../src/voice/asr", async (original) => ({
  ...await original<typeof import("../src/voice/asr")>(), transcribeAudio: fake.transcribe,
}));
import { VoiceInput } from "../src/components/VoiceInput";

let root: Root;
let resume: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn>, capture: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.clearAllMocks();fake.records.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fake.state = { prefs: structuredClone(DEFAULT_PREFS), activeSessionId: "session", directory: "/tmp" };
  resume = vi.fn().mockResolvedValue(undefined); close = vi.fn().mockResolvedValue(undefined); capture = vi.fn();
  vi.stubGlobal("AudioContext", class { resume = resume; close = close; });
  vi.stubGlobal("MediaRecorder", class {});
  vi.stubGlobal("ResizeObserver", class { observe(){} disconnect(){} });
  vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue({setTransform(){},clearRect(){},beginPath(){},roundRect(){},fill(){},fillStyle:""} as any);
  // The permission hint is host-specific; pin macOS so the assertion is exact.
  resetPlatformCache();
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", mediaDevices: { getUserMedia: capture } });
  const node = document.createElement("div"); document.body.append(node);
  root = createRoot(node); await act(async () => root.render(createElement(VoiceInput, { disabled: false })));
});
afterEach(() => {
  act(() => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); resetPlatformCache();
});
async function click(label: string) {
  await act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
}
it("explains native permission refusal without exposing the raw WebKit error or contacting ASR", async () => {
  capture.mockRejectedValue(new DOMException("The request is not allowed by the user agent", "NotAllowedError"));
  await click("Надиктовать");
  const alert = document.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("Конфиденциальность и безопасность → Микрофон");
  expect(alert.textContent).toContain("Если доступ уже включён");
  expect(alert.textContent).not.toContain("user agent");
  expect(close).toHaveBeenCalledOnce(); expect(fake.transcribe).not.toHaveBeenCalled();
  expect(document.querySelector('button[aria-label="Надиктовать"]')).not.toBeNull();
  await click("Закрыть ошибку микрофона");
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
it("records and transcribes even when Web Audio never resumes", async () => {
  const stop = vi.fn();
  capture.mockResolvedValue({ getTracks: () => [{ stop }] });
  resume.mockReturnValue(new Promise<void>(() => {}));
  vi.stubGlobal("AudioContext", class {
    resume = resume; close = close;
    createAnalyser() { return { fftSize: 0, frequencyBinCount: 48, getByteTimeDomainData: (data: Uint8Array) => data.fill(128) }; }
    createMediaStreamSource() { return { connect: () => {} }; }
  });
  const started = vi.fn();
  vi.stubGlobal("MediaRecorder", class {
    static isTypeSupported() { return true; }
    state = "inactive"; mimeType = "audio/webm";
    onstop: (() => void) | null = null;
    ondataavailable: ((event:{data:Blob})=>void) | null = null;
    start() { this.state = "recording"; started(); this.ondataavailable?.({data:new Blob(["first-checkpoint"])}); }
    stop() { this.state = "inactive"; this.ondataavailable?.({data:new Blob(["fixture-audio"])});this.onstop?.(); }
  });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform() {}, clearRect() {}, beginPath() {}, roundRect() {}, fill() {}, fillStyle: "",
  } as unknown as CanvasRenderingContext2D);
  fake.transcribe.mockResolvedValue("распознано");
  await click("Надиктовать");
  expect(capture).toHaveBeenCalledOnce();
  expect(started).toHaveBeenCalledOnce();
  expect(document.querySelector('button[aria-label="Закончить и распознать"]')).not.toBeNull();
  await click("Закончить и распознать");
  await act(async()=>{await vi.waitFor(()=>expect(stop).toHaveBeenCalledOnce());});
  expect(fake.transcribe).toHaveBeenCalledOnce();
  expect(fake.appendDictation).toHaveBeenCalledWith(expect.any(String), expect.any(String), "распознано",expect.any(String));
  expect(stop).toHaveBeenCalledOnce();
});
it("keeps the composer in recording layout until cancellation completes", async () => {
  const onActiveChange = vi.fn();
  act(() => root.render(createElement(VoiceInput, { disabled: false, onActiveChange })));
  expect(onActiveChange).toHaveBeenLastCalledWith(false);
  let finish!: (stream: any) => void;
  capture.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await click("Надиктовать");
  expect(onActiveChange).toHaveBeenLastCalledWith(true);
  expect(document.querySelector('.voice-recording[aria-label="Надиктовка"]')).not.toBeNull();
  expect(document.querySelector('button[aria-label="Отменить диктовку"]')).not.toBeNull();
  await click("Отменить диктовку");
  expect(onActiveChange).toHaveBeenLastCalledWith(false);
  const stop = vi.fn();
  await act(async () => finish({ getTracks: () => [{ stop }] }));
  expect(onActiveChange).toHaveBeenLastCalledWith(false);
  expect(capture).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
});
it("stops a late granted microphone stream after cancellation without transcription", async () => {
  let finish!: (stream: any) => void;
  capture.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const stop = vi.fn();
  await click("Надиктовать"); await click("Отменить диктовку");
  await act(async () => finish({ getTracks: () => [{ stop }] }));
  expect(stop).toHaveBeenCalledOnce(); expect(fake.transcribe).not.toHaveBeenCalled();
  expect(fake.appendDictation).not.toHaveBeenCalled();
});
it("names the host's own permission location instead of assuming macOS", () => {
  const denied = { name: "NotAllowedError" };
  expect(captureErrorMessage(denied, "macos")).toContain("Конфиденциальность и безопасность → Микрофон");
  expect(captureErrorMessage(denied, "linux")).toContain("xdg-desktop-portal");
  expect(captureErrorMessage(denied, "windows")).toContain("Параметры → Конфиденциальность");
  for (const host of ["macos", "linux", "windows", "other"] as const)
    expect(captureErrorMessage(denied, host)).toContain("Если доступ уже включён");
});
it("distinguishes missing and unavailable devices from permission errors", () => {
  expect(captureErrorMessage({ name: "NotFoundError" })).toContain("Микрофон не найден");
  expect(captureErrorMessage({ name: "NotReadableError" })).toContain("занято ли оно");
  expect(captureErrorMessage({ name: "AbortError" })).toContain("прерван");
  expect(captureErrorMessage(new Error("private raw details"))).not.toContain("private raw details");
});
it('requires explicit recovery of interrupted audio before starting another recording',async()=>{
 const {draftKey}=await import('../src/state/prefs');const {dictationScope}=await import('../src/voice/journal');
 const workspace=fake.state.prefs.workspaceKey??fake.state.prefs.endpoint,draft=draftKey(fake.state.activeSessionId,fake.state.directory);
 fake.records.set('interrupted',{id:'interrupted',group:'old',scope:dictationScope(workspace,draft),workspace,draft,settings:fake.state.prefs.asr,created:1,sequence:0,overlap:false,mime:'audio/webm',parts:[new Blob(['saved-audio'])],complete:false});
 await click('Надиктовать');expect(capture).not.toHaveBeenCalled();expect(fake.transcribe).not.toHaveBeenCalled();
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('сохранённая диктовка');
 expect(document.querySelector<HTMLButtonElement>('button[aria-label="Надиктовать"]')?.disabled).toBe(true);
 fake.transcribe.mockResolvedValue('восстановленный текст');
 await act(async()=>{[...document.querySelectorAll('button')].find(b=>b.textContent==='Восстановить диктовку')!.click();});
 expect(fake.transcribe).toHaveBeenCalledOnce();expect(fake.appendDictation).toHaveBeenCalledWith(workspace,draft,'восстановленный текст','interrupted');
 expect(fake.records.size).toBe(0);
});
it('recovery delivers to an explicit question draft rather than the ordinary prompt',async()=>{
 const {dictationScope}=await import('../src/voice/journal');
 const workspace=fake.state.prefs.workspaceKey??fake.state.prefs.endpoint,draft=JSON.stringify(['question-answer','q-scoped',0]);
 fake.records.set('question-audio',{id:'question-audio',group:'q',scope:dictationScope(workspace,draft),workspace,draft,settings:fake.state.prefs.asr,created:1,sequence:0,overlap:false,mime:'audio/webm',parts:[new Blob(['saved'])],complete:true,text:'Ответ голосом'});
 await act(async()=>root.render(createElement(VoiceInput,{disabled:false,draftTarget:draft})));
 await act(async()=>{[...document.querySelectorAll('button')].find(b=>b.textContent==='Восстановить диктовку')!.click();});
 expect(fake.appendDictation).toHaveBeenCalledWith(workspace,draft,'Ответ голосом','question-audio');expect(fake.transcribe).not.toHaveBeenCalled();
});
it('a question keeps its send fence while unsent audio awaits recovery',async()=>{
 const {dictationScope}=await import('../src/voice/journal');const workspace=fake.state.prefs.workspaceKey??fake.state.prefs.endpoint,draft='question-recovery';
 fake.records.set('pending-question',{id:'pending-question',group:'q',scope:dictationScope(workspace,draft),workspace,draft,settings:fake.state.prefs.asr,created:1,sequence:0,overlap:false,mime:'audio/webm',parts:[new Blob(['saved'])],complete:true,text:'ответ'});
 const changed=vi.fn();await act(async()=>root.render(createElement(VoiceInput,{disabled:false,draftTarget:draft,holdForRecovery:true,onActiveChange:changed})));
 expect(changed).toHaveBeenLastCalledWith(true);await act(async()=>{[...document.querySelectorAll('button')].find(b=>b.textContent==='Восстановить диктовку')!.click();});
 expect(changed).toHaveBeenLastCalledWith(false);
});

it('does not invite speech until a real audio checkpoint arrives, and cleans up after cancellation',async()=>{
 const stop=vi.fn();fake.transcribe.mockResolvedValue('текст');capture.mockResolvedValue({getTracks:()=>[{stop}]});
 let recorder:any;
 vi.stubGlobal('MediaRecorder',class{
  static isTypeSupported(){return true;} state='inactive';mimeType='audio/webm';ondataavailable:any;onstop:any;
  constructor(){recorder=this;}start(){this.state='recording';}stop(){this.state='inactive';this.onstop?.();}
 });
 await click('Надиктовать');
 expect(document.body.textContent).toContain('Пока не говорите');expect(document.body.textContent).not.toContain('Можно говорить');
 const preparing=document.querySelector('.voice-recording .voice-preparing');
 expect(preparing).not.toBeNull();
 expect(preparing!.querySelectorAll('.voice-preparing-bars i')).toHaveLength(5);
 expect(preparing!.textContent).toContain('Готовлю запись');
 await act(async()=>{recorder.ondataavailable({data:new Blob(['actual-audio'])});});
 expect(document.body.textContent).toContain('Можно говорить');expect(document.querySelector('canvas')).not.toBeNull();
 await click('Остановить диктовку');await act(async()=>{await vi.waitFor(()=>expect(stop).toHaveBeenCalledOnce());});expect(stop).toHaveBeenCalledOnce();
});

it('clears a failed recognition after successful recovery without discarding saved audio early',async()=>{
 const {dictationScope}=await import('../src/voice/journal');const {draftKey}=await import('../src/state/prefs');
 const workspace=fake.state.prefs.workspaceKey??fake.state.prefs.endpoint,draft=draftKey('session','/tmp');
 fake.records.set('saved',{id:'saved',group:'fixture',scope:dictationScope(workspace,draft),workspace,draft,settings:fake.state.prefs.asr,created:1,sequence:0,overlap:false,mime:'audio/webm',parts:[new Blob(['fixture'])],complete:true});
 await act(async()=>{root.unmount();const n=document.createElement('div');document.body.append(n);root=createRoot(n);root.render(createElement(VoiceInput,{disabled:false}));});
 fake.transcribe.mockRejectedValueOnce(Error('ASR HTTP 400. Сервис отклонил аудиофрагмент.'));
 await act(async()=>{[...document.querySelectorAll('button')].find(b=>b.textContent==='Восстановить диктовку')!.click();});
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('ASR HTTP 400');expect(fake.records.size).toBe(1);
 fake.transcribe.mockResolvedValueOnce('');
 await act(async()=>{[...document.querySelectorAll('button')].find(b=>b.textContent==='Восстановить диктовку')!.click();});
 expect(fake.records.size).toBe(0);expect(document.querySelector('[role="alert"]')).toBeNull();
});
