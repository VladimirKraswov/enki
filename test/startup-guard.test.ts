// @vitest-environment jsdom
// The window must never stay silently white: an uncaught startup error or a
// window that never painted has to become a readable, retryable panel instead.
import { afterEach, expect, it, vi } from 'vitest';
import {
  STARTUP_FAILURE_ID,
  clearStartupFailure,
  installStartupGuard,
  shouldReportBlankWindow,
  showStartupFailure,
  startupDetail,
} from '../src/startup/guard';

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function root(children: number): HTMLElement {
  const node = document.createElement('div');
  node.id = 'root';
  for (let index = 0; index < children; index += 1) node.append(document.createElement('span'));
  document.body.append(node);
  return node;
}

const panel = () => document.getElementById(STARTUP_FAILURE_ID);

it('reports only an empty app root', () => {
  expect(shouldReportBlankWindow(null)).toBe(false);
  expect(shouldReportBlankWindow(root(0))).toBe(true);
  document.body.innerHTML = '';
  expect(shouldReportBlankWindow(root(2))).toBe(false);
});

it('keeps the real error text and offers a retry instead of a white window', () => {
  root(0);
  showStartupFailure(document, startupDetail(new Error('Среда выполнения Enki ещё не подключена.')));
  expect(panel()).not.toBeNull();
  expect(panel()!.textContent).toContain('Интерфейс Enki не запустился');
  expect(panel()!.textContent).toContain('Среда выполнения Enki ещё не подключена.');
  expect([...panel()!.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Загрузить интерфейс заново']);
  // The app root stays in place: React keeps owning it.
  expect(document.getElementById('root')).not.toBeNull();
});

it('turns an uncaught error on an empty root into a visible panel', () => {
  vi.useFakeTimers();
  const node = root(0);
  const guard = installStartupGuard(document, window);
  window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom'), message: 'boom' }));
  vi.advanceTimersByTime(300);
  expect(panel()).not.toBeNull();
  expect(panel()!.textContent).toContain('boom');
  expect(guard.detail()).toContain('boom');
  node.append(document.createElement('span'));
  clearStartupFailure(document);
  expect(panel()).toBeNull();
  guard.dispose();
});

it('never replaces an interface that rendered, even after an error', () => {
  vi.useFakeTimers();
  root(3);
  const guard = installStartupGuard(document, window);
  window.dispatchEvent(new ErrorEvent('error', { error: new Error('late failure'), message: 'late failure' }));
  vi.advanceTimersByTime(300);
  expect(panel()).toBeNull();
  expect(guard.detail()).toBeNull();
  guard.dispose();
});

it('reports a window that never painted even without an error', () => {
  vi.useFakeTimers();
  root(0);
  const guard = installStartupGuard(document, window);
  vi.advanceTimersByTime(12_000);
  expect(panel()).not.toBeNull();
  expect(panel()!.textContent).toContain('не отрисовал ни одного элемента');
  guard.dispose();
});
