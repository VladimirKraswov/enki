import { expect, it } from 'vitest';
import { chooseModel } from '../src/state/modelChoice';
import type { AppState } from '../src/state/types';

function state(choices: Record<string, unknown> = {}) {
  return { directory: '/p', activeSessionId: 'a', providers: [], connectedProviderIds: [],
    providerDefaults: null, prefs: { modelChoice: choices } } as unknown as AppState;
}
const selected = { providerID: 'local-qwen', modelID: 'qwen', variant: 'medium' };
const context = { projectless: false, defaultVariant: () => null };

it('keeps the explicit session identity through empty discovery, then recovers without switching', () => {
  const s = state({ 'session:a': selected });
  expect(chooseModel(s, context)).toEqual(selected);
  s.connectedProviderIds = ['cloud'];
  s.providerDefaults = { cloud: 'other' };
  expect(chooseModel(s, context)).toEqual(selected);
});
it('keeps the durable runtime model even when the vault/discovery is temporarily unavailable', () => {
  expect(chooseModel(state(), { ...context, activeModel: { providerID: 'local-qwen', id: 'qwen', variant: 'medium' } })).toEqual(selected);
});
it('does not erase the chosen identity on an explicit auth denial or invent a different model', () => {
  const s = state({ 'session:a': selected });
  s.providers = [{ id: 'local-qwen', models: { qwen: { id: 'qwen', access: { state: 'unavailable' } } } }] as AppState['providers'];
  expect(chooseModel(s, context)).toEqual(selected);
  expect(chooseModel(state(), context)).toBeNull();
});
