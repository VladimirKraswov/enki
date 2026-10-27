import {afterEach, expect, it, vi} from 'vitest';
import {runRuntimeStream} from '../src/agent/runtime/events';
import {RuntimeClient, type RuntimeConnection} from '../src/agent/runtime/client';
const connection:RuntimeConnection={endpoint:'http://127.0.0.1:43123',token:'t'.repeat(43),instance:'i1',version:'test',contract:1};
const encode=(s:string)=>new TextEncoder().encode(s);
const hello='data: {"type":"stream.hello","instance":"i1","head":5,"contract":1}\n\n';
const event=(seq:number)=>`data: ${JSON.stringify({seq,time:1,event:{type:'fixture',properties:{}}})}\n\n`;
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
it.each(['headers','hello'])('bounds a stalled %s handshake and refreshes the endpoint without resending any command',async phase=>{
 vi.useFakeTimers(); const stop=new AbortController(),states:string[]=[],urls:string[]=[];
 const refresh=vi.fn(async()=>({...connection,endpoint:'http://127.0.0.1:43124'}));
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{urls.push(url);if(urls.length===1)return phase==='headers'?new Promise<Response>(()=>{}):new Response(new ReadableStream());return new Response(hello+event(6));}));
 const task=runRuntimeStream({client:new RuntimeClient(connection,refresh),scope:{directory:'/p'},signal:stop.signal,connectTimeoutMs:100,idleTimeoutMs:500,maxBackoffMs:1,onState:s=>states.push(s),onReset:vi.fn(),onEnvelope:()=>stop.abort()});
 await vi.advanceTimersByTimeAsync(150);await task;
 expect(refresh).toHaveBeenCalledOnce();expect(urls).toHaveLength(2);expect(urls[1]).toContain('127.0.0.1:43124/v1/events');expect(states).toContain('error');expect(states.at(-1)).toBe('closed');expect(vi.getTimerCount()).toBe(0);
});
it('keepalive comments sustain an idle stream; silence reconnects with the exact cursor and drops replayed duplicates',async()=>{
 vi.useFakeTimers();const stop=new AbortController(),seen:number[]=[],urls:URL[]=[],cancel=vi.fn();let source!:ReadableStreamDefaultController<Uint8Array>;
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{urls.push(new URL(url));return urls.length===1?new Response(new ReadableStream<Uint8Array>({start(c){source=c;c.enqueue(encode(hello+event(6)));},cancel})):new Response(hello+event(6)+event(7));}));
 const task=runRuntimeStream({client:new RuntimeClient(connection,async()=>connection),scope:{all:true},signal:stop.signal,connectTimeoutMs:100,idleTimeoutMs:300,maxBackoffMs:1,onState:vi.fn(),onReset:vi.fn(),onEnvelope:e=>{seen.push(e.seq);if(e.seq===7)stop.abort();}});
 await vi.advanceTimersByTimeAsync(200);source.enqueue(encode(': keepalive\n\n'));await vi.advanceTimersByTimeAsync(200);expect(urls).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(150);await task;expect(seen).toEqual([6,7]);expect(urls[1].searchParams.get('after')).toBe('6');expect(cancel).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
it('cancels a hung connection refresh when the user leaves the host, with no late delivery',async()=>{
 vi.useFakeTimers();const stop=new AbortController(),fetch=vi.fn(async()=>{throw new TypeError('offline');});vi.stubGlobal('fetch',fetch);
 let complete!:(value:RuntimeConnection)=>void;const refresh=vi.fn(()=>new Promise<RuntimeConnection>(resolve=>{complete=resolve;}));const seen=vi.fn();
 const task=runRuntimeStream({client:new RuntimeClient(connection,refresh),scope:{all:true},signal:stop.signal,maxBackoffMs:1,onState:vi.fn(),onReset:vi.fn(),onEnvelope:seen});
 await vi.advanceTimersByTimeAsync(5);expect(refresh).toHaveBeenCalledOnce();stop.abort();await task;complete(connection);await vi.advanceTimersByTimeAsync(100000);expect(fetch).toHaveBeenCalledOnce();expect(seen).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});
