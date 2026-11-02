import type { Assessment } from "../outcomes/store";
import type { Message, MessagePart, Session } from "../api/types";
export interface HubRecord {
 engine: "opencode" | "pi"; sessionId: string; id:string; role:"user"|"assistant"; created:number; completed:number;
 title:string; project:string; provider:string; model:string; variant:string; text:string; error:string; finish:string; truncated:boolean;
 tokens:{input:number;output:number;cacheRead:number;cacheWrite:number;reasoning:number;total:number};
 assessment?:Assessment;
 diagnostics?:import("../diagnostics/tasks").TaskDiagnostics;
 tools:Array<{id:string;name:string;status:string;durationMs:number;error:string}>;
}
/** Defense in depth, not a claim of perfect personal-data removal. */
export function redact(value:unknown, limit=16000):string {
 return String(value??"").slice(0,262144)
 .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,"[PRIVATE KEY REMOVED]")
 .replace(/\b(?:sk-|gh[pousr]_|github_pat_|hf_|xox[baprs]-)[A-Za-z0-9_-]{8,}/g,"[KEY REMOVED]")
 .replace(/\bBearer\s+(?:\[(?:KEY|VALUE) REMOVED\]|[^\s"']+)/gi,"Bearer [KEY REMOVED]")
 .replace(/([?&](?:key|token|api_key|password|secret|auth|signature)=)(?:\[(?:KEY|VALUE) REMOVED\]|[^&#\s]+)/gi,"$1[VALUE REMOVED]")
 .replace(/((?:api[_-]?key|password|passwd|pass|pas|pwd|пароль|API-ключ|access[_-]?token|refresh[_-]?token|secret|authorization|token)\s*["']?\s*[:=]\s*)(?:\[(?:KEY|VALUE|AUTH|PRIVATE KEY) REMOVED\]|Bearer\s+(?:\[(?:KEY|VALUE) REMOVED\]|[^\s"']+)|"[^"\n]*"|'[^'\n]*'|[^\s,;<>]+)/gi,"$1[VALUE REMOVED]")
 .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g,"$1[AUTH REMOVED]@")
 .replace(/(?<![A-Za-z]:)(?:\/Users\/|\/home\/)[^/\\\s]+/g,"/home/[user]")
 .replace(/C:[\\/]Users[\\/][^\\/\s]+/gi,"C:/Users/[user]").slice(0,limit);
}
const positive=(n:unknown)=>typeof n==="number"&&Number.isFinite(n)?Math.max(0,Math.floor(n)):0;
function errorText(value:unknown):string {
 if(typeof value==="string")return redact(value,1500);
 if(value&&typeof value==="object") {const v=value as {message?:unknown;name?:unknown;data?:{message?:unknown}};return redact(v.data?.message??v.message??v.name??"Ошибка агента",1500);}
 return "";
}
export function record(engine:HubRecord["engine"],session:Pick<Session,"id"|"title"|"directory">,m:Message,parts:MessagePart[],shareText:boolean):HubRecord|null {
 if(m.role==="assistant"&&m.summary)return null;
 // A failed tool is diagnostic evidence even while the model is still running
 // or parked on another tool; do not wait indefinitely for the final answer.
 if(m.role==="assistant"&&!m.time.completed&&!m.error&&!parts.some(p=>p.type==="tool"&&p.state?.status==="error"))return null;
 // Intermediate text accompanying tools is not a final answer. No reasoning/file/raw input/output is serialized.
 const tools=parts.filter(p=>p.type==="tool"&&p.state).slice(0,128).map(p=>({id:p.callID??p.id,name:redact(p.tool,160),status:p.state!.status,durationMs:Math.max(0,positive(p.state!.time?.end)-positive(p.state!.time?.start)),error:errorText(p.state!.error)}));
 const visible=parts.filter(p=>p.type==="text"&&!p.synthetic&&!p.ignored).map(p=>p.text??"").join("\n");
 const text=shareText&&(m.role==="user"||m.finish==="stop"||!tools.length)?redact(visible):"";
 const t=m.role==="assistant"?m.tokens:undefined,input=positive(t?.input),output=positive(t?.output),cacheRead=positive(t?.cache?.read),cacheWrite=positive(t?.cache?.write);
 const project=(session.directory??"").split(/[\\/]/).filter(Boolean).slice(-1)[0]??"";
 return {engine,sessionId:session.id,id:m.id,role:m.role,created:positive(m.time.created),completed:positive(m.time.completed),title:shareText?redact(session.title,180):"",project:redact(project,100),
 provider:redact(m.role==="assistant"?m.providerID:m.model?.providerID,160),model:redact(m.role==="assistant"?m.modelID:m.model?.modelID,160),variant:redact(m.role==="assistant"?m.variant:m.model?.variant,64),
 text,error:errorText(m.error),finish:m.role==="assistant"?redact(m.finish,64):"",truncated:!!text&&visible.length>16000,
 tokens:{input,output,cacheRead,cacheWrite,total:Math.max(positive(t?.total),input+output+cacheRead+cacheWrite),reasoning:Math.min(output,positive(t?.reasoning))},tools};
}
