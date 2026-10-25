import { expect, it, vi } from 'vitest';
import { initialState } from '../src/state/initial';
import { DEFAULT_PREFS } from '../src/state/prefs';
import { emptySessionChat } from '../src/state/chatReducer';
import { collectHubRecords, iterateHubRecords } from '../src/hub/collection';
import { enqueueChangedRecords } from '../src/hub/incremental';
import { taskDiagnostics, taskPositions } from '../src/diagnostics/tasks';
import type { Message, MessagePart } from '../src/api/types';
import type { HubRecord } from '../src/hub/records';

function transcript(turns: number) {
  const chat = emptySessionChat();
  for (let n = 0; n < turns; n++) {
    const user: Message = { id: `u${n}`, sessionID: 's', role: 'user', time: { created: n * 10 }, ...(n % 7 === 3 ? { timingKey: 'shared' } : {}) };
    const assistant: Message = { id: `a${n}`, sessionID: 's', role: 'assistant', parentID: user.id, finish: 'stop', time: { created: n * 10 + 1, completed: n * 10 + 5 }, tokens: { input: 1, output: 1 } } as Message;
    const part: MessagePart = { id: `p${n}`, sessionID: 's', messageID: assistant.id, type: 'text', text: `answer ${n}` };
    chat.messageOrder.push(user.id, assistant.id);
    chat.messages[user.id] = user; chat.messages[assistant.id] = assistant;
    chat.parts[part.id] = part; chat.partsByMessage[assistant.id] = [part.id]; chat.partsByMessage[user.id] = [];
  }
  return chat;
}
function state(chat = transcript(3)) {
  const s = initialState(structuredClone(DEFAULT_PREFS));
  s.directory = '/p'; s.sessions = [{ id: 's', directory: '/p', title: 'Task', projectID: 'p', time: { created: 1, updated: 1 } }];
  s.chat.sessions.s = chat;
  return s;
}

it('one-pass positions give exactly the per-request diagnostics, including shared timing keys', () => {
  const chat = transcript(40), positions = taskPositions(chat);
  for (const id of chat.messageOrder.filter(id => chat.messages[id].role === 'user'))
    expect(taskDiagnostics(chat, id, positions.get(id))).toEqual(taskDiagnostics(chat, id));
});

// Regression: three whole-transcript scans per user message made each 10 s Hub
// tick O(n²) for a long loaded chat.
it('collecting a long transcript reads each message a bounded number of times', () => {
  const chat = transcript(1000);
  let reads = 0;
  chat.messages = new Proxy(chat.messages, { get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); } });
  const records = collectHubRecords(state(chat), new Map(), true);
  expect(records).toHaveLength(2000);
  expect(reads).toBeLessThan(20 * chat.messageOrder.length);
});

it('an unchanged assistant record is reused and not re-hashed; a replaced part or setting rebuilds it', async () => {
  const s = state();
  const first = [...iterateHubRecords(s, new Map(), true)], again = [...iterateHubRecords(s, new Map(), true)];
  const assistant = (items: typeof first) => items.find(item => item.record.id === 'a1')!;
  expect(assistant(again).record).toBe(assistant(first).record);
  expect(assistant(again).stable).toBe(true);
  s.chat.sessions.s.parts.p1 = { ...s.chat.sessions.s.parts.p1, text: 'edited' };
  const edited = assistant([...iterateHubRecords(s, new Map(), true)]);
  expect(edited.record).not.toBe(assistant(first).record);
  expect(edited.record.text).toBe('edited');
  expect(assistant([...iterateHubRecords(s, new Map(), false)]).record.text).toBe('');
  // User records carry diagnostics/assessment and are never flagged stable.
  expect(first.find(item => item.record.id === 'u1')!.stable).toBeUndefined();

  const hash = vi.fn(async (record: HubRecord) => `${record.id}:${record.text}`), observed = new WeakMap<Message, string>(), enqueue = vi.fn(async () => {});
  const items = [...iterateHubRecords(s, new Map(), true)];
  await enqueueChangedRecords(items, observed, enqueue, () => true, hash, async () => {});
  await enqueueChangedRecords([...iterateHubRecords(s, new Map(), true)], observed, enqueue, () => true, hash, async () => {});
  const stableCount = items.filter(item => item.stable).length, userCount = items.length - stableCount;
  expect(hash).toHaveBeenCalledTimes(stableCount + 2 * userCount);
  expect(enqueue).toHaveBeenCalledOnce();
});
