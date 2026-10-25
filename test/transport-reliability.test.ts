// Event-stream and request reliability of the runtime transport. Ported from
// the OpenCode runEventStream/OpenCodeClient suite to the live owners:
// src/agent/runtime/events.ts (durable-cursor SSE) and RuntimeClient.
// (src/api/events.ts has no production importer left.)
import { afterEach, expect, it, vi } from 'vitest';
import { runRuntimeStream, type RuntimeStreamOptions } from '../src/agent/runtime/events';
import { RuntimeClient, type RuntimeConnection } from '../src/agent/runtime/client';
import { ConnectionError } from '../src/api/http';
import { EVENT_FRAME_CHARACTERS } from '../src-tauri/resources/agent/src/protocol';

const connection: RuntimeConnection = { endpoint: 'http://127.0.0.1:43123', token: 't'.repeat(43), instance: 'i1', version: 'test', contract: 1 };
const client = (refresh = async () => connection) => new RuntimeClient(connection, refresh);
const hello = (instance = 'i1', head = 5) => `data: ${JSON.stringify({ type: 'stream.hello', instance, head, contract: 1 })}\n\n`;
const envelope = (seq: number, type = `e${seq}`) => `data: ${JSON.stringify({ seq, time: 1, directory: '/p', sessionID: 's', event: { type, properties: {} } })}\n\n`;
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });
function run(extra: Partial<RuntimeStreamOptions> & { signal: AbortSignal }) {
  return runRuntimeStream({ client: client(), scope: { directory: '/p' }, onEnvelope: () => {}, onState: () => {}, onReset: () => {}, ...extra });
}

it('backs off repeated immediate EOFs rather than resetting on HTTP headers', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const controller = new AbortController(), attempts: number[] = [];
  vi.stubGlobal('fetch', vi.fn(async () => { attempts.push(Date.now()); if (attempts.length === 4) controller.abort(); return new Response(''); }));
  const operation = run({ signal: controller.signal });
  await vi.runAllTimersAsync();
  await operation;
  expect(attempts).toEqual([0, 2000, 6000, 14000]);
});

it('does not deliver buffered events after the subscription is cancelled', async () => {
  const controller = new AbortController(), received: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(hello() + envelope(6, 'first') + envelope(7, 'stale'))));
  await run({ signal: controller.signal, onEnvelope: e => { received.push(e.event.type); controller.abort(); } });
  expect(received).toEqual(['first']);
});

it('cancels and releases an idle stream reader on subscription disposal', async () => {
  const controller = new AbortController();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(c) { source = c; }, cancel });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
  const state = vi.fn();
  const operation = run({ signal: controller.signal, onState: state });
  await vi.waitFor(() => expect(body.locked).toBe(true));
  controller.abort();
  try {
    await vi.waitFor(() => expect(state).toHaveBeenCalledWith('closed'), { timeout: 200 });
    expect(cancel).toHaveBeenCalled();
    expect(body.locked).toBe(false);
  } finally {
    if (!cancel.mock.calls.length) source.close();
    await operation;
  }
});

it('reports subscriber failure so the caller can resynchronize instead of silently losing an event', async () => {
  const controller = new AbortController(), errors: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(hello() + envelope(6))));
  await run({ signal: controller.signal, onEnvelope: () => { throw new Error('reducer failure'); },
    onState: (state, detail) => { if (state === 'error') { errors.push(detail ?? ''); controller.abort(); } } });
  expect(errors).toEqual(['reducer failure']);
});

it('reports malformed frames without exposing their contents', async () => {
  const controller = new AbortController(), errors: string[] = [], event = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('data: private invalid payload\n\n')));
  await run({ signal: controller.signal, onEnvelope: event, onState: (state, detail) => { if (state === 'error') { errors.push(detail ?? ''); controller.abort(); } } });
  expect(errors).toEqual(['Invalid event stream JSON']);
  expect(event).not.toHaveBeenCalled();
});

it('resumes from the last delivered seq, drops duplicates, and asks for reconciliation after a restart or an expired cursor', async () => {
  const controller = new AbortController(), urls: URL[] = [], seen: number[] = [], resets: string[] = [];
  const bodies = [hello('i1', 5) + envelope(6) + envelope(6) + envelope(4), hello('i1', 6) + envelope(7), hello('i2', 100) + envelope(101),
    `data: ${JSON.stringify({ type: 'stream.reset', reason: 'expired', head: 200 })}\n\n` + envelope(201)];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    urls.push(new URL(url));
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${connection.token}`);
    const body = bodies[urls.length - 1];
    if (!body) { controller.abort(); return new Response(''); }
    return new Response(body);
  }));
  await run({ signal: controller.signal, maxBackoffMs: 1, onEnvelope: e => seen.push(e.seq), onReset: r => resets.push(r) });
  expect(seen).toEqual([6, 7, 101, 201]);
  expect(resets).toEqual(['instance', 'expired']);
  expect(urls.map(u => u.searchParams.get('after'))).toEqual([null, '6', '7', '101', '201']);
  expect(urls.every(u => u.pathname === '/v1/events' && u.searchParams.get('directory') === '/p' && !u.search.includes(connection.token))).toBe(true);
});

it('an oversized event (runtime stub, or a too-large frame from an older runtime) advances the cursor once and reconciles; no endless replay', async () => {
  const controller = new AbortController(), urls: URL[] = [], seen: number[] = [], resets: string[] = [];
  const stub = `id: 6\ndata: ${JSON.stringify({ seq: 6, time: 1, directory: '/p', sessionID: 's', event: { type: 'event.oversized', properties: { type: 'message.part.updated', bytes: 9e6 } } })}\n\n`;
  const legacy = `id: 8\ndata: ${JSON.stringify({ seq: 8, time: 1, directory: '/p', sessionID: 's', event: { type: 'message.part.updated', properties: { blob: 'x'.repeat(EVENT_FRAME_CHARACTERS) } } })}\n\n`;
  // Seq 9 sits behind the oversized frame in the same chunk: it is NOT consumed
  // there, and the server replays it after the reconnect from 8.
  const bodies = [hello('i1', 5) + stub + `id: 7\n${envelope(7)}` + legacy + envelope(9), hello('i1', 9) + envelope(9) + envelope(10)];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(new URL(url));
    const body = bodies[urls.length - 1];
    if (!body) { controller.abort(); return new Response(''); }
    return new Response(body);
  }));
  await run({ signal: controller.signal, maxBackoffMs: 1, onEnvelope: e => seen.push(e.seq), onReset: r => resets.push(r) });
  // The stub is not applied as data; the oversized legacy frame is skipped by
  // its announced seq; the reconnect resumes AFTER it (8), never re-asks for it.
  expect(seen).toEqual([7, 9, 10]);
  expect(resets).toEqual(['oversized', 'oversized']);
  expect(urls.map(u => u.searchParams.get('after'))).toEqual([null, '8', '10']);
});

it('a rejected stream token refreshes the connection once and resends the subscription', async () => {
  const controller = new AbortController(), refresh = vi.fn(async () => ({ ...connection, token: 'r'.repeat(43) })), auth: (string | null)[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    auth.push(new Headers(init.headers).get('Authorization'));
    if (auth.length === 1) return new Response(null, { status: 401 });
    controller.abort();
    return new Response(hello());
  }));
  await runRuntimeStream({ client: client(refresh), scope: { all: true }, signal: controller.signal, onEnvelope: () => {}, onState: () => {}, onReset: () => {} });
  expect(refresh).toHaveBeenCalledOnce();
  expect(auth).toEqual([`Bearer ${connection.token}`, `Bearer ${'r'.repeat(43)}`]);
});

it.each(['timeout', 'cancel'] as const)('classifies %s while reading the response body correctly', async kind => {
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => ({
    ok: true, status: 200,
    text: () => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      if (kind === 'cancel') controller.abort(new DOMException('Caller cancelled', 'AbortError'));
    }),
  })));
  const request = new RuntimeClient(connection, async () => connection, 10).request('GET', '/fixture', { signal: controller.signal });
  if (kind === 'cancel') await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  else await expect(request).rejects.toBeInstanceOf(ConnectionError);
});
