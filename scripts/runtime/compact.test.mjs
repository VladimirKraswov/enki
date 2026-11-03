import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { compactDependencies } from './compact.mjs';

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'enki-compact-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'node_modules'));
  return root;
}
function pkg(root, name, metadata = {}, source = 'module.exports = 42;') {
  const directory = path.join(root, 'node_modules', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: name.split('/node_modules/').at(-1), version: '1.0.0', main: 'index.cjs', ...metadata }));
  fs.writeFileSync(path.join(directory, 'index.cjs'), source);
  return directory;
}
for (const platform of ['darwin-arm64', 'win32-x64', 'linux-x64']) test(`only ${platform} esbuild survives at every npm depth`, t => {
  const root = fixture(t), host = pkg(root, '@example/sdk'), chord = pkg(root, '@example/chord');
  for (const base of [root, host, chord]) for (const target of ['darwin-arm64', 'win32-x64', 'linux-x64']) {
    const [os, cpu] = target.split('-'); pkg(base, '@esbuild/' + target, { os: [os], cpu: [cpu] }, 'native fixture ' + target);
  }
  const result = compactDependencies(root, platform);
  assert.equal(result.removed.filter(r => r.reason === 'foreign-platform').length, 6);
  assert.ok(result.savedBytes > 0);
  for (const base of [root, host, chord]) for (const target of ['darwin-arm64', 'win32-x64', 'linux-x64']) {
    const exists = fs.existsSync(path.join(base, 'node_modules/@esbuild', target));
    if (target !== platform) assert.equal(exists, false);
  }
  assert.ok(fs.existsSync(path.join(root, 'node_modules/@esbuild', platform)));
  assert.equal(compactDependencies(root, platform).savedBytes, 0, 'idempotent');
});
test('byte-identical nested libraries resolve through the owned parent after deduplication', t => {
  const root = fixture(t), sdk = pkg(root, 'sdk');
  const source = "module.exports = require('leaf') + 1;";
  pkg(root, 'leaf'); pkg(root, 'lib', { dependencies: { leaf: '1.0.0' } }, source);
  pkg(sdk, 'leaf'); pkg(sdk, 'lib', { dependencies: { leaf: '1.0.0' } }, source);
  const require = createRequire(path.join(sdk, 'probe.cjs'));
  assert.equal(require('lib'), 43);
  const result = compactDependencies(root, 'darwin-arm64');
  assert.equal(result.removed.filter(r => r.reason === 'identical-dependency').length, 2);
  assert.equal(fs.existsSync(path.join(sdk, 'node_modules/lib')), false);
  // Preparation exits before activation: verify in a fresh process, without
  // Node's old resolution cache retaining the intentionally removed path.
  const output = execFileSync(process.execPath, ['-e', "console.log(require.resolve('lib'));console.log(require('lib'));"], { cwd: sdk, encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.deepEqual(output, [path.join(root, 'node_modules/lib/index.cjs'), '43']);
});
test('matching versions alone cannot remove different bytes, peers or dependency versions', t => {
  const root = fixture(t), sdk = pkg(root, 'sdk');
  pkg(root, 'changed'); const changed = pkg(sdk, 'changed', {}, 'module.exports = 7;');
  pkg(root, 'peer'); pkg(sdk, 'peer', { version: '2.0.0' });
  pkg(root, 'lib', { peerDependencies: { peer: '*' } }); const peer = pkg(sdk, 'lib', { peerDependencies: { peer: '*' } });
  pkg(root, 'parent', { dependencies: { changed: '*' } }); const parent = pkg(sdk, 'parent', { dependencies: { changed: '*' } });
  compactDependencies(root, 'linux-x64');
  for (const directory of [changed, peer, parent]) assert.ok(fs.existsSync(directory));
});
test('CLIs and native addons keep original package/helper paths', t => {
  const root = fixture(t), sdk = pkg(root, 'sdk');
  for (const base of [root, sdk]) {
    pkg(base, 'cli', { bin: { cli: 'index.cjs' } }); const native = pkg(base, 'native');
    fs.writeFileSync(path.join(native, 'addon.node'), 'ABI fixture');
  }
  assert.equal(compactDependencies(root, 'win32-x64').removed.length, 0);
});
test('escaping package links refuse all cleanup before touching foreign packages', t => {
  const root = fixture(t), outside = fixture(t);
  const foreign = pkg(root, '@esbuild/linux-x64', { os: ['linux'], cpu: ['x64'] });
  fs.symlinkSync(outside, path.join(root, 'node_modules/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => compactDependencies(root, 'darwin-arm64'), /package links/);
  assert.ok(fs.existsSync(foreign));
});
test('unknown target and malformed platform metadata fail before deletion', t => {
  const root = fixture(t), foreign = pkg(root, '@esbuild/linux-x64', { os: ['linux'], cpu: ['x64'] });
  assert.throws(() => compactDependencies(root, 'darwin-x64'), /platform/);
  pkg(root, '@esbuild/broken', { os: 'linux' });
  assert.throws(() => compactDependencies(root, 'darwin-arm64'), /selector/);
  assert.ok(fs.existsSync(foreign));
});

test('development metadata is byte-preserved in one archive while executable code and assets stay unchanged', async t => {
  const { packDevelopmentMetadata } = await import('./compact.mjs');
  const { gunzipSync } = await import('node:zlib');
  const root = fixture(t), directory = pkg(root, 'library');
  const metadata = ['index.d.ts', 'index.d.mts', 'index.d.cts', 'index.js.map', 'index.d.ts.map'];
  const runtime = ['index.ts', 'index.mts', 'index.cts', 'data.json', 'LICENSE', 'addon.node'];
  for (const name of [...metadata, ...runtime]) fs.writeFileSync(path.join(directory, name), Buffer.from([0, 255, 10, 42]));
  fs.mkdirSync(path.join(root, 'dist')); fs.writeFileSync(path.join(root, 'dist/main.js.map'), 'Enki stack map');
  const result = await packDevelopmentMetadata(root);
  assert.equal(result.packedFiles, metadata.length);
  const archive = JSON.parse(gunzipSync(fs.readFileSync(path.join(root, 'development-metadata.json.gz'))));
  for (const name of metadata) {
    assert.equal(fs.existsSync(path.join(directory, name)), false);
    assert.deepEqual(Buffer.from(archive.files['node_modules/library/' + name], 'base64'), Buffer.from([0, 255, 10, 42]));
  }
  for (const name of runtime) assert.deepEqual(fs.readFileSync(path.join(directory, name)), Buffer.from([0, 255, 10, 42]));
  assert.equal(fs.readFileSync(path.join(root, 'dist/main.js.map'), 'utf8'), 'Enki stack map');
  assert.equal(execFileSync(process.execPath, ['-e', "console.log(require('library'))"], { cwd: root, encoding: 'utf8' }).trim(), '42');
  await assert.rejects(packDevelopmentMetadata(root), /already exists/);
});

test('metadata packaging rejects a linked tree before removing any declaration', async t => {
  const { packDevelopmentMetadata } = await import('./compact.mjs');
  const root = fixture(t), outside = fixture(t), directory = pkg(root, 'library');
  const declaration = path.join(directory, 'index.d.ts'); fs.writeFileSync(declaration, 'type A = string');
  fs.symlinkSync(outside, path.join(root, 'node_modules/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(packDevelopmentMetadata(root), /package links/);
  assert.ok(fs.existsSync(declaration));
  assert.equal(fs.existsSync(path.join(root, 'development-metadata.json.gz')), false);
});
