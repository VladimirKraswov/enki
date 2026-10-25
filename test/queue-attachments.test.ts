// Queued attachments with the runtime-owned queue. The window prepares draft
// files exactly as for a direct send and hands them to the runtime, which keeps
// the bytes (store/attachments.ts). Runtime-side invariants — files sent once
// with their item, a missing stored file pauses before anything is sent, the
// item survives a restart, uncertain delivery is never replayed — are tested in
// src-tauri/resources/agent/test/queue-unit.test.ts and integration/queue.test.ts.
import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import type { QueueItemDTO, QueueStateDTO } from '../src-tauri/resources/agent/src/protocol';
import type { RuntimeFixture } from './helpers/runtime-fixture';

let store: any, drafts: typeof import('../src/attachments/drafts').attachmentDrafts, scope: string, fx: RuntimeFixture;
let queue: QueueStateDTO, Reply: typeof import('./helpers/runtime-fixture').RuntimeReply;
const FILE_PART = { type: 'file', filename: 'fixture.txt', mime: 'text/plain', url: 'data:text/plain;base64,aGVsbG8=' };
const posts = () => fx.made('POST', '/sessions/:id/queue').map(c => c.body as { id: string; text: string; parts: unknown[]; model: { modelID: string } });
const patches = () => fx.made('PATCH', '/sessions/:id/queue/:item').map(c => [c.params.item, c.body]);
beforeEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
  const fixture = await import('./helpers/runtime-fixture');
  Reply = fixture.RuntimeReply;
  store = (await import('../src/state/store')).store;
  const mod = await import('../src/attachments/drafts'); drafts = mod.attachmentDrafts;
  fx = fixture.runtimeFixture();
  fixture.withProvider(fx, 'p', ['m', 'other']);
  queue = { sessionID: 'ses_a', armed: true, pausedReason: null, items: [] };
  const directory = '/test-' + crypto.randomUUID();
  fx.on('GET', '/sessions', () => [{ id: 'ses_a', directory, title: 'a', projectID: 'p', time: { created: 1, updated: 1 } }]);
  fx.on('GET', '/sessions/status', () => ({ ses_a: { type: 'busy' } }));
  fx.on('GET', '/sessions/:id/queue', () => queue);
  fx.on('POST', '/sessions/:id/queue', c => {
    const body = c.body as { id: string; text: string; parts: Array<{ filename?: string; mime?: string }>; model: QueueItemDTO['model'] };
    const files = body.parts.filter(p => p.filename).map((p, i) => ({ id: `${body.id}-f${i}`, name: p.filename!, mime: p.mime!, size: 5 }));
    queue = { ...queue, items: [...queue.items, { id: body.id, sessionID: 'ses_a', directory, text: body.text, model: body.model, state: 'ready', queuedAt: 1, commandId: null, ...(files.length ? { attachments: files } : {}) }] };
    return queue;
  });
  fx.on('PATCH', '/sessions/:id/queue/:item', c => {
    const patch = c.body as { text?: string; removeAttachments?: string[] };
    queue = { ...queue, items: queue.items.map(i => i.id !== c.params.item ? i : { ...i, ...(patch.text ? { text: patch.text } : {}),
      attachments: (i.attachments ?? []).filter(f => !(patch.removeAttachments ?? []).includes(f.id)) }) };
    return queue;
  });
  fx.on('POST', '/sessions/:id/queue/:item/steer', c => ({ id: `queue-${c.params.item}-1`, kind: 'steer', sessionID: 'ses_a', state: 'accepted', createdAt: 1, updatedAt: 1 }));
  fx.on('POST', '/sessions/:id/stop', () => ({ stopped: true }));
  fixture.bindStore(store, fx);
  await store.setDirectory(directory, { sessionId: 'ses_a' });
  store.setModelChoice('p', 'm', 'medium');
  scope = mod.attachmentScope(store.state.prefs.workspaceKey, store.state.directory, 'ses_a');
  await drafts.add(scope, [new File(['hello'], 'fixture.txt', { type: 'text/plain' })]);
});

it('hands prepared files to the runtime with their item, keeps no copy in the window and leaves later draft files alone', async () => {
  store.setDraft('first');
  expect(await store.enqueueWithAttachments('first', drafts.snapshot(scope))).toBe(true);
  expect(posts()).toEqual([expect.objectContaining({ text: 'first', parts: [FILE_PART], model: { providerID: 'p', modelID: 'm', variant: 'medium' } })]);
  expect(drafts.snapshot(scope)).toHaveLength(0);
  expect(store.getDraft()).toBe('');
  expect(JSON.stringify(store.state.prefs)).not.toMatch(/aGVsbG8=|hello/);
  expect(store.getQueue()[0].attachments.files.map((f: { name: string }) => f.name)).toEqual(['fixture.txt']);
  await drafts.add(scope, [new File(['next'], 'later.txt', { type: 'text/plain' })]);
  expect(drafts.snapshot(scope).map(f => f.name)).toEqual(['later.txt']);
  expect(fx.made('POST', '/commands')).toEqual([]);
});

it('file-only entries and multiple batches keep their own files and captured model', async () => {
  expect(await store.enqueueWithAttachments('', drafts.snapshot(scope))).toBe(true);
  store.setModelChoice('p', 'other');
  await drafts.add(scope, [new File(['second'], 'second.txt', { type: 'text/plain' })]);
  expect(await store.enqueueWithAttachments('second', drafts.snapshot(scope))).toBe(true);
  expect(posts().map(p => [p.text, (p.parts as Array<{ filename: string }>).map(f => f.filename), p.model.modelID]))
    .toEqual([['Проанализируй приложенные файлы.', ['fixture.txt'], 'm'], ['second', ['second.txt'], 'other']]);
});

it('does not queue a removed file from a stale composer snapshot', async () => {
  const stale = drafts.snapshot(scope);
  await drafts.remove(scope, stale.map(file => file.id));
  expect(await store.enqueueWithAttachments('text only', stale)).toBe(true);
  expect(posts()[0].parts).toEqual([]);
  expect(store.getQueue()[0].attachments).toBeUndefined();
});

it('a runtime refusal keeps the original text and files in the draft and queues nothing', async () => {
  fx.on('POST', '/sessions/:id/queue', () => { throw new Reply(507, { message: 'Недостаточно места для вложений очереди.' }); });
  store.setDraft('keep');
  expect(await store.enqueueWithAttachments('keep', drafts.snapshot(scope))).toBe(false);
  expect(store.getDraft()).toBe('keep');
  expect(drafts.snapshot(scope)).toHaveLength(1);
  expect(store.getQueue()).toHaveLength(0);
  expect(store.state.ui.sendError).toContain('Недостаточно места');
});

it('Stop during attachment preparation never queues the late item', async () => {
  let release!: (files: unknown) => void;
  const selected = drafts.selected.bind(drafts);
  vi.spyOn(drafts, 'selected').mockImplementationOnce((...args: Parameters<typeof selected>) => new Promise(resolve => { release = () => resolve(selected(...args)); }));
  const operation = store.enqueueWithAttachments('do not queue', drafts.snapshot(scope));
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await store.stopSession('ses_a');
  release(undefined);
  expect(await operation).toBe(false);
  expect(posts()).toEqual([]);
  expect(drafts.snapshot(scope)).toHaveLength(1);
});

it('removing a queued attachment asks the runtime to drop only that file of that item', async () => {
  await store.enqueueWithAttachments('correction', drafts.snapshot(scope));
  const queued = store.getQueue()[0], file = queued.attachments.files[0];
  await store.removeQueuedAttachment(queued.id, file.id);
  expect(patches()).toEqual([[queued.id, { removeAttachments: [file.id] }]]);
  expect(store.getQueue()[0].attachments).toBeUndefined();
  await store.removeQueuedAttachment(queued.id, 'unknown-file');
  expect(patches()).toHaveLength(1);
});

it('editing restores the text, holds the original entry and position, and Apply edits that same item without rebinding its model', async () => {
  await store.enqueueWithAttachments('first', drafts.snapshot(scope));
  await store.enqueuePrompt('second');
  const [first, second] = store.getQueue();
  expect(await store.editQueued(first.id)).toBe(true);
  expect(store.getDraft()).toBe('first');
  expect(store.editKeptFiles().map((f: { name: string }) => f.name)).toEqual(['fixture.txt']);
  expect(store.reorderQueued(second.id, first.id)).toBe(false);
  await store.removeQueued(first.id);
  expect(fx.made('DELETE', '/sessions/:id/queue/:item')).toEqual([]);
  store.setModelChoice('p', 'other');
  await store.removeQueuedAttachment(first.id, store.editKeptFiles()[0].id);
  expect(patches()).toEqual([]);
  expect(await store.applyQueueEdit('updated first', [])).toBe(true);
  expect(patches()).toEqual([[first.id, { text: 'updated first', removeAttachments: [first.attachments.files[0].id] }]]);
  expect(store.getQueue().map((q: { id: string }) => q.id)).toEqual([first.id, second.id]);
  expect(store.getQueue()[0].model.modelID).toBe('m');
  expect(store.getQueueEdit()).toBeUndefined();
});

it('does not start editing over an existing attachment-only draft, and Cancel leaves the original entry untouched', async () => {
  await store.enqueueWithAttachments('kept', drafts.snapshot(scope));
  const queued = store.getQueue()[0];
  await drafts.add(scope, [new File(['mine'], 'mine.txt', { type: 'text/plain' })]);
  expect(await store.editQueued(queued.id)).toBe(false);
  expect(drafts.snapshot(scope).map(f => f.name)).toEqual(['mine.txt']);
  await drafts.remove(scope, drafts.snapshot(scope).map(f => f.id));
  expect(await store.editQueued(queued.id)).toBe(true);
  await store.cancelQueueEdit();
  expect(store.getQueueEdit()).toBeUndefined();
  expect(store.getDraft()).toBe('');
  expect(patches()).toEqual([]);
  expect(store.getQueue()[0]).toMatchObject({ id: queued.id, text: 'kept' });
});

it('an Apply refusal keeps the original queue entry and the edited draft recoverable', async () => {
  await store.enqueueWithAttachments('keep queue', drafts.snapshot(scope));
  const queued = store.getQueue()[0];
  await store.editQueued(queued.id); store.setDraft('changed text');
  fx.on('PATCH', '/sessions/:id/queue/:item', () => { throw new Reply(409, { message: 'Этот запрос уже отправляется.' }); });
  expect(await store.applyQueueEdit('changed text', [])).toBe(false);
  expect(store.getQueue()[0]).toMatchObject({ id: queued.id, text: 'keep queue' });
  expect(store.getDraft()).toBe('changed text');
  expect(store.getQueueEdit().id).toBe(queued.id);
  expect(store.state.ui.sendError).toContain('уже отправляется');
});

it('steering an edited entry applies the edit first, then steers that item once', async () => {
  await store.enqueueWithAttachments('old text', drafts.snapshot(scope));
  const queued = store.getQueue()[0];
  await store.editQueued(queued.id); store.setDraft('new text');
  await store.steerQueued(queued.id);
  expect(patches()).toEqual([[queued.id, { text: 'new text' }]]);
  expect(fx.made('POST', '/sessions/:id/queue/:item/steer').map(c => c.params.item)).toEqual([queued.id]);
  expect(fx.calls.findIndex(c => c.method === 'PATCH')).toBeLessThan(fx.calls.findIndex(c => c.path.endsWith('/steer')));
  expect(store.getQueueEdit()).toBeUndefined();
  expect(fx.made('POST', '/sessions/:id/stop')).toEqual([]);
});

it('a late preparation failure cannot appear in another chat', async () => {
  let reject!: (e: Error) => void;
  vi.spyOn(drafts, 'selected').mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
  const operation = store.enqueueWithAttachments('first', drafts.snapshot(scope));
  await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
  store.state = { ...store.state, activeSessionId: 'ses_b' };
  reject(new Error('old attachment error'));
  expect(await operation).toBe(false);
  expect(store.state.ui.sendError).toBeNull();
  expect(drafts.snapshot(scope)).toHaveLength(1);
});
