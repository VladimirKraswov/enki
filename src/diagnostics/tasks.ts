import type { AssistantMessage, Message, ServerEvent } from '../api/types';
import type { SessionChatState } from '../state/chatReducer';

export interface DispatchTiming { messageID?: string; dispatchAt: number; preparationMs: number | null; queueMs: number | null }
export interface TaskObservation extends DispatchTiming {
  startedAt: number; firstAt?: number; endedAt?: number; retries: number;
  retryAttempt?: number; tools: Record<string, [number, number]>;
}
export interface TaskDiagnostics {
  schema: 1; source: 'observed' | 'history'; state: 'running' | 'ended' | 'error' | 'aborted' | 'unknown';
  wallMs: number | null; queueMs: number | null; preparationMs: number | null; firstResponseMs: number | null;
  toolMs: number | null; reasoningMs: number | null; unattributedMs: number | null;
  calls: number; failed: number; repeatedCalls: number; retries: number | null;
  input: number | null; output: number | null; reasoning: number | null; usageComplete: boolean;
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const difference = (end: unknown, start: unknown) => finite(end) && finite(start) && end >= start && end-start <= 30*86400000 ? end - start : null;
export const timingKey = (m: Message) => m.timingKey ?? m.id;
export function unionMs(intervals: [number, number][]) {
  let end = -Infinity, total = 0;
  for (const [a,b] of [...intervals].sort((a,b) => a[0] - b[0])) { total += Math.max(0,b - Math.max(a,end)); end = Math.max(end,b); }
  return total;
}
/** Local event receipt times only. History loaders never call this observer. */
export function observeTask(chat: SessionChatState, event: ServerEvent, now: number) {
  const props = event.properties ?? {}, info = props.info as Message | undefined;
  if (event.type === 'message.updated' && info?.role === 'user') {
    const key = timingKey(info);
    if (!chat.taskObservations?.[key]) {
      const pending = chat.pendingTiming;
      const matched = pending && (pending.messageID ? pending.messageID === info.id : info.timingSource === 'live');
      (chat.taskObservations ??= {})[key] = { ...(matched ? pending : {dispatchAt: now, preparationMs: 0, queueMs: null}),
        startedAt: matched ? pending.dispatchAt - (pending.preparationMs ?? 0) - (pending.queueMs ?? 0) : now, retries: 0, tools: {} };
      // Unattributed external turns have no measured preparation/dispatch.
      if (!matched) chat.taskObservations[key].preparationMs = null;
      if (matched) delete chat.pendingTiming;
      const keys = Object.keys(chat.taskObservations);
      for (const old of keys.slice(0, Math.max(0, keys.length - 100))) delete chat.taskObservations[old];
    }
  }
  let user: Message | undefined;
  for (let i = chat.messageOrder.length - 1; i >= 0; i--) {
    const message = chat.messages[chat.messageOrder[i]];
    if (message?.role === 'user') { user = message; break; }
  }
  const o = user && chat.taskObservations?.[timingKey(user)];
  if (!o || !user) return;
  const p = event.type === 'message.part.updated' ? props.part as import('../api/types').MessagePart : null;
  const id = p?.messageID ?? (event.type === 'message.part.delta' ? props.messageID : null);
  const m = typeof id === 'string' ? chat.messages[id] : undefined;
  // An explicit older parent must never contribute to a newer queued/steered turn.
  const attributed = m?.role === 'assistant' && !m.summary && (!m.parentID || m.parentID === user.id);
  if (attributed && (event.type === 'message.part.delta' && typeof props.delta === 'string' && props.delta.length > 0 || p && ['text','reasoning'].includes(p.type) && !!p.text && !p.synthetic && !p.ignored)) o.firstAt ??= now;
  if (attributed && p?.type === 'tool' && p.state && ['completed','error'].includes(p.state.status) && finite(p.state.time?.start) && finite(p.state.time?.end) && p.state.time.end >= p.state.time.start && Object.keys(o.tools).length < 1000) o.tools[p.callID ?? p.id] = [p.state.time.start, p.state.time.end];
  if (event.type === 'session.status' && chat.status.type === 'retry') {
    if (o.retryAttempt !== chat.status.attempt) { o.retries++; o.retryAttempt = chat.status.attempt; }
  }
  if (event.type === 'session.error' || event.type === 'session.idle' || event.type === 'session.status' && chat.status.type === 'idle') {
    if (chat.messageOrder.slice(chat.messageOrder.indexOf(user.id)+1).some(id=>{const m=chat.messages[id];return m?.role==='assistant' && (!m.parentID || m.parentID===user.id);} )) o.endedAt ??= now;
  }
}
/** Position of a user request in its transcript: its index, the next user message
 * (-1: none) and whether its timing key is unique among user messages. */
export interface TaskPosition { index: number; next: number; unique: boolean }
/** One pass over a transcript for every user request. Diagnostics for ALL requests
 * then cost O(messages) instead of three whole-transcript scans per request. */
export function taskPositions(chat: SessionChatState): Map<string, TaskPosition> {
  const users: number[] = [], keys = new Map<string, number>();
  chat.messageOrder.forEach((id, i) => {
    const m = chat.messages[id];
    if (m?.role === 'user') { users.push(i); keys.set(timingKey(m), (keys.get(timingKey(m)) ?? 0) + 1); }
  });
  const positions = new Map<string, TaskPosition>();
  users.forEach((index, n) => {
    const id = chat.messageOrder[index];
    if (!positions.has(id)) positions.set(id, { index, next: users[n + 1] ?? -1, unique: keys.get(timingKey(chat.messages[id]!)) === 1 });
  });
  return positions;
}
/** Bounded to one already-loaded request, ending before the next user message. */
export function taskDiagnostics(chat: SessionChatState | undefined, messageID?: string, position?: TaskPosition): TaskDiagnostics | null {
  if (!chat) return null;
  const index = position?.index ?? (messageID ? chat.messageOrder.indexOf(messageID) : chat.messageOrder.map(id=>chat.messages[id]?.role).lastIndexOf('user'));
  const user = chat.messages[chat.messageOrder[index]];
  if (index < 0 || user?.role !== 'user') return null;
  const next = position?.next ?? chat.messageOrder.findIndex((id,i)=>i>index && chat.messages[id]?.role==='user');
  const assistants = chat.messageOrder.slice(index+1,next<0?undefined:next).map(id=>chat.messages[id]).filter((m): m is AssistantMessage=>m?.role==='assistant' && !m.summary && (!m.parentID || m.parentID===user.id));
  const unique = position?.unique ?? chat.messageOrder.filter(id=>chat.messages[id]?.role==='user' && timingKey(chat.messages[id])===timingKey(user)).length === 1;
  const o = unique ? chat.taskObservations?.[timingKey(user)] : undefined;
  const terminal = assistants[assistants.length-1], aborted = terminal?.error && (terminal.error as {name?: string}).name === 'MessageAbortedError' || terminal?.finish === 'aborted';
  const errored = assistants.some(m=>!!m.error || m.finish==='error');
  const ended = !!o?.endedAt || !!terminal?.time.completed && terminal.finish !== 'tool-calls' && terminal.finish != null;
  const historyTiming = user.timingSource !== 'entry' && assistants.length > 0 && assistants.every(m=>m.timingSource!=='entry' && finite(m.time.completed));
  const start = o?.startedAt ?? user.time.created;
  const end = o?.endedAt ?? (ended && historyTiming ? Math.max(...assistants.map(m=>m.time.completed!)) : null);
  const wallMs = difference(end,start), tools: [number,number][] = [], reasoning: [number,number][] = [];
  const seen = new Set<string>(), names = new Map<string,number>(); let calls=0,failed=0;
  for (const m of assistants) for (const pid of chat.partsByMessage[m.id] ?? []) {
    const p = chat.parts[pid]; if (!p) continue;
    const key = p.callID ?? p.id;
    if (p.type === 'tool' && !seen.has(key)) { seen.add(key); calls++; if(p.state?.status==='error') failed++; names.set(p.tool??'',(names.get(p.tool??'')??0)+1); }
    const t = p.type==='tool' ? p.state?.time : p.time;
    const interval = p.type==='tool' && o?.tools[key] ? o.tools[key] : m.timingSource !== 'entry' && finite(t?.start) && finite(t?.end) ? [t.start,t.end] as [number,number] : null;
    if (interval) { const a=Math.max(start,interval[0]),b=end==null?interval[1]:Math.min(end,interval[1]); if(b>=a) { if(p.type==='tool') tools.push([a,b]); else if(p.type==='reasoning') reasoning.push([a,b]); } }
  }
  const phaseMs = unionMs([...tools,...reasoning]), usageComplete = assistants.length > 0 && assistants.every(m=>finite(m.tokens?.input) && finite(m.tokens?.output));
  const count = (key: 'input'|'output'|'reasoning') => assistants.length && assistants.every(m=>finite(m.tokens?.[key])) ? assistants.reduce((n,m)=>n+m.tokens![key]!,0) : null;
  return {schema:1,source:o?'observed':'history',state:aborted?'aborted':errored?'error':ended?'ended':next<0&&chat.status.type!=='idle'?'running':'unknown',
    wallMs,queueMs:difference(o?.queueMs,0),preparationMs:difference(o?.preparationMs,0),
    firstResponseMs:finite(o?.firstAt)&&finite(o.preparationMs)?difference(o.firstAt,o.dispatchAt):null,
    toolMs:tools.length?unionMs(tools):calls===0?0:null,reasoningMs:reasoning.length?unionMs(reasoning):null,
    unattributedMs:wallMs==null?null:Math.max(0,wallMs-phaseMs),calls,failed,repeatedCalls:[...names.values()].reduce((n,c)=>n+Math.max(0,c-1),0),
    retries:o?.retries??null,input:count('input'),output:count('output'),reasoning:count('reasoning'),usageComplete};
}
