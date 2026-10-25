import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { buildEnvironment, download, materializeBinLinks, normalizePtyHelpers, posixWrapper, pruneEmptyPackageDirectories, run, runtimeNodeEntitlements, verifyPackagedNodePty, windowsWrapper } from './prepare.mjs';
import { buildManifest, MANIFEST, verifyArtifact } from './artifact.mjs';
const temporary = t => { const root = fs.realpathSync.native(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'prepare-case-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

test('build environment selects pinned Node first and cannot inherit npm credentials or owner configs', t => {
  const work = temporary(t), node = path.join(work, 'node');
  const env = buildEnvironment(node, work, 'darwin', { PATH: '/malicious/node', HOME: '/owner', NODE_OPTIONS: '--require /owner/hook',
    npm_config_registry: 'https://untrusted/', NPM_TOKEN: 'secret', GOOGLE_APPLICATION_CREDENTIALS: '/owner/adc', LANG: 'C' });
  assert.equal(env.PATH.split(path.delimiter)[0], path.join(node, 'bin'));
  assert.equal(env.HOME, '/owner', 'HOME must never be repurposed'); assert.notEqual(env.npm_config_userconfig, env.npm_config_globalconfig);
  for (const key of ['NODE_OPTIONS', 'NPM_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS']) assert.equal(env[key], undefined);
  for (const key of ['npm_config_userconfig', 'npm_config_globalconfig']) assert.equal(fs.readFileSync(env[key], 'utf8'), '');
  assert.equal(env.npm_config_nodedir, node);
});
test('bounded authenticated streaming download never publishes wrong or oversized bytes', async t => {
  const root = temporary(t), file = path.join(root, 'artifact.tar'), data = Buffer.from('verified fixture');
  const response = chunks => async () => new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }));
  await assert.rejects(download('https://primary.invalid/archive', file, hash(data), { fetcher: response([Buffer.from('wrong')]) }), /Checksum/);
  assert.equal(fs.existsSync(file), false); assert.deepEqual(fs.readdirSync(root), []);
  await assert.rejects(download('https://primary.invalid/archive', file, hash(data), { maxBytes: 3, fetcher: response([data]) }), /byte limit/);
  assert.equal(fs.existsSync(file), false); assert.deepEqual(fs.readdirSync(root), []);
  await download('https://primary.invalid/archive', file, hash(data), { fetcher: response([data.subarray(0, 3), data.subarray(3)]) });
  assert.deepEqual(fs.readFileSync(file), data);
  await download('https://primary.invalid/archive', file, hash(data), { fetcher: () => { throw new Error('Verified cache must not fetch'); } });
});
test('cancelled download leaves no partial and does not replace a previously verified artifact', async t => {
  const root = temporary(t), file = path.join(root, 'archive'), controller = new AbortController(); fs.writeFileSync(file, 'old'); controller.abort(new Error('OWNED_CANCEL'));
  await assert.rejects(download('https://primary.invalid/a', file, hash('new'), { signal: controller.signal, fetcher: () => { throw new Error('must not fetch'); } }), /OWNED_CANCEL/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old'); assert.deepEqual(fs.readdirSync(root), ['archive']);
});
test('npm-pruned empty scopes are removed before strict manifest verification without changing runtime files', t => {
  const root = temporary(t), artifact = path.join(root, 'artifact'), modules = path.join(artifact, 'app/node_modules');
  const contents = {
    'node/bin/node': Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    'app/dist/main.js': Buffer.from('export const runtime = true;\n'),
    'app/node_modules/.package-lock.json': Buffer.from('{}'),
    'app/node_modules/.bin/sdk': Buffer.from('#!/bin/sh\nexit 0\n'),
    'app/node_modules/@earendil-works/pi-coding-agent/LICENSE': Buffer.from('SDK license fixture'),
    'app/node_modules/@earendil-works/pi-coding-agent/assets/help.txt': Buffer.from('SDK asset fixture'),
    'app/node_modules/node-pty/LICENSE': Buffer.from('PTY license fixture'),
  };
  for (const [relative, data] of Object.entries(contents)) {
    const file = path.join(artifact, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data);
  }
  const scopes = ['@esbuild', '@jridgewell', '@oxc-project', '@rolldown', '@standard-schema'];
  for (const scope of scopes) fs.mkdirSync(path.join(modules, scope));
  fs.mkdirSync(path.join(modules, '@empty/package/dist/nested'), { recursive: true });
  const unrelated = path.join(root, 'untouched-empty'); fs.mkdirSync(unrelated);
  const fileMetadata = Object.fromEntries(Object.keys(contents).map(relative => [relative, fs.statSync(path.join(artifact, relative))]));
  const manifest = buildManifest(artifact, { version: '0.85.1-0123', contract: 1, node: 'node/bin/node', entry: 'app/dist/main.js' });
  fs.writeFileSync(path.join(artifact, MANIFEST), JSON.stringify(manifest));
  const before = verifyArtifact(artifact);
  for (const scope of scopes) assert.ok(before.includes(`unlisted empty directory app/node_modules/${scope}`), scope);
  const removed = pruneEmptyPackageDirectories(artifact);
  for (const scope of scopes) assert.ok(removed.includes(`app/node_modules/${scope}`), scope);
  assert.equal(fs.existsSync(path.join(modules, '@empty')), false, 'empty parents disappear after their children');
  assert.ok(fs.statSync(unrelated).isDirectory(), 'only artifact/app/node_modules is normalized');
  assert.ok(fs.statSync(modules).isDirectory(), 'the staging node_modules root remains');
  for (const [relative, data] of Object.entries(contents)) {
    const file = path.join(artifact, relative), after = fs.statSync(file);
    assert.deepEqual(fs.readFileSync(file), data, relative);
    assert.equal(after.mode, fileMetadata[relative].mode, relative);
    assert.equal(after.mtimeMs, fileMetadata[relative].mtimeMs, relative);
  }
  assert.deepEqual(buildManifest(artifact, manifest), manifest, 'manifest-covered bytes are identical');
  assert.deepEqual(verifyArtifact(artifact), [], 'strict inventory now passes without any verifier exception');
  assert.deepEqual(pruneEmptyPackageDirectories(artifact), [], 'normalization is idempotent');
});
for (const dangling of [false, true]) test(`empty-package cleanup refuses ${dangling ? 'dangling' : 'escaping'} links before removing anything`, t => {
  const root = temporary(t), artifact = path.join(root, 'artifact'), modules = path.join(artifact, 'app/node_modules');
  const empty = path.join(modules, '@esbuild'), outside = path.join(root, 'outside'), sentinel = path.join(outside, 'LICENSE');
  fs.mkdirSync(empty, { recursive: true }); fs.mkdirSync(path.join(outside, 'empty'), { recursive: true }); fs.writeFileSync(sentinel, 'OUTSIDE_UNCHANGED');
  fs.symlinkSync(dangling ? path.join(root, 'missing') : outside, path.join(modules, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => pruneEmptyPackageDirectories(artifact), /symbolic links/);
  assert.ok(fs.statSync(empty).isDirectory(), 'validation failure must not partially remove valid empty directories');
  assert.ok(fs.lstatSync(path.join(modules, 'escape')).isSymbolicLink());
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'OUTSIDE_UNCHANGED');
  assert.ok(fs.statSync(path.join(outside, 'empty')).isDirectory());
});
test('empty-package cleanup refuses a linked staging ancestor without traversing or deleting outside', t => {
  const root = temporary(t), artifact = path.join(root, 'artifact'), outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(outside, 'node_modules/empty'), { recursive: true }); fs.mkdirSync(artifact);
  fs.symlinkSync(outside, path.join(artifact, 'app'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => pruneEmptyPackageDirectories(artifact), /physical directories/);
  assert.ok(fs.statSync(path.join(outside, 'node_modules/empty')).isDirectory());
});
test('empty-package cleanup bounds entry/depth work before any removal', t => {
  const root = temporary(t), artifact = path.join(root, 'artifact'), modules = path.join(artifact, 'app/node_modules');
  fs.mkdirSync(path.join(modules, 'empty/child/deep'), { recursive: true });
  assert.throws(() => pruneEmptyPackageDirectories(artifact, { maxEntries: 1 }), /entry limit/);
  assert.ok(fs.statSync(path.join(modules, 'empty/child/deep')).isDirectory());
  assert.throws(() => pruneEmptyPackageDirectories(artifact, { maxDepth: 1 }), /depth limit/);
  assert.ok(fs.statSync(path.join(modules, 'empty/child/deep')).isDirectory());
  assert.throws(() => pruneEmptyPackageDirectories(artifact, { maxEntries: 0 }), /bounds/);
});
// Windows jobs run only through the exact bootstrapped runner. CI passes the
// receipt of `node scripts/runtime/build-runner.mjs --out <dir>`; without it the
// Windows job cases skip with this explicit reason rather than failing forever.
const runner = process.env.ENKI_TEST_NATIVE_RUNNER ? { path: process.env.ENKI_TEST_NATIVE_RUNNER, sha256: process.env.ENKI_TEST_NATIVE_RUNNER_SHA256 } : undefined;
const needsRunner = process.platform === 'win32' && !runner && 'Windows build jobs need ENKI_TEST_NATIVE_RUNNER(+_SHA256) from the bootstrap receipt';
// Fixture readiness, not a product deadline: the FIRST exec of a freshly copied
// ~100 MB Node (page-in; on macOS code-signature assessment of a new file) is a
// platform cold start that took ~5 s under concurrent copy I/O. It is paid once
// here under its own readiness bound and checked to really run, so the 5 s
// wrapper budgets below measure only the relocated wrapper path they assert.
async function bundledNode(artifact) {
  const node = path.join(artifact, 'node/bin/node');
  fs.copyFileSync(process.execPath, node); fs.chmodSync(node, 0o755);
  const ready = await run(node, ['-e', "process.stdout.write('NODE_READY')"], { env: { PATH: '/usr/bin:/bin' }, capture: true, timeoutMs: 60_000 });
  assert.equal(ready.trim(), 'NODE_READY');
}
test('only the exact ad-hoc identity selects the Node library-validation exception', () => {
  const repo = path.resolve('owned-signing-fixture');
  assert.equal(runtimeNodeEntitlements(repo, '-'), path.join(repo, 'src-tauri/runtime-node-adhoc.entitlements'));
  for (const identity of ['Developer ID Application: Example (TEAM123)', 'Apple Development: Example', ' - '])
    assert.equal(runtimeNodeEntitlements(repo, identity), path.join(repo, 'src-tauri/runtime-node.entitlements'));
});
test('macOS PTY helper becomes executable without changing addon bytes or accepting linked helpers', { skip: process.platform === 'win32' && 'POSIX executable-mode fixture' }, t => {
  const root = temporary(t), app = path.join(root, 'app'), pkg = path.join(app, 'node_modules/node-pty');
  const directory = path.join(pkg, 'prebuilds/darwin-arm64'); fs.mkdirSync(directory, { recursive: true });
  const helper = path.join(directory, 'spawn-helper'), addon = path.join(directory, 'pty.node');
  fs.writeFileSync(helper, 'owned helper', { mode: 0o644 }); fs.writeFileSync(addon, 'owned addon', { mode: 0o644 });
  const bytes = hash(fs.readFileSync(helper));
  normalizePtyHelpers(app, 'darwin-arm64');
  assert.equal(fs.statSync(helper).mode & 0o777, 0o755); assert.equal(hash(fs.readFileSync(helper)), bytes);
  assert.equal(fs.statSync(addon).mode & 0o777, 0o644);
  fs.unlinkSync(helper);
  assert.throws(() => normalizePtyHelpers(app, 'darwin-arm64'), /missing/);
  const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'external', { mode: 0o600 }); fs.symlinkSync(outside, helper);
  assert.throws(() => normalizePtyHelpers(app, 'darwin-arm64'), /physical file/);
  assert.equal(fs.statSync(outside).mode & 0o777, 0o600);
  normalizePtyHelpers(path.join(root, 'absent'), 'linux-x64'); normalizePtyHelpers(path.join(root, 'absent'), 'win32-x64');
});
test('final native-module probe uses the packaged interpreter and propagates actual load rejection', { skip: process.platform === 'win32' && 'POSIX copied-interpreter fixture; Windows preparation uses its native job runner' }, async t => {
  const root = temporary(t), artifact = path.join(root, 'artifact');
  fs.mkdirSync(path.join(artifact, 'node/bin'), { recursive: true });
  const app = path.join(artifact, 'app'), pkg = path.join(app, 'node_modules/node-pty'); fs.mkdirSync(pkg, { recursive: true });
  await bundledNode(artifact);
  fs.writeFileSync(path.join(app, 'package.json'), '{"name":"owned-probe-fixture"}');
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"node-pty","main":"index.cjs"}');
  fs.writeFileSync(path.join(pkg, 'index.cjs'), `if(process.execPath!==${JSON.stringify(path.join(artifact, 'node/bin/node'))})throw Error('EXTERNAL_INTERPRETER');module.exports={spawn(){}};`);
  const helperDir = path.join(pkg, 'prebuilds/darwin-arm64'); fs.mkdirSync(helperDir, { recursive: true });
  const helper = path.join(helperDir, 'spawn-helper'); fs.writeFileSync(helper, 'owned helper', { mode: 0o644 });
  fs.mkdirSync(path.join(pkg, 'lib')); fs.writeFileSync(path.join(pkg, 'lib/utils.js'), "exports.loadNativeModule=()=>({dir:'prebuilds/darwin-arm64'});");
  if (process.platform === 'darwin') await assert.rejects(verifyPackagedNodePty(artifact, 'node/bin/node', { env: { PATH: '/usr/bin:/bin' } }), /EACCES/);
  normalizePtyHelpers(app, 'darwin-arm64');
  await verifyPackagedNodePty(artifact, 'node/bin/node', { env: { PATH: '/usr/bin:/bin' } });
  fs.writeFileSync(path.join(pkg, 'index.cjs'), "throw Error('OWN_POST_SIGN_LOAD_REJECTED');");
  await assert.rejects(verifyPackagedNodePty(artifact, 'node/bin/node', { env: { PATH: '/usr/bin:/bin' } }), /OWN_POST_SIGN_LOAD_REJECTED/);
  fs.rmSync(pkg, { recursive: true });
  const external = path.join(root, 'node_modules/node-pty'); fs.mkdirSync(external, { recursive: true });
  fs.writeFileSync(path.join(external, 'package.json'), '{"name":"node-pty","main":"index.cjs"}');
  fs.writeFileSync(path.join(external, 'index.cjs'), "module.exports={spawn(){}};");
  await assert.rejects(verifyPackagedNodePty(artifact, 'node/bin/node', { env: { PATH: '/usr/bin:/bin' } }), /ENOENT/);
  await assert.rejects(verifyPackagedNodePty(artifact, '../outside', { env: {} }), /Unsafe packaged interpreter/);
});
test('relocated package bin wrappers retain sibling asset resolution and use the bundled interpreter', { skip: process.platform === 'win32' && 'POSIX symlinked bin fixture' }, async t => {
  const root = temporary(t), artifact = path.join(root, 'artifact'); fs.mkdirSync(path.join(artifact, 'node/bin'), { recursive: true }); fs.mkdirSync(path.join(artifact, 'app/node_modules/.bin'), { recursive: true });
  await bundledNode(artifact);
  const pkg = path.join(artifact, 'app/node_modules/example'); fs.mkdirSync(pkg); fs.writeFileSync(path.join(pkg, 'asset.txt'), 'ASSET_FROM_ORIGINAL_PACKAGE');
  fs.writeFileSync(path.join(pkg, 'cli.mjs'), "import fs from 'node:fs'; console.log(fs.readFileSync(new URL('./asset.txt',import.meta.url),'utf8')); console.log(process.execPath);\n");
  fs.symlinkSync('../example/cli.mjs', path.join(artifact, 'app/node_modules/.bin/example'));
  materializeBinLinks(artifact, 'node/bin/node');
  const moved = path.join(root, 'Перенесённый runtime с пробелом'); fs.renameSync(artifact, moved);
  const output = await run(path.join(moved, 'app/node_modules/.bin/example'), [], { env: { ...process.env, PATH: '/bin' }, capture: true, timeoutMs: 5000 });
  assert.match(output, /ASSET_FROM_ORIGINAL_PACKAGE/); assert.ok(output.includes(path.join(moved, 'node/bin/node')));
  const manifest = buildManifest(moved, { version: '0.85.1-0123', contract: 1, node: 'node/bin/node', entry: 'app/node_modules/example/cli.mjs' }); fs.writeFileSync(path.join(moved, MANIFEST), JSON.stringify(manifest));
  assert.deepEqual(verifyArtifact(moved), []);
});
const HOSTILE = "evil$(touch PWNED_SUB)`touch PWNED_TICK`'q'\"$HOME\"%PATH%!PATH!&^;(x)".replaceAll('"', '');
test('POSIX wrapper never evaluates shell metacharacters in package paths', { skip: process.platform === 'win32' }, async t => {
  const root = temporary(t), artifact = path.join(root, 'artifact'); fs.mkdirSync(path.join(artifact, 'node/bin'), { recursive: true }); fs.mkdirSync(path.join(artifact, 'app/node_modules/.bin'), { recursive: true });
  await bundledNode(artifact);
  const pkg = path.join(artifact, 'app/node_modules', HOSTILE); fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, 'cli.mjs'), "console.log('HOSTILE_PATH_CLI:' + process.argv[1]);\n");
  fs.symlinkSync(`../${HOSTILE}/cli.mjs`, path.join(artifact, 'app/node_modules/.bin/hostile'));
  materializeBinLinks(artifact, 'node/bin/node');
  const moved = path.join(root, "moved $(touch PWNED_ROOT) 'dir'"); fs.renameSync(artifact, moved);
  const output = await run(path.join(moved, 'app/node_modules/.bin/hostile'), [], { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root }, capture: true, timeoutMs: 5000 });
  assert.ok(output.includes(`HOSTILE_PATH_CLI:${path.join(moved, 'app/node_modules', HOSTILE, 'cli.mjs')}`), output);
  for (const marker of ['PWNED_SUB', 'PWNED_TICK', 'PWNED_ROOT']) { assert.equal(fs.existsSync(path.join(root, marker)), false, marker); assert.equal(fs.existsSync(path.join(moved, marker)), false, marker); }
});
test('POSIX wrapper text composes literal single-quoted suffixes after "$base"', () => {
  const text = posixWrapper('../..', 'node/bin/node', "app/x/it's $(id)`id`.mjs", true);
  assert.ok(text.includes(`exec "$base"'/node/bin/node' "$base"'/app/x/it'\\''s $(id)\`id\`.mjs' "$@"`), text);
  assert.ok(text.includes(`base=$(CDPATH= cd -- "$here"/'../..' && pwd -P)`));
  assert.doesNotMatch(text.split('\n').at(-2), /"\$base\/[^"]*"/, 'no artifact path inside a double-quoted word');
  assert.throws(() => posixWrapper('../x', 'node/bin/node', 'app/a.mjs', true), /ancestor/);
  assert.throws(() => posixWrapper('..', 'node/bin/node', 'app/a\nb', true), /Unsafe/);
});
test('cmd wrapper disables delayed expansion and doubles percent signs', () => {
  const text = windowsWrapper('../..', 'node.exe', `app/node_modules/${HOSTILE}/cli.mjs`, true), lines = text.split('\r\n');
  assert.equal(lines[1], 'SETLOCAL EnableExtensions DisableDelayedExpansion');
  assert.equal(lines[2], 'FOR %%I IN ("%~dp0..\\..") DO SET "base=%%~fI"');
  assert.equal(lines[3], `"%base%\\node.exe" "%base%\\app\\node_modules\\${HOSTILE.replaceAll('%', '%%')}\\cli.mjs" %*`);
  assert.ok(lines[3].includes('%%PATH%%') && lines[3].includes('!PATH!'), 'percent doubled; ! literal only because expansion is disabled');
  // Every quote is balanced so &, ^, ;, ( and ) stay inside quoted words.
  assert.equal((lines[3].match(/"/g) ?? []).length % 2, 0);
  for (const unsafe of ['app/a"b.mjs', 'app/a*b.mjs', 'app/a\r\nb.mjs', 'app\\a.mjs']) assert.throws(() => windowsWrapper('..', 'node.exe', unsafe, true), /Unsafe/);
});
test('escaping and broken package bin links fail closed without deleting the command', t => {
  const root = temporary(t); fs.mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true });
  const file = path.join(root, 'node_modules/.bin/escape'); fs.symlinkSync('/outside-fixture-that-does-not-exist', file);
  assert.throws(() => materializeBinLinks(root, 'node/bin/node')); assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
});
test('owned process deadline terminates a non-cooperative child rather than waiting indefinitely', { skip: needsRunner }, async t => {
  const root = temporary(t), file = path.join(root, 'hang.cjs'); fs.writeFileSync(file, "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n");
  const started = Date.now(); await assert.rejects(run(process.execPath, [file], { env: process.env, capture: true, timeoutMs: 100, runner }), /timed out/);
  assert.ok(Date.now() - started < 3000);
});
test('Windows jobs refuse to run without the exact bootstrapped runner', { skip: process.platform !== 'win32' && 'Windows-only refusal' }, async () => {
  await assert.rejects(run(process.execPath, ['-e', '0'], { env: process.env, runner: undefined }), /bootstrapped from this source/);
  await assert.rejects(run(process.execPath, ['-e', '0'], { env: process.env, runner: { path: process.execPath, sha256: '0'.repeat(64) } }), /bootstrap receipt/);
});
