// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act, createElement } from 'react';
import { InferenceStatus } from '../src/components/InferenceStatus';
import { normalizeStatusType } from '../src/api/types';

afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });
it('renders measured progress, cache and elapsed time rather than an invented percentage', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const el = document.createElement('div'); document.body.append(el); const root = createRoot(el);
  await act(async () => root.render(createElement(InferenceStatus, { progress: { requestID: 'one', phase: 'prefill', startedAt: 5000, elapsedMs: 5000, total: 200000, processed: 100000, cached: 90000 } })));
  expect(el.textContent).toContain('Обрабатываю контекст');
  expect(el.querySelector('progress')?.value).toBe(100000);
  expect(el.querySelector('progress')?.max).toBe(200000);
  expect(el.textContent).toContain('5 с');
  await act(async () => root.render(createElement(InferenceStatus, { progress: { requestID: 'two', phase: 'waiting', startedAt: 10000, elapsedMs: 0 } })));
  expect(el.querySelector('progress')).toBeNull();
  await act(async () => vi.advanceTimersByTime(16000));
  expect(el.textContent).toContain('не передал прогресс');
  await act(async () => root.unmount());
});
it('preserves validated request progress in status snapshots and ignores invalid counters', () => {
  const inference = { requestID: 'one', phase: 'prefill', startedAt: 1, elapsedMs: 100, total: 100, processed: 20, cached: 10 };
  expect(normalizeStatusType({ type: 'busy', inference })).toEqual({ type: 'busy', inference });
  expect(normalizeStatusType({ type: 'busy', inference: { ...inference, processed: 101 } })).toEqual({ type: 'busy' });
});
it('names the other chat as the waiting reason only for a proven queue claim', async () => {
  const el = document.createElement('div'); document.body.append(el); const root = createRoot(el);
  await act(async () => root.render(createElement(InferenceStatus, { progress: { requestID: 'one', phase: 'waiting', startedAt: 0, elapsedMs: 3000, queued: true } })));
  expect(el.textContent).toContain('Модель отвечает другому чату');
  expect(el.textContent).toContain('ждёт своей очереди');
  expect(el.textContent).not.toContain('не передал прогресс');
  await act(async () => root.render(createElement(InferenceStatus, { progress: { requestID: 'two', phase: 'waiting', startedAt: 0, elapsedMs: 3000 } })));
  expect(el.textContent).toContain('Ожидаю ответ сервера модели');
  expect(el.textContent).not.toContain('другому чату');
  await act(async () => root.unmount());
});
it('keeps the queue claim only as a literal true and drops it from status when invalid', () => {
  const base = { requestID: 'one', phase: 'waiting', startedAt: 1, elapsedMs: 100 };
  expect(normalizeStatusType({ type: 'busy', inference: { ...base, queued: true } })).toEqual({ type: 'busy', inference: { ...base, queued: true } });
  expect(normalizeStatusType({ type: 'busy', inference: { ...base, queued: 'yes' } })).toEqual({ type: 'busy' });
});
