import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { buildEnvironment, download, materializeBinLinks, posixWrapper, run, windowsWrapper } from './prepare.mjs';
import { buildManifest, MANIFEST, verifyArtifact } from './artifact.mjs';
const temporary = t => { const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prepare-case-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

test('build environment selects pinned Node first and cannot inherit npm credentials or owner configs', t => {
  const work = temporary(t), node = path.join(work, 'node');
  const env = buildEnvironment(node, work, 'darwin', { PATH: '/malicious/node', HOME: '/owner', NODE_OPTIONS: '--require /owner/hook',
    npm_config_registry: 'https://untrusted/', NPM_TOKEN: 'secret', GOOGLE_APPLICATION_CREDENTIALS: '/owner/adc', LANG: 'C' });
  assert.equal(env.PATH.split(':')[0], path.join(node, 'bin'));
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
