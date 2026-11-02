import { afterEach, expect, it } from 'vitest';
import { fauxAssistantMessage } from '../../src/sdk/testing.ts';
import { harness, newSession, promptCommand, type Harness } from '../helpers.ts';

let h: Harness;
afterEach(async () => { await h?.stop(); });

it('enabling auto-compaction applies to an already-open SDK worker without losing history or replacing the chat', async () => {
  h = await harness();
  h.runtime.saveSettings({ ...h.runtime.settings(), compaction: { enabled: false, reserveTokens: 180000, keepRecentTokens: 64 } });
  const dir = h.project('compaction-live'), sid = await newSession(h, dir);
  // Leave enough recent content for the SDK to retain a valid tail while
  // summarizing the long first user message. Otherwise it correctly refuses
  // to compact the only turn instead of discarding the configured tail.
  h.scripted.setResponses([fauxAssistantMessage('First answer remains in history. '.repeat(16))]);
  await h.command(promptCommand(h, 'first-before-enable', sid, dir, 'history note '.repeat(12000)));
  expect((await h.waitReceipt('first-before-enable', ['completed'])).state).toBe('completed');
  const worker = h.runtime.registry.live(sid);
  const before = h.scripted.calls();
  expect(before).toBe(1);
  expect(worker?.usage()?.tokens).toBeGreaterThan(20000);
  let compacted = false;
  const compactions: unknown[] = [];
  const off = h.runtime.journal.subscribe({ directory: dir, sessionID: sid }, event => {
    if (event.event.type === 'session.compaction') compactions.push(event.event.properties);
    if (event.event.type === 'session.compaction' && event.event.properties.ok === true) compacted = true;
  });
  try {
    h.runtime.saveSettings({ ...h.runtime.settings(), compaction: { enabled: true, reserveTokens: 180000, keepRecentTokens: 64 } });
    expect(h.runtime.registry.live(sid)).toBe(worker);
    h.scripted.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage('Short verified summary with the current objective.')));
    await h.command(promptCommand(h, 'second-after-enable', sid, dir, 'Continue this same task'));
    const result = await h.waitReceipt('second-after-enable', ['completed', 'failed']);
    expect(result.state, result.error ?? '').toBe('completed');
    expect(compacted, JSON.stringify(compactions)).toBe(true);
    expect(h.scripted.calls()).toBeGreaterThan(before + 1);
    expect(h.runtime.registry.live(sid)).toBe(worker);
    expect(worker?.history().filter(m => m.info.role === 'user')).toHaveLength(2);
    expect(worker?.history().some(m => m.parts.some(p => p.text?.includes('First answer remains in history')))).toBe(true);
  } finally { off(); }
});
