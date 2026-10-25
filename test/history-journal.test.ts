// Final integration (UI performance audit P1): the journal kept while a
// history page / reconnect snapshot is in flight retains part REFERENCES, not
// growing snapshot copies, and still reconciles exactly. Written, NOT RUN.
import { expect, it } from 'vitest';
import { HistoryJournal, HISTORY_JOURNAL_LIMIT } from '../src/state/historyJournal';
import { applyHistory, emptyChatRoot, reconcileHistoryEvents, reduceEvent } from '../src/state/chatReducer';
import type { ServerEvent } from '../src/api/types';

const part = (text: string, id = 'p1'): ServerEvent => ({ type: 'message.part.updated', properties: { part: { id, sessionID: 's', messageID: 'm', type: 'reasoning', text } } });

it('a long reasoning stream retains one compact reference per part, not n growing snapshots', () => {
  const journal = new HistoryJournal();
  let text = '';
  for (let n = 0; n < 5_000; n++) { text += 'думаю '.repeat(8); journal.push(part(text)); }
  journal.push({ type: 'message.part.delta', properties: { sessionID: 's', messageID: 'm', partID: 'p2', field: 'text', delta: 'x' } });
  journal.push({ type: 'session.status', properties: { sessionID: 's', status: { type: 'busy' } } });
  expect(journal.events).toEqual([
    { type: 'message.part.updated', properties: { sessionID: 's', partID: 'p1' } },
    { type: 'message.part.delta', properties: { sessionID: 's', partID: 'p2' } },
    { type: 'session.status', properties: { sessionID: 's', status: { type: 'busy' } } },
  ]);
  expect(JSON.stringify(journal.events).length).toBeLessThan(400);
  expect(journal.overflowed).toBe(false);
});

it('reconciliation over the compact journal keeps the live (newest) part text exactly', () => {
  const live = emptyChatRoot();
  reduceEvent(live, { type: 'message.updated', properties: { info: { id: 'm', sessionID: 's', role: 'assistant', time: { created: 1 } } } });
  reduceEvent(live, part('старое новое продолжение'));
  const journal = new HistoryJournal();
  journal.push(part('старое новое'));
  journal.push(part('старое новое продолжение'));
  const root = emptyChatRoot();
  // The history page was produced before the stream advanced.
  applyHistory(root, 's', [{ info: { id: 'm', sessionID: 's', role: 'assistant', time: { created: 1 } }, parts: [{ id: 'p1', sessionID: 's', messageID: 'm', type: 'reasoning', text: 'старое' }] }] as never);
  reconcileHistoryEvents(root, 's', live.sessions.s, journal.events);
  expect(root.sessions.s.parts.p1.text).toBe('старое новое продолжение');
});

it('overflow is explicit and stops retention', () => {
  const journal = new HistoryJournal();
  for (let n = 0; n < HISTORY_JOURNAL_LIMIT + 10; n++) journal.push({ type: 'session.status', properties: { sessionID: `s${n}`, status: { type: 'idle' } } });
  expect(journal.overflowed).toBe(true);
  expect(journal.events).toHaveLength(HISTORY_JOURNAL_LIMIT);
});
