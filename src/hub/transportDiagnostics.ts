import type { WorkshopDiagnostic } from './client';

const pending = new Map<string,{origin:string;log:WorkshopDiagnostic}>();
let wake: (()=>void) | undefined;
let currentOrigin:string|null=null;
export function setTransportOrigin(origin:string|null){currentOrigin=origin;}
export const pendingTransportFailures=(origin:string)=>[...pending.values()].filter(v=>v.origin===origin).map(v=>v.log);
export function acknowledgeTransportFailures(ids:string[]){for(const id of ids)pending.delete(id);}
export function watchTransportFailures(listener:()=>void){wake=listener;return()=>{if(wake===listener){wake=undefined;currentOrigin=null;}};}

export function transportDiagnostic(session: string | null, detail: string, operation: string): WorkshopDiagnostic {
 const code=detail==='stream ended'?'stream.ended':detail.includes('Поток событий не отвечает')?'stream.timeout'
  :/^event stream HTTP \d{3}$/.test(detail)?'stream.http':detail==='Invalid event stream JSON'?'stream.protocol':'stream.transport';
 return {requestId:crypto.randomUUID(),agent:'desktop',session:session??'runtime',level:'error',code,operation,detail:'',observed:Date.now()};
}

/** Wake the Hub collector to enqueue into the durable native outbox. No raw error,
 * URL, token, directory, shell output or message text enters this diagnostic. */
export function reportTransportFailure(session: string | null, detail: string, operation: string): void {
 if(!currentOrigin)return;
 const event=transportDiagnostic(session,detail,operation);
 if(pending.size>=1000)pending.delete(pending.keys().next().value!);
 pending.set(event.requestId,{origin:currentOrigin,log:event});wake?.();
}
