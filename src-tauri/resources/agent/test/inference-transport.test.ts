import { expect, it } from 'vitest';
import { InferenceObserver, stableTools } from '../src/sdk/inference-transport.ts';
import { parseInferenceProgress, type InferenceProgress } from '../src/inference-progress.ts';
import { compactionBudget } from '../src/context-budget.ts';

const tool = (name: string) => ({ type: 'function', function: { name, description: 'same', parameters: { type: 'object', properties: {} } } });
const payload = { messages: [{ role: 'system', content: 'stable instructions' }], tools: [tool('a'), tool('z')] };
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const progress = (processed: number, cache = 20, total = 100) => ({ prompt_progress: { total, processed, cache, time_ms: processed * 10 } });
const delta = (value: object) => ({ choices: [{ delta: value }] });
async function consume(request: ReturnType<InferenceObserver['begin']>, wire: string) {
  const bytes = new TextEncoder().encode(wire);
  const original = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } });
  const response = await request.wrap(async () => new Response(original, { headers: { 'Content-Type': 'text/event-stream', 'X-Original': 'yes' } }))('http://fixture.invalid');
  expect(response.headers.get('X-Original')).toBe('yes');
  expect(await response.text()).toBe(wire);
}

it('forwards fragmented SSE byte-for-byte while publishing measured progress and decoding phases', async () => {
  const out: InferenceProgress[] = []; let now = 1000;
  const observer = new InferenceObserver(p => { out.push(p); now += 1500; }, () => now);
  await consume(observer.begin(payload), sse(progress(20)) + sse(progress(80)) + sse(progress(100))
    + sse(delta({ reasoning_content: 'мысль' })) + sse(delta({ content: 'Ответ' })) + 'data: [DONE]\n\n');
  expect(out.map(p => p.phase)).toEqual(['waiting', 'prefill', 'prefill', 'prefill', 'reasoning', 'answer']);
  expect(out[2]).toMatchObject({ total: 100, processed: 80, cached: 20, cache: 'reused' });
  expect(new Set(out.map(p => p.requestID)).size).toBe(1);
});
it('rejects regressing/invalid metadata without corrupting or truncating the answer', async () => {
  const out: InferenceProgress[] = [];
  const request = new InferenceObserver(p => out.push(p)).begin(payload);
  await consume(request, sse(progress(30)) + sse(progress(10)) + sse(progress(110))
    + sse({ prompt_progress: { total: 100, processed: 50, cache: -1, time_ms: 1 } }) + sse(delta({ content: 'safe' })) + sse(progress(100)));
  expect(out.map(p => p.phase)).toEqual(['waiting', 'prefill', 'answer']);
  expect(parseInferenceProgress({ ...out[1], processed: Infinity })).toBeUndefined();
  expect(parseInferenceProgress({ ...out[1], cached: 80, processed: 20 })).toBeUndefined();
});
it('fences stale requests, aborts and sessions; a retry has a distinct request identity', async () => {
  const a: InferenceProgress[] = [], b: InferenceProgress[] = [];
  const observer = new InferenceObserver(p => a.push(p));
  const old = observer.begin(payload), current = observer.begin(payload);
  await consume(old, sse(progress(100)));
  expect(a).toHaveLength(2);
  const controller = new AbortController();
  const aborted = new InferenceObserver(p => b.push(p)).begin(payload, controller.signal);
  controller.abort(); await consume(aborted, sse(progress(100)));
  expect(b).toHaveLength(1);
  current.end(); await consume(current, sse(progress(100)));
  expect(a[0].requestID).not.toBe(a[1].requestID);
  expect(a).toHaveLength(2);
});
it('bounds and throttles observation, passes vendor errors/usage and large tool frames unchanged', async () => {
  const out: InferenceProgress[] = [];
  const request = new InferenceObserver(p => out.push(p), () => 1000).begin(payload);
  let wire = sse(progress(20));
  for (let i = 21; i < 100; i++) wire += sse(progress(i));
  wire += sse({ choices: [{ delta: { tool_calls: [{ function: { arguments: 'x'.repeat(100_000) } }] } }] });
  wire += 'data: malformed\n\n' + sse(progress(100)) + sse({ error: { message: 'provider error' } }) + sse({ choices: [], usage: { total_tokens: 123 } });
  await consume(request, wire);
  expect(out.filter(p => p.phase === 'prefill')).toHaveLength(2);
});
it('canonicalizes only unique tool definitions; keeps transcript, user intent and explicit defaults', () => {
  const changedOrder = { ...payload, tools: [...payload.tools].reverse() };
  expect(stableTools(changedOrder)).toEqual(stableTools(payload));
  expect((stableTools(changedOrder) as typeof payload).messages).toBe(payload.messages);
  const duplicate = { ...payload, tools: [tool('a'), tool('a')] };
  expect(stableTools(duplicate)).toBe(duplicate);
});
it('distinguishes a real prefix change from a cold or reused cache without exposing prompt text', async () => {
  const out: InferenceProgress[] = [], observer = new InferenceObserver(p => out.push(p));
  await consume(observer.begin(stableTools(payload)), sse(progress(0, 0)));
  expect(out.at(-1)?.cache).toBe('cold');
  await consume(observer.begin(stableTools({ ...payload, tools: [...payload.tools].reverse() })), sse(progress(0, 0)));
  expect(out.at(-1)?.cache).toBe('cold');
  await consume(observer.begin({ ...payload, messages: [{ role: 'system', content: 'changed private instructions' }] }), sse(progress(0, 0)));
  expect(out.at(-1)?.cache).toBe('prefix_changed');
  expect(JSON.stringify(out)).not.toContain('private instructions');
});
it('reserves a full answer for SDK compaction and bounds the retained tail on small models', () => {
  expect(compactionBudget({ contextWindow: 262144, maxTokens: 32768 })).toEqual({ reserveTokens: 36864, keepRecentTokens: 20000, triggerTokens: 225280 });
  const small = compactionBudget({ contextWindow: 8192, maxTokens: 512 });
  expect(small.reserveTokens).toBeGreaterThanOrEqual(512);
  expect(small.keepRecentTokens).toBeLessThan(small.triggerTokens);
  expect(compactionBudget({ contextWindow: 262144, maxTokens: 32768 }, { reserveTokens: 65536 }).reserveTokens).toBe(65536);
});
