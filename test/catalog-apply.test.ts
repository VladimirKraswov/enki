// Hub catalog Apply → the single Enki Runtime's models.json (CAS) + catalog
// refresh. No per-engine OpenCode/Pi writers; honest refusals with nothing
// written. Written for the LEGACY pass, NOT RUN.
import { expect, it, vi } from 'vitest';
import { applyCatalog, CatalogRefreshError, type RuntimeModelsPort } from '../src/hub/modelCatalog';
import { hubModelsState } from '../src/models/catalog';

const model = { id: 'common', label: 'Common', opencode: { providerId: 'common', provider: { models: { m: {} } } }, pi: { providerId: 'common', provider: { models: [{ id: 'm' }] } } };
const prefs = hubModelsState({ hubModels: { enabled: true, appliedOpencode: ['old'], appliedPi: ['old'] } });

function port(content: string, patch: Partial<{ state: 'none' | 'ready' | 'shadowed' | 'blocked'; readOnly: boolean; save: () => Promise<unknown>; errors: string[] }> = {}) {
  const client: RuntimeModelsPort & { [K in keyof RuntimeModelsPort]: ReturnType<typeof vi.fn> } = {
    configStatus: vi.fn(async () => ({ state: patch.state ?? 'none' })),
    modelsConfig: vi.fn(async () => ({ path: '/agent/models.json', content, readOnly: patch.readOnly ?? false })),
    saveModelsConfig: vi.fn(patch.save ?? (async () => ({}))),
    refreshProviders: vi.fn(async () => ({ errors: patch.errors ?? [] })),
  } as never;
  return client;
}

it('merges into the runtime models.json with CAS on the exact content read, then refreshes the runtime', async () => {
  const client = port('{"providers":{"local":{"models":[]}}}');
  const result = await applyCatalog({ version: 2, models: [model] }, prefs, { client, remote: false });
  expect(client.saveModelsConfig).toHaveBeenCalledWith('{"providers":{"local":{"models":[]}}}', expect.stringContaining('"common"'));
  expect(client.refreshProviders).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ appliedOpencode: [], appliedPi: ['common'], report: { opencodeChanged: false, piChanged: true } });
});

it('invalid models.json is refused before any write', async () => {
  const client = port('broken');
  await expect(applyCatalog({ version: 2, models: [model] }, prefs, { client, remote: false })).rejects.toThrow();
  expect(client.saveModelsConfig).not.toHaveBeenCalled();
});

it('a concurrent edit (CAS 409) reports failure; nothing is claimed applied', async () => {
  const client = port('{}', { save: async () => { throw new Error('Настройки моделей изменились на диске. Обновите и повторите.'); } });
  await expect(applyCatalog({ version: 2, models: [model] }, prefs, { client, remote: false })).rejects.toThrow(/изменились/);
  expect(client.refreshProviders).not.toHaveBeenCalled();
});

it('removes only previously managed providers for a published empty catalog', async () => {
  const client = port(JSON.stringify({ providers: { old: { models: [] }, local: { models: [] } } }));
  const result = await applyCatalog({ version: 3, models: [] }, prefs, { client, remote: false });
  expect(result.report.removed).toEqual(['old']);
  expect(Object.keys(JSON.parse(client.saveModelsConfig.mock.calls[0][1]).providers)).toEqual(['local']);
});

it('refuses an active imported generation and a remote runtime without writing anything', async () => {
  for (const state of ['ready', 'blocked'] as const) {
    const client = port('{}', { state });
    await expect(applyCatalog({ version: 2, models: [model] }, prefs, { client, remote: false })).rejects.toThrow(/Настройки моделей загружены из внешнего профиля/);
    expect(client.saveModelsConfig).not.toHaveBeenCalled();
  }
  const remote = port('{}');
  await expect(applyCatalog({ version: 2, models: [model] }, prefs, { client: remote, remote: true })).rejects.toThrow(/только к среде выполнения этого компьютера/);
  expect(remote.modelsConfig).not.toHaveBeenCalled();
});

it('surfaces runtime refresh errors instead of a false success', async () => {
  const client = port('{}', { errors: ['provider common: invalid baseUrl'] });
  await expect(applyCatalog({ version: 2, models: [model] }, prefs, { client, remote: false })).rejects.toThrow(/invalid baseUrl/);
});

// The file was committed before the refresh failed: ownership of what was
// written must survive, or a later catalog removal could never remove it.
it('a refresh failure after the CAS write still reports the providers Enki now owns', async () => {
  const reported = port('{}', { errors: ['provider common: invalid baseUrl'] });
  const unreachable = port('{}');
  unreachable.refreshProviders.mockRejectedValueOnce(new Error('Среда выполнения Enki недоступна.'));
  for (const client of [reported, unreachable]) {
    const failure = await applyCatalog({ version: 2, models: [model] }, prefs, { client, remote: false }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(CatalogRefreshError);
    expect((failure as CatalogRefreshError).appliedPi).toEqual(['common']);
    expect(client.saveModelsConfig).toHaveBeenCalledTimes(1);
  }
});
