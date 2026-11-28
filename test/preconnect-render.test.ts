// @vitest-environment jsdom
// A restored chat is on screen while the runtime is still starting: the chat id
// and directory come from the saved preferences, but `store.client` exists only
// after `connect()`. The session-diff counter read that client inside its effect,
// the uncaught ConnectionError unmounted the React root, and the window stayed
// blank on every launch that had an open chat. Rendering the same state must not
// touch the runtime and must not raise an uncaught error.
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('renders a restored chat before the runtime connects instead of blanking the window', async () => {
  vi.resetModules();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));

  const { store } = await import('../src/state/store');
  // Nothing is connected yet: exactly the state of the window right after launch.
  expect(store.maybeBackend()).toBeNull();
  store.state.activeSessionId = 'ses_preconnect';
  store.state.directory = '/tmp/enki-preconnect';
  let fetches = 0;
  vi.stubGlobal('fetch', () => { fetches += 1; return Promise.reject(new Error('no runtime yet')); });

  const uncaught: unknown[] = [];
  const onError = (event: ErrorEvent) => uncaught.push(event.error ?? event.message);
  window.addEventListener('error', onError);
  try {
    const { ChangeSummary } = await import('../src/components/Composer');
    const node = document.createElement('div');
    document.body.append(node);
    root = createRoot(node);
    await act(async () => {
      root!.render(createElement(ChangeSummary, { sessionId: 'ses_preconnect', directory: '/tmp/enki-preconnect', revision: 0 }));
    });
    // Give the effect (and any stray promise) a turn to run.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  } finally {
    window.removeEventListener('error', onError);
  }

  expect(uncaught).toEqual([]);
  // No diff, no request, and no crash marker in the window.
  expect(document.querySelector('.composer-change-summary')).toBeNull();
  expect(fetches).toBe(0);
});
