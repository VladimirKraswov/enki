import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { flushDirectoriesSync, runBuildJob, trustedRunner } from './native-port.mjs';
import { RUNNER_SOURCES, bootstrapRunner, runnerSourceDigest } from './build-runner.mjs';
import { setDirectoryFlushPort } from './artifact.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = t => { const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'native-port-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('runner trust is only an exact bootstrap receipt, never configuration or discovery', t => {
  const root = temporary(t), file = path.join(root, 'enki-build-runner.exe'); fs.writeFileSync(file, 'runner');
  assert.throws(() => trustedRunner(undefined), /bootstrapped from this source/);
  assert.throws(() => trustedRunner({ path: 'enki-build-runner.exe', sha256: sha256(file) }), /absolute/);
  assert.throws(() => trustedRunner({ path: `${root}${path.sep}..${path.sep}${path.basename(root)}${path.sep}enki-build-runner.exe`, sha256: sha256(file) }), /normalized/);
  assert.throws(() => trustedRunner({ path: file, sha256: '0'.repeat(64) }), /bootstrap receipt/, 'replaced bytes are refused');
  assert.equal(trustedRunner({ path: file, sha256: sha256(file) }), file);
});
test('linked runner paths are refused', { skip: process.platform === 'win32' }, t => {
  const root = temporary(t), real = path.join(root, 'real', 'runner'), link = path.join(root, 'link');
  fs.mkdirSync(path.dirname(real)); fs.writeFileSync(real, 'x'); fs.symlinkSync(path.dirname(real), link);
  assert.throws(() => trustedRunner({ path: path.join(link, 'runner'), sha256: sha256(real) }), /without links/);
  fs.symlinkSync(real, path.join(root, 'alias'));
  assert.throws(() => trustedRunner({ path: path.join(root, 'alias'), sha256: sha256(real) }), /regular file/);
});
test('runner provenance covers the exact audited sources', t => {
  const digest = runnerSourceDigest(REPO);
  assert.deepEqual(Object.keys(digest.files), RUNNER_SOURCES);
  for (const name of ['src-tauri/src/process.rs', 'src-tauri/src/build_job.rs', 'src-tauri/build-runner/Cargo.lock']) assert.ok(RUNNER_SOURCES.includes(name));
  const copy = temporary(t);
  for (const name of RUNNER_SOURCES) { fs.mkdirSync(path.dirname(path.join(copy, name)), { recursive: true }); fs.copyFileSync(path.join(REPO, name), path.join(copy, name)); }
  assert.equal(runnerSourceDigest(copy).digest, digest.digest);
  fs.appendFileSync(path.join(copy, 'src-tauri/src/build_job.rs'), '\n// changed\n');
  assert.notEqual(runnerSourceDigest(copy).digest, digest.digest);
});
test('bootstrap without a Rust toolchain fails typed, before any process, leaving nothing', async t => {
  const base = path.join(temporary(t), 'runner');
  await assert.rejects(bootstrapRunner({ repo: REPO, base, source: { PATH: '' } }), /Rust toolchain missing/);
  assert.deepEqual(fs.readdirSync(base), [], 'no partial private runner directory survives');
});
test('directory flush port accepts only an absolute runner', () => {
  assert.throws(() => setDirectoryFlushPort('relative/enki-build-runner.exe'), /absolute/);
  setDirectoryFlushPort(undefined);
});

// Live protocol checks against the runner bootstrapped by
// `node scripts/runtime/build-runner.mjs --out <dir>` (CI/Mac coordinator sets
// both variables from its receipt). Not mocked. Never run on a borrowed host.
const receipt = process.env.ENKI_TEST_NATIVE_RUNNER && { path: process.env.ENKI_TEST_NATIVE_RUNNER, sha256: process.env.ENKI_TEST_NATIVE_RUNNER_SHA256 };
const live = receipt ? trustedRunner(receipt) : undefined;
test('native runner executes, bounds and reports jobs', { skip: !live && 'ENKI_TEST_NATIVE_RUNNER not set' }, async t => {
  const root = temporary(t), env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};
  const output = await runBuildJob(live, { program: process.execPath, argv: ['-e', "process.stdout.write('LIVE:'+Object.keys(process.env).sort().join(','))"], cwd: root, env: { ...env, ONLY: '1' }, timeoutMs: 15_000, capture: true });
  assert.ok(output.startsWith('LIVE:') && output.includes('ONLY'), output);
  await assert.rejects(runBuildJob(live, { program: process.execPath, argv: ['-e', 'process.exit(4)'], cwd: root, env, timeoutMs: 15_000, capture: true }), /exited 4/);
  const started = Date.now();
  await assert.rejects(runBuildJob(live, { program: process.execPath, argv: ['-e', "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)"], cwd: root, env, timeoutMs: 300, capture: true }), /timed out/);
  assert.ok(Date.now() - started < 6000, 'descendant holding the pipe must not extend the deadline');
  await assert.rejects(runBuildJob(live, { program: process.execPath, argv: ['-e', "process.stdout.write('x'.repeat(65536));setInterval(()=>{},1000)"], cwd: root, env, timeoutMs: 15_000, capture: true, maxOutputBytes: 1024 }), /exceeds/);
  await assert.rejects(runBuildJob(live, { program: 'relative', argv: [], cwd: root, env, timeoutMs: 1000, capture: true }), /refused/);
});
test('primary exit settles its whole owned tree before success', { skip: !live && 'ENKI_TEST_NATIVE_RUNNER not set' }, async t => {
  const root = temporary(t), marker = path.join(root, 'marker'), env = { ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}), MARKER: marker };
  const child = "require('child_process').spawn(process.execPath,['-e',\"setTimeout(()=>require('fs').writeFileSync(process.env.MARKER,'x'),1500)\"],{stdio:'ignore'});process.exit(0)";
  assert.equal(await runBuildJob(live, { program: process.execPath, argv: ['-e', child], cwd: root, env, timeoutMs: 15_000, capture: true }), '');
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal(fs.existsSync(marker), false, 'a descendant acted after the job reported a settled tree');
});
test('native directory flush is exact and fails closed', { skip: !live && 'ENKI_TEST_NATIVE_RUNNER not set' }, t => {
  const root = temporary(t); fs.mkdirSync(path.join(root, 'inner'));
  flushDirectoriesSync(live, [root, path.join(root, 'inner')]);
  assert.throws(() => flushDirectoriesSync(live, [path.join(root, 'missing')]), /refused/);
});
