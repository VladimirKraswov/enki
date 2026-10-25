// Re-homed from the retired OpenCode `events.test.ts` case 0 ("parses LF and
// split CRLF events and stops cleanly") onto the ACTUAL runtime parser path:
// runRuntimeStream (src/agent/runtime/events.ts) → SseDecoder (src/api/sse.ts).
// Unlike transport-reliability (complete LF frames only), every frame boundary
// here is cut across network chunks: CR | LF, a blank line split in two, a
// CR-only terminator, multi-line data, and a UTF-8 character split mid-byte.
import { afterEach, expect, it, vi } from 'vitest';
import { runRuntimeStream } from '../src/agent/runtime/events';
import { RuntimeClient, type RuntimeConnection } from '../src/agent/runtime/client';
import type { EventEnvelope } from '../src-tauri/resources/agent/src/protocol';

const connection: RuntimeConnection = { endpoint: 'http://127.0.0.1:43123', token: 't'.repeat(43), instance: 'i1', version: 'test', contract: 1 };
const json = (seq: number, type: string, properties: Record<string, unknown> = {}) =>
  JSON.stringify({ seq, time: 1, directory: '/p', sessionID: 's', event: { type, properties } });
afterEach(() => { vi.unstubAllGlobals(); });

it('parses LF, CRLF split across chunks, CR-only and split UTF-8 frames, then stops cleanly on abort', async () => {
  const bytes = new TextEncoder();
  const utf8 = bytes.encode(`data: ${json(9, 'utf8', { text: 'ёлка' })}\n\n`);
  const cut = utf8.indexOf(0xd1) + 1; // inside the two-byte "ё"
  const chunks: Uint8Array[] = [
    // LF-framed hello.
    bytes.encode(`data: ${JSON.stringify({ type: 'stream.hello', instance: 'i1', head: 5, contract: 1 })}\n\n`),
    // CRLF frame: CR ends one chunk, its LF starts the next; the empty line is split too.
    bytes.encode('id: 6\r'), bytes.encode(`\ndata: ${json(6, 'crlf')}\r`), bytes.encode('\n\r'), bytes.encode('\n'),
    // Multi-line data joined with "\n" (legal JSON whitespace), LF-framed.
    bytes.encode(`data: {"seq":7,"time":1,"directory":"/p",\ndata: "sessionID":"s","event":{"type":"multiline","properties":{}}}\n\n`),
    // CR-only line terminators.
    bytes.encode(`data: ${json(8, 'cr')}\r\r`),
    utf8.slice(0, cut), utf8.slice(cut),
    // Buffered after the abort below: must never be delivered.
    bytes.encode(`data: ${json(10, 'after-abort')}\n\n`),
  ];
  const cancel = vi.fn();
  const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(c) { for (const chunk of chunks) c.enqueue(chunk); }, // never closed: only abort ends it
    cancel,
  })));
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController(), received: EventEnvelope[] = [], states: string[] = [], resets: string[] = [];
  await runRuntimeStream({
    client: new RuntimeClient(connection, async () => connection), scope: { directory: '/p' }, signal: controller.signal,
    onEnvelope: envelope => { received.push(envelope); if (envelope.seq === 9) controller.abort(); },
    onState: state => states.push(state), onReset: reason => resets.push(reason),
  });
  expect(received.map(e => [e.seq, e.event.type])).toEqual([[6, 'crlf'], [7, 'multiline'], [8, 'cr'], [9, 'utf8']]);
  expect(received[3].event.properties).toEqual({ text: 'ёлка' });
  expect(resets).toEqual([]);
  // Clean stop: one request, no reconnect/backoff after the abort, reader cancelled.
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalled();
  expect(states).toEqual(['connecting', 'open', 'closed']);
});
