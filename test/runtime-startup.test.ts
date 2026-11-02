// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RuntimeStartupStatus } from '../src/components/RuntimeStartupStatus';
import { parseStartup, type RuntimeStartup } from '../src/agent/runtime/startup';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('../src/native/platform', () => ({ isNative: () => true }));
const progress = {run:1,phase:'hashing' as const,startedAt:1,elapsedMs:65000,phaseElapsedMs:60000,completed:12,total:100,error:null,stages:[]};
let root: Root | undefined;
beforeEach(()=>{ native.invoke.mockReset(); });
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;vi.useRealTimers();document.body.innerHTML='';});

it('shows file verification as preparation, with measured counts and no offline alert or retry loop',async()=>{
 const el=document.createElement('div');document.body.append(el);root=createRoot(el);
 await act(async()=>root!.render(createElement(RuntimeStartupStatus,{progress,onRetry:vi.fn()})));
 expect(el.textContent).toContain('Проверяем целостность файлов');
 expect(el.textContent).toContain('12 / 100 файлов');
 expect(el.textContent).toContain('1 мин 5 с');
 expect(el.textContent).not.toContain('Нет связи');
 expect(el.querySelector('progress')?.value).toBe(12);
 expect([...el.querySelectorAll('button')].some(b=>b.textContent?.includes('Повторить'))).toBe(false);
 const retry=vi.fn();
 await act(async()=>root!.render(createElement(RuntimeStartupStatus,{progress:{...progress,phase:'failed',error:'Файл изменён'},error:'Файл изменён',onRetry:retry})));
 expect(el.textContent).toContain('Файл изменён');
 const button=[...el.querySelectorAll('button')].find(b=>b.textContent?.includes('Повторить'))!;
 await act(async()=>button.click());expect(retry).toHaveBeenCalledOnce();
});
it('polls cheap status during ONE pending native ensure, then stops all polling after connection',async()=>{
 const {localConnection}=await import('../src/agent/runtime/connection');vi.useFakeTimers();
 let resolve!: (value:unknown)=>void;
 const ready=new Promise(r=>{resolve=r;});
 native.invoke.mockImplementation((name:string)=>name==='runtime_status'?Promise.resolve({startup:progress}):ready);
 const seen:unknown[]=[];const connecting=localConnection(p=>seen.push(p));
 await vi.advanceTimersByTimeAsync(2000);
 expect(native.invoke.mock.calls.filter(c=>c[0]==='runtime_connection')).toHaveLength(1);
 expect(native.invoke.mock.calls.filter(c=>c[0]==='runtime_status').length).toBeGreaterThan(1);
 expect(seen).toContainEqual(progress);
 resolve({endpoint:'http://127.0.0.1:1234',token:'test-only',instance:'test',version:'test',contract:1});await connecting;
 const before=native.invoke.mock.calls.length;await vi.advanceTimersByTimeAsync(2000);
 expect(native.invoke.mock.calls).toHaveLength(before);
});
it('rejects malformed progress and does not mistake missing native diagnostics for a startup failure',async()=>{
 expect(parseStartup({...progress,completed:101})).toBeUndefined();
 expect(parseStartup({...progress,phase:'invented'})).toBeUndefined();
 const {localConnection}=await import('../src/agent/runtime/connection');
 native.invoke.mockImplementation((name:string)=>Promise.resolve(name==='runtime_status'?{running:true}:{endpoint:'http://127.0.0.1:1',token:'test',instance:'test',version:'old',contract:1}));
 const seen=vi.fn();expect((await localConnection(seen)).version).toBe('old');expect(seen).not.toHaveBeenCalled();
});

it('keeps the failure snapshot, shares one rejected attempt and stops status polling', async () => {
 const {localConnection}=await import('../src/agent/runtime/connection');vi.useFakeTimers();
 let fail!: (error: Error)=>void;
 const pending=new Promise((_,reject)=>{fail=reject;});
 let status:RuntimeStartup=progress;
 native.invoke.mockImplementation((name:string)=>name==='runtime_status'?Promise.resolve({startup:status}):pending);
 const seen:unknown[]=[];const connecting=localConnection(p=>seen.push(p));
 const rejected=expect(connecting).rejects.toThrow('integrity failed');
 await vi.advanceTimersByTimeAsync(1000);
 status={...progress,phase:'failed',error:'integrity failed'};
 fail(new Error('integrity failed'));await rejected;
 expect(seen.at(-1)).toEqual(status);
 expect(native.invoke.mock.calls.filter(c=>c[0]==='runtime_connection')).toHaveLength(1);
 const before=native.invoke.mock.calls.length;await vi.advanceTimersByTimeAsync(2000);
 expect(native.invoke.mock.calls).toHaveLength(before);
});
