// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
const { fetchCatalog } = vi.hoisted(() => ({ fetchCatalog: vi.fn() }));
vi.mock('../src/hub/modelCatalog', () => ({ fetchCatalog, applyCatalog: vi.fn(), publishCatalog: vi.fn() }));
vi.mock('../src/state/store', () => ({
    useAppState: () => ({ prefs: { hubModels: { enabled: true, excluded: [], appliedVersion: 0, appliedOpencode: [], appliedPi: [] } } }),
    store: { state: { activityStatuses: {}, statuses: {} }, setHubModels: vi.fn() }
}));
import { ModelCatalogSettings, newCatalogModel, PI_REQUIRED } from '../src/components/ModelCatalogSettings';

// Final seam review: in the sole-runtime UI the Pi entry is the normal (and
// required) template; the OpenCode block is optional 0.2.x compatibility.
it('a Pi-only model is accepted, an OpenCode-only one is refused, and "Добавить модель" creates a Pi-only entry', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    fetchCatalog.mockResolvedValueOnce({ version: 3, models: [
        { id: 'pi-only', label: 'Pi only', pi: { providerId: 'local', provider: { baseUrl: 'http://127.0.0.1:8000/v1', api: 'openai-completions', models: [] } } },
        { id: 'legacy-only', label: 'Legacy only', opencode: { providerId: 'old', provider: { models: {} } } },
    ] });
    const buttons = (text: string) => [...host.querySelectorAll('button')].filter(b => b.textContent === text);
    try {
        await act(async () => root.render(createElement(ModelCatalogSettings)));
        expect(host.textContent).toContain('Провайдер: local');
        expect(host.textContent).toContain('Подключение модели не настроено');
        // Pi only: saved without any OpenCode block.
        await act(async () => buttons('Изменить')[0].click());
        expect(host.querySelector('#catalog-0-opencodeId')).toBeNull();
        await act(async () => buttons('Совместимость с внешними клиентами')[0].click());
        expect(host.querySelector('#catalog-0-opencodeId')).not.toBeNull();
        await act(async () => buttons('Совместимость с внешними клиентами')[0].click());
        expect(host.querySelector('#catalog-0-opencodeId')).toBeNull();
        await act(async () => buttons('Сохранить в черновике')[0].click());
        expect(host.querySelector('[role=alert]')).toBeNull();
        expect(host.textContent).toContain('Совпадает с опубликованной версией');
        // OpenCode only: not effective on 2.0, so it is refused with the reason.
        await act(async () => buttons('Изменить')[1].click());
        await act(async () => buttons('Сохранить в черновике')[0].click());
        expect(host.querySelector('[role=alert]')?.textContent).toBe(PI_REQUIRED);
        // The template is Pi only.
        expect(newCatalogModel(3)).toEqual({ id: 'model-3', label: 'Новая модель', pi: { providerId: 'local-model-3', provider: { baseUrl: 'http://127.0.0.1:8000/v1', api: 'openai-completions', apiKey: 'local', models: [] } } });
        await act(async () => buttons('Добавить модель')[0].click());
        expect(host.textContent).toContain('Провайдер: local-model-3');
        expect(host.textContent).not.toContain('совместимость 0.2.x (OpenCode): local-model-3');
    }
    finally {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
    }
});
it('refreshing a catalog version replaces stale editor values as well as its summary', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const catalog = (version: number, label: string) => ({ version, models: [{ id: 'same-id', label, opencode: { providerId: 'local', provider: { models: { m: {} } } } }] });
    fetchCatalog.mockResolvedValueOnce(catalog(1, 'Old')).mockResolvedValueOnce(catalog(2, 'New'));
    const click = async (text: string) => { const button = [...host.querySelectorAll('button')].find(b => b.textContent === text); expect(button).toBeTruthy(); await act(async () => button!.click()); };
    try {
        await act(async () => root.render(createElement(ModelCatalogSettings)));
        await click('Изменить');
        expect((host.querySelector('#catalog-0-label') as HTMLInputElement).value).toBe('Old');
        await click('Обновить с Hub');
        await click('Изменить');
        expect((host.querySelector('#catalog-0-label') as HTMLInputElement).value).toBe('New');
    }
    finally {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
    }
});
