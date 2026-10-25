// @vitest-environment jsdom
// Independent replacement for the window-side part of the held model-hub case 4
// ("a failed loader remains a terminal error and a readiness check never
// selects a model"): the window's Hub check is a read-only `inspect`; it never
// prepares, selects, renews or releases. Failed-loader terminal status with no
// SDK dispatch is the RUNTIME's (agent cancel-and-hub / model-context-hub).
import { afterEach, expect, it, vi } from 'vitest';
import { HubModelServices, type HubRoute, type ModelHubTransport } from '../src/models/hub';
import { ModelServices, type SwitchStatus } from '../src/models/services';
import { HubRequestError } from '../src/hub/errors';

const route: HubRoute = { service: 'v100', label: 'V100', providerID: 'local-qwen', modelID: 'qwen', target: 'qwen-medium', agent: 'pi' };
const state = (phase: string, extra: Partial<SwitchStatus> = {}): SwitchStatus => ({ schema: 1, operation_id: null, phase,
  ready: phase === 'ready', active_model: phase === 'ready' ? 'qwen-medium' : null, target_model: 'qwen-medium',
  elapsed_seconds: 0, active_requests: 0, error: null, loader: null, ...extra });
function transport(inspect: () => SwitchStatus, catalog: () => unknown = () => ({ schema: 1, routes: [route] })) {
  const api: ModelHubTransport = { identity: vi.fn(async () => 'hub'), request: vi.fn(async (path: string) => (path === 'catalog' ? catalog() : inspect()) as any) };
  return api;
}
const paths = (api: ModelHubTransport) => vi.mocked(api.request).mock.calls.map(([path]) => path);
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });

it('a check of a failed loader is a read-only inspect: terminal error shown, nothing prepared, selected or polled', async () => {
  vi.useFakeTimers();
  const api = transport(() => state('failed', { error: 'Загрузка не удалась' }));
  const hub = new HubModelServices(api);
  await expect(hub.check(route.providerID, route.modelID, 'pi')).rejects.toThrow('ошибке загрузки модели: Загрузка не удалась');
  expect(paths(api)).toEqual(['catalog', 'inspect']);
  expect(vi.mocked(api.request).mock.calls[1][1]).toEqual({ providerID: 'local-qwen', modelID: 'qwen', agent: 'pi' });
  expect(hub.status(route.providerID, route.modelID)).toMatchObject({ phase: 'failed', ready: false, error: 'Загрузка не удалась' });
  // No renewal/heartbeat/retry timer exists in the window.
  await vi.advanceTimersByTimeAsync(120_000);
  expect(paths(api)).toEqual(['catalog', 'inspect']);
});

it('ready and not-yet-ready checks still only inspect', async () => {
  const ready = transport(() => state('ready'));
  await new HubModelServices(ready).check(route.providerID, route.modelID, 'pi');
  const loading = transport(() => state('loading'));
  await expect(new HubModelServices(loading).check(route.providerID, route.modelID, 'pi')).rejects.toThrow('не готова');
  const other = transport(() => state('ready', { active_model: 'another' }));
  await expect(new HubModelServices(other).check(route.providerID, route.modelID, 'pi')).rejects.toThrow('не готова');
  for (const api of [ready, loading, other]) expect(paths(api)).toEqual(['catalog', 'inspect']);
});

it('an unreadable catalog fails closed: no inspect, no route, nothing cached', async () => {
  const api = transport(() => state('ready'), () => ({ schema: 2, routes: [route] }));
  const hub = new HubModelServices(api);
  await expect(hub.check(route.providerID, route.modelID, 'pi')).rejects.toThrow('неподдерживаемый каталог');
  expect(paths(api)).toEqual(['catalog']);
  expect(hub.route(route.providerID, route.modelID)).toBeUndefined();
  expect(localStorage.getItem('arvela.model-coordinator.v1')).toBeNull();
});

it('a temporary catalog outage is retried at most three times and never falls back to inspect or direct control', async () => {
  vi.useFakeTimers();
  const direct = vi.fn(); vi.stubGlobal('fetch', direct);
  const api = transport(() => state('ready'), () => { throw new HubRequestError('http', 503); });
  const hub = new HubModelServices(api);
  const check = hub.check(route.providerID, route.modelID, 'pi');
  const settled = expect(check).rejects.toThrow('после 3 попыток');
  await vi.advanceTimersByTimeAsync(5_000);
  await settled;
  expect(paths(api)).toEqual(['catalog', 'catalog', 'catalog']);
  expect(direct).not.toHaveBeenCalled();
});

it('cached pre-2.0 leases are ignored: loading the window never renews, releases or prepares', async () => {
  vi.useFakeTimers();
  localStorage.setItem('arvela.model-coordinator.v1', JSON.stringify({ scope: 'hub', routes: [route],
    leases: { s: { ticket: '12345678-1234-1234-1234-123456789012', expires: Date.now() + 60_000 } }, pending: { s: 'key' } }));
  const api = transport(() => state('ready'));
  const hub = new HubModelServices(api); hub.start();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(paths(api)).toEqual(['catalog']);
  expect(JSON.parse(localStorage.getItem('arvela.model-coordinator.v1')!)).toEqual({ scope: 'hub', routes: [route] });
  hub.dispose();
});

it('a send to a Hub-routed model takes no window lease and contacts neither the Hub nor the service', async () => {
  const direct = vi.fn(); vi.stubGlobal('fetch', direct);
  const api = transport(() => state('ready'));
  const hub = new HubModelServices(api), manager = new ModelServices();
  manager.attachHub(hub); await hub.refresh();
  await manager.ensureLocal(route.providerID, route.modelID, 'pi');
  await manager.ensure(route.providerID, route.modelID, 'pi');
  expect(paths(api)).toEqual(['catalog']);
  expect(direct).not.toHaveBeenCalled();
});
