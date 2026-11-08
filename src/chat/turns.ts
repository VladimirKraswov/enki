import type {AssistantMessage, Message, MessagePart, UserMessage} from '../api/types';

export type ConversationRow = {kind:'user';key:string;message:UserMessage} | AssistantTurn;
export interface AssistantTurn {kind:'assistant';key:string;messages:AssistantMessage[]}
const answerFinishes = new Set(['stop', 'end_turn', 'stop_sequence']);

/** Engine messages are steps. Group only adjacent steps of the same request, never rewrite history. */
export function groupConversation(messages: Message[]): ConversationRow[] {
  const rows: ConversationRow[] = [], keys = new Set<string>();
  for (const message of messages) {
    if (message.role === 'user') { rows.push({kind:'user',key:message.id,message}); continue; }
    const last = rows[rows.length - 1];
    if (last?.kind === 'assistant' && !message.summary && !last.messages[0].summary
      && message.parentID === last.messages[0].parentID) {
      last.messages.push(message);
    } else {
      const base = `turn:${message.summary ? message.id : message.parentID ?? message.id}`;
      const key = keys.has(base) ? `${base}:${message.id}` : base;
      keys.add(key); rows.push({kind:'assistant',key,messages:[message]});
    }
  }
  return rows;
}
export function visibleParts(parts: MessagePart[]): MessagePart[] {
  return parts.filter(p => p.type === 'text' ? !p.synthetic && !p.ignored && !!p.text?.trim()
    : p.type === 'reasoning' ? !!p.text?.trim() : ['tool','patch','retry','compaction'].includes(p.type));
}
export function answerText(parts: MessagePart[]): string {
  return parts.filter(p => p.type === 'text' && !p.synthetic && !p.ignored).map(p=>p.text??'').join('\n\n');
}
export function finalAnswer(message: AssistantMessage, parts: MessagePart[]): boolean {
  return !!message.time.completed && !message.error && !message.summary
    && answerFinishes.has(message.finish ?? '') && !!answerText(parts).trim()
    && !parts.some(p => p.type === 'tool' && (!p.state || ['pending','running'].includes(p.state.status)));
}
export function turnMetrics(messages: AssistantMessage[]) {
  return {
    profiles: [...new Set(messages.filter(m=>m.modelID).map(m=>`${m.modelID}${m.variant ? ` · ${m.variant}` : ''}`))],
    output: messages.reduce((sum,m)=>sum+(m.tokens?.output??0),0),
    partial: messages.some(m=>typeof m.tokens?.output!=='number'),
  };
}
function countLabel(count: number, words: [string, string, string]): string {
  const word = count % 10 === 1 && count % 100 !== 11 ? words[0]
    : [2,3,4].includes(count % 10) && ![12,13,14].includes(count % 100) ? words[1] : words[2];
  return `${count} ${word}`;
}
export const actionCountLabel = (count: number) => countLabel(count, ['действие', 'действия', 'действий']);
export const stepCountLabel = (count: number) => countLabel(count, ['шаг', 'шага', 'шагов']);

/** Objective evidence for a user who did not watch the turn: how many tool calls
 * the current assistant turn already made and which tool ran last. The current
 * turn is everything after the latest user message. */
export function currentTurnActivity(messages: Message[], partsFor: (messageID: string) => MessagePart[]): { actions: number; lastTool: string | null } | null {
  let start = messages.length - 1;
  while (start >= 0 && messages[start]?.role !== 'user') start--;
  let actions = 0, lastTool: string | null = null;
  for (const message of messages.slice(start + 1)) {
    if (message?.role !== 'assistant') continue;
    for (const part of partsFor(message.id)) {
      if (part?.type !== 'tool') continue;
      actions++;
      if (part.tool) lastTool = part.tool;
    }
  }
  return actions ? { actions, lastTool } : null;
}
