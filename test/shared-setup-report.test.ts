// Optional shared-MCP outages are reported from the runtime's own pool
// (GET /extensions → mcp[]) instead of the former OpenCode configureShared
// report. They are announced once per workspace/directory episode and never
// become a blocking send error.
import { it, expect, vi, afterEach } from 'vitest';
import { RuntimeReply, bindStore, runtimeFixture } from './helpers/runtime-fixture';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('keeps optional MCP failure out of the blocking send error while reporting it to the user', async () => {
  const { store } = await import('../src/state/store');
  const fx = runtimeFixture();
  let mcp = [{ key: 'k-web', server: 'Web Compass', refs: 0, state: 'closed' }, { key: 'k-search', server: 'Search', refs: 1, state: 'connected' }];
  fx.on('GET', '/extensions', () => ({ sessions: [], mcp }));
  bindStore(store, fx, { directory: '/work', ui: { ...store.state.ui, sendError: null, toast: null } });
  await expect(store.configureSharedTools('/work')).resolves.toBeUndefined();
  expect(fx.made('GET', '/extensions')[0].query).toEqual({ directory: '/work' });
  expect(store.state.ui.toast).toContain('Web Compass');
  expect(store.state.ui.toast).not.toContain('Search');
  expect(store.state.ui.sendError).toBeNull();
  // The same outage is not announced again after the user dismissed it.
  store.setUi({ toast: null });
  await store.configureSharedTools('/work');
  expect(store.state.ui.toast).toBeNull();
  // Confirmed recovery clears only our own message.
  await store.configureSharedTools('/work');
  mcp = mcp.map(entry => ({ ...entry, state: 'connected' }));
  store.setUi({ toast: 'Не наше сообщение' });
  await store.configureSharedTools('/work');
  expect(store.state.ui.toast).toBe('Не наше сообщение');
  // A runtime refusal is surfaced to the caller, not swallowed.
  fx.on('GET', '/extensions', () => { throw new RuntimeReply(500, { message: 'pool unavailable' }); });
  await expect(store.configureSharedTools('/work')).rejects.toMatchObject({ status: 500 });
  expect(fx.made('POST', '/commands')).toHaveLength(0);
});
