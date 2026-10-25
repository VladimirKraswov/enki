// Installer recovery boundaries against the documented daemon-control contract.
// Lifecycle is the explicit in-memory port of remote-fixture.mjs; data paths,
// schema and paired snapshots are the actual production modules. Identity note:
// the daemon identity/log carries runtime-version `version` (16 hex, e.g.
// 1111111111111111); installRemote returns the manifest version (0.85.1-<hex>).
import test from 'node:test';
// REMOTE-RUNTIME.md: remote hosts are Linux x64 only. Windows supports the
// desktop artifact/Job path, but cannot atomically replace POSIX directory links.
const remoteUpdate = { skip: process.platform === 'win32' && 'Linux remote-host update/rollback uses POSIX directory symlink replacement' };
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MANIFEST, buildManifest, sha256File } from './artifact.mjs';
import { installRemote } from './install-remote.mjs';
import { hasJournal, journal, setup } from './remote-fixture.mjs';

const V1 = '1111111111111111', V2 = '2222222222222222';

test('control module is imported only from the publisher-owned verified copy', async t => {
  const s = setup(t), root = fs.mkdtempSync(path.join(s.root, 'probe-')), probe = path.join(root, 'c'); fs.mkdirSync(path.join(probe, 'node/bin'), { recursive: true }); fs.mkdirSync(path.join(probe, 'app/dist'), { recursive: true });
  for (const [name, text] of [['node/bin/node', 'x'], ['app/dist/main.js', 'x'], ['app/dist/daemon-control.js', "throw Error('IMPORTED_FROM:' + import.meta.url)"], ['app/package-lock.json', '{}'], ['app/runtime-lock.json', '{}'],
    ['app/runtime-version.json', JSON.stringify({ version: '3333333333333333', sdk: '0.85.1', node: '24.22.1', dataSchema: 2, contract: 1 })]]) fs.writeFileSync(path.join(probe, name), text);
  fs.writeFileSync(path.join(probe, MANIFEST), JSON.stringify(buildManifest(probe, { version: '0.85.1-3333333333333333', contract: 1, node: 'node/bin/node', entry: 'app/dist/main.js' })));
  const error = await installRemote({ ...s.base, candidate: probe, expectedManifestSha256: sha256File(path.join(probe, MANIFEST)) }).then(() => null, e => e);
  assert.match(error?.message ?? '', /IMPORTED_FROM:file:/);
  assert.ok(error.message.includes(`/dist/0.85.1-3333333333333333/app/dist/daemon-control.js`), error.message);
  assert.ok(!error.message.includes('/c/app/dist/'), 'never imported from the caller-supplied candidate path');
});

test('lost begin ACK is reconciled by GET of its exact id and never replayed', remoteUpdate, async t => {
  const s = setup(t);
  assert.deepEqual(await installRemote(s.v1), { version: `0.85.1-${V1}`, changed: true });
  s.daemon.loseBeginAck = true;
  await assert.rejects(installRemote(s.v2), /not fully confirmed/);
  const lost = journal(s); assert.equal(lost.phase, 'preparing'); assert.equal(lost.oldReceipt, null);
  assert.equal(s.daemon.running.version, V1, 'previous daemon untouched while uncertain');
  assert.deepEqual(await installRemote(s.v2), { version: `0.85.1-${V2}`, changed: true });
  const begins = s.daemon.log.filter(([kind]) => kind === 'begin').map(([, id]) => id);
  assert.equal(begins.filter(id => id === lost.id).length, 1, 'the lost begin POST is never replayed');
  assert.equal(begins.length, 2); assert.notEqual(begins[1], lost.id);
  assert.ok(s.daemon.log.some(([kind, value]) => kind === 'GET' && value === `/_enki/runtime/maintenance/${lost.id}`));
  assert.ok(s.daemon.log.some(([kind, value]) => kind === 'end' && value === lost.id), 'reconciled fence released');
  assert.equal(s.daemon.running.version, V2); assert.equal(s.daemon.held, null); assert.equal(hasJournal(s), false);
});

test('first-install crash after the fenced candidate created data is recoverable without deleting it', async t => {
  const s = setup(t); s.daemon.dieAfterData = true;
  await assert.rejects(installRemote(s.v1), /not fully confirmed/);
  assert.equal(journal(s).phase, 'candidate'); assert.equal(journal(s).freshData, true);
  assert.deepEqual(await installRemote(s.v1), { version: `0.85.1-${V1}`, changed: true });
  const preserved = fs.readdirSync(s.base.data).filter(name => name.startsWith('failed-first-install-'));
  assert.equal(preserved.length, 1); assert.ok(fs.existsSync(path.join(s.base.data, preserved[0], 'runtime.sqlite')), 'candidate data preserved, not erased');
  assert.equal(fs.existsSync(path.join(s.base.data, 'state.sqlite')), false, 'the backup filename is never a live database');
  assert.equal(s.daemon.held, null); assert.equal(hasJournal(s), false);
});

test('committed runtime that died before its fence was released is started and released', remoteUpdate, async t => {
  const s = setup(t); await installRemote(s.v1); s.daemon.failEnd = true;
  await assert.rejects(installRemote(s.v2), /not fully confirmed/);
  assert.equal(journal(s).phase, 'committed'); assert.equal(s.daemon.running, null);
  assert.deepEqual(await installRemote(s.v2), { version: `0.85.1-${V2}`, changed: false });
  assert.equal(s.daemon.running.version, V2); assert.equal(s.daemon.held, null, 'startup fence released');
  assert.equal(s.daemon.log.filter(([kind, v]) => kind === 'launch' && v === V2).length, 2);
});

test('paired backup receipts are compared exactly by typed fields, not by serialization order', remoteUpdate, async t => {
  const s = setup(t); await installRemote(s.v1);
  s.daemon.receiptOnDisk = backup => Object.fromEntries(Object.entries(backup).reverse());
  assert.equal((await installRemote(s.v2)).changed, true, 'reordered keys are the same receipt');
  const s2 = setup(t); await installRemote(s2.v1);
  s2.daemon.receiptOnDisk = backup => ({ ...backup, extra: true });
  await assert.rejects(installRemote(s2.v2), /match exactly/);
  await assert.rejects(installRemote(s2.v2), /match exactly/, 'reconciliation never accepts a non-exact receipt');
  assert.equal(s2.daemon.running.version, V1);
});
