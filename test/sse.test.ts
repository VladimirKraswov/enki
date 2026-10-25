import { expect, it } from 'vitest';
import { SseDecoder, SseFrameTooLarge } from '../src/api/sse';
import { EVENT_FRAME_CHARACTERS, EVENT_WIRE_LIMIT_BYTES } from '../src-tauri/resources/agent/src/protocol';

it('decodes split CRLF, standalone CR, comments and multiline data', () => {
  const decoder = new SseDecoder();
  const events: string[] = [];
  for (const chunk of [': heartbeat\r', '\ndata: first\r', '\ndata: second\r\r', 'data: third\n\n'])
    decoder.push(chunk, data => { events.push(data); return true; });
  expect(events).toEqual(['first\nsecond', 'third']);
});
it('bounds each event rather than discarding valid frames in a large transport chunk', () => {
  const decoder = new SseDecoder(20), events: string[] = [];
  decoder.push('data: value\n\n'.repeat(100), data => { events.push(data); return true; });
  expect(events).toHaveLength(100);
});
it('fails an oversized unfinished frame explicitly and never publishes its suffix', () => {
  const decoder = new SseDecoder(20);
  expect(() => decoder.push('data: ' + 'x'.repeat(21), () => { throw Error('must not dispatch'); })).toThrow('size limit');
});
it('passes each frame id and names the seq of an oversized frame so the client can move past it', () => {
  const decoder = new SseDecoder(40), seen: Array<[string, string | null]> = [];
  decoder.push('id: 7\ndata: {"a":1}\n\ndata: {"b":2}\n\n', (data, id) => { seen.push([data, id]); return true; });
  expect(seen).toEqual([['{"a":1}', '7'], ['{"b":2}', null]]);
  let failure: unknown;
  try { decoder.push('id: 8\ndata: ' + 'x'.repeat(60), () => { throw Error('must not dispatch'); }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(SseFrameTooLarge);
  expect((failure as SseFrameTooLarge).id).toBe('8');
  // The decoder is reusable afterwards (a new connection starts clean anyway).
  decoder.push('id: 9\ndata: ok\n\n', (data, id) => { seen.push([data, id]); return true; });
  expect(seen.at(-1)).toEqual(['ok', '9']);
});
it('the runtime wire bound always fits the WebView decoder bound', () => {
  expect(EVENT_FRAME_CHARACTERS).toBeGreaterThan(EVENT_WIRE_LIMIT_BYTES + 32);
  expect(EVENT_FRAME_CHARACTERS).toBeLessThanOrEqual(4_000_000);
});
