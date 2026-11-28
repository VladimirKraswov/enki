// @vitest-environment jsdom
// A failure list rendered verbatim covers the window: the toast shows one
// readable line and keeps the whole message in its tooltip.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TOAST_TEXT_LIMIT, toastSummary } from '../src/util/toast';

let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const wall = Array.from({ length: 40 }, (_, index) =>
  `provider-${index}: Credential store read failed for provider-${index}: Истекло время ожидания чтения ключа.`
).join('; ');

it('keeps a short notice exactly as written', () => {
  expect(toastSummary('Модели обновлены')).toBe('Модели обновлены');
});

it('collapses a failure list to one readable line without cutting a word', () => {
  const summary = toastSummary(wall);
  expect(summary.length).toBeLessThanOrEqual(TOAST_TEXT_LIMIT + 1);
  expect(summary.endsWith('…')).toBe(true);
  expect(summary).toContain('provider-0:');
  expect(summary).not.toMatch(/\s…$/);
});

it('renders the summary but keeps the full text in the tooltip', async () => {
  vi.resetModules();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  const { store } = await import('../src/state/store');
  const { Toast } = await import('../src/components/Dialogs');
  const node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
  act(() => store.setUi({ toast: wall }));
  await act(async () => { root!.render(createElement(Toast)); });
  const span = document.querySelector('.toast span')!;
  expect(span.textContent!.length).toBeLessThanOrEqual(TOAST_TEXT_LIMIT + 1);
  expect(span.getAttribute('title')).toBe(wall);
  act(() => store.setUi({ toast: null }));
});
