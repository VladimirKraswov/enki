// First 0.2 -> 2.0 source update: the exact argv an OLD installed builder
// passes to `npm run tauri` through the REAL entry functions. Preparation and
// the Tauri CLI are owned fixture ports (transport/argv/order/cancel evidence,
// not production readiness; the coordinator's real Mac build and Windows CI
// old-entry build qualify packaging). No network, Cargo or installed Enki.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { RUNTIME_CONFIG, hostNodeProblem, main, normalizedBin, planTauriInvocation, resolveTauriCli, runTauriInvocation } from './tauri-entry.mjs';
import { preparationDigest, preparedRuntimeProblems } from './prepare.mjs';
import { MANIFEST, buildManifest, sha256File } from './artifact.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = t => { const root = fs.realpathSync.native(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tauri-entry-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const SIGNING = '{"bundle":{"macOS":{"signingIdentity":"-"}}}';
// Saved from old canonical 0.2.115 hub_updates/build.rs platform_args + suffix.
const OLD_VECTORS = {
  mac: ['build', '--bundles', 'app', '--config', SIGNING, '--ci', '--', '--locked'],
  windows: ['build', '--bundles', 'nsis', '--ci', '--', '--locked'],
  'linux-appimage': ['build', '--bundles', 'appimage', '--ci', '--', '--locked'],
  'linux-deb': ['build', '--bundles', 'deb', '--ci', '--', '--locked'],
  'linux-rpm': ['build', '--bundles', 'rpm', '--ci', '--', '--locked'],
};
const withRuntime = argv => { const at = argv.indexOf('--'); return [...argv.slice(0, at), '--config', RUNTIME_CONFIG, ...argv.slice(at)]; };

// Fixture CLI: records argv/cwd, then exits FIXTURE_EXIT or hangs (FIXTURE_HANG, optionally ignoring SIGTERM).
function fixtureCli(root) {
  const file = path.join(root, 'cli.mjs');
  fs.writeFileSync(file, `import fs from 'node:fs';
fs.writeFileSync(process.env.FIXTURE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
if (process.env.FIXTURE_STUBBORN) process.on('SIGTERM', () => {});
if (process.env.FIXTURE_HANG) setInterval(() => {}, 1000); else process.exitCode = Number(process.env.FIXTURE_EXIT || 0);\n`);
  return file;
}
function fixturePort({ ready = false, onPrepare } = {}) {
  const port = { events: [], ready,
    preparedRuntimeProblems(repo, identity) { port.events.push(['check', identity.platform]); return port.ready ? [] : ['no prepared runtime']; },
    async prepare(options) { port.events.push(['prepare', options.platform, options.signingIdentity]); await onPrepare?.(options); if (!onPrepare) port.ready = true; } };
  return port;
}
function setup(t, extra = {}) {
  const root = temporary(t), log = path.join(root, 'log.json');
  return { root, log, cli: fixtureCli(root), read: () => JSON.parse(fs.readFileSync(log, 'utf8')),
    options: { repo: root, env: { PATH: process.env.PATH, FIXTURE_LOG: log, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}), ...extra }, graceMs: 200 } };
}

test('every old platform vector: runtime config inserted before Cargo --, originals byte-identical and ordered', () => {
  for (const [name, argv] of Object.entries(OLD_VECTORS)) {
    const plan = planTauriInvocation(argv, { platform: 'darwin', arch: 'arm64' });
    assert.equal(plan.prepare, true, name); assert.equal(plan.command, 'build');
    assert.deepEqual(plan.args, withRuntime(argv), name);
    assert.ok(plan.args.indexOf(RUNTIME_CONFIG) < plan.args.indexOf('--'), `${name}: config precedes the Cargo separator`);
    assert.deepEqual(plan.args.slice(-2), ['--', '--locked']); assert.ok(plan.args.includes('--ci'));
    const removed = plan.args.slice(); removed.splice(removed.indexOf(RUNTIME_CONFIG) - 1, 2); assert.deepEqual(removed, argv);
  }
  const mac = planTauriInvocation(OLD_VECTORS.mac).args;
  assert.ok(mac.indexOf(SIGNING) < mac.indexOf(RUNTIME_CONFIG), 'signing JSON retained ahead of the runtime overlay');
});
test('the current native builder vector (already carrying the overlay) is not duplicated', () => {
  const argv = ['build', '--bundles', 'app', '--config', SIGNING, '--config', RUNTIME_CONFIG, '--ci', '--', '--locked'];
  const plan = planTauriInvocation(argv); assert.equal(plan.prepare, true); assert.deepEqual(plan.args, argv);
  assert.deepEqual(planTauriInvocation(['-v', 'build', '--bundles', 'nsis']).args, ['-v', 'build', '--bundles', 'nsis', '--config', RUNTIME_CONFIG]);
  const odd = ['build', '--config', '{"x":"a b \\"q\\" $HOME %PATH% ü"}', '--', '--locked', '--', 'x'];
  assert.deepEqual(planTauriInvocation(odd).args, withRuntime(odd), 'only the FIRST -- is the Cargo separator');
});
test('help, version, dev, info and unrelated commands pass through unchanged without preparation', () => {
  for (const argv of [[], ['--help'], ['-h'], ['-V'], ['--version'], ['build', '--help'], ['build', '-h'], ['bundle', '--help'], ['dev'], ['info'], ['icon', 'x.png'], ['signer', 'sign', 'f'], ['help', 'build'], ['--', 'build']]) {
    const plan = planTauriInvocation(argv); assert.equal(plan.prepare, false, argv.join(' ')); assert.deepEqual(plan.args, argv);
  }
  assert.throws(() => planTauriInvocation(['build', 1]), TypeError);
});
test('host Node is checked explicitly before any preparation helper loads', () => {
  for (const version of ['v24.22.1', 'v24.0.0', 'v22.13.0', 'v23.4.0', 'v26.1.0']) assert.equal(hostNodeProblem(version), null, version);
  for (const version of ['v22.12.0', 'v23.3.0', 'v20.18.1', 'v18.20.0', 'garbage']) assert.match(hostNodeProblem(version), /needs host Node\.js >=22\.13.*no app was built/, version);
});

test('old vectors through main(): preparation first, then the CLI receives original argv plus overlay', async t => {
  for (const [name, argv] of Object.entries(OLD_VECTORS)) {
    const s = setup(t), port = fixturePort({ onPrepare: () => { assert.equal(fs.existsSync(s.log), false, 'CLI must not start before preparation'); port.ready = true; } });
    assert.equal(await main(argv, { ...s.options, runtime: port, cli: s.cli, log: () => {} }), 0, name);
    assert.deepEqual(port.events.map(e => e[0]), ['check', 'prepare', 'check'], name);
    assert.deepEqual(s.read().argv, withRuntime(argv), name);
    assert.equal(fs.realpathSync(s.read().cwd), s.root, 'explicit repository cwd');
  }
});
test('verified reuse skips duplicate preparation; CLI exit codes propagate', async t => {
  const s = setup(t, { FIXTURE_EXIT: '7' }), port = fixturePort({ ready: true });
  assert.equal(await main(OLD_VECTORS.windows, { ...s.options, runtime: port, cli: s.cli, log: () => {} }), 7);
  assert.deepEqual(port.events.map(e => e[0]), ['check', 'check'], 'no second preparation');
});
test('preparation failure, unverified result or unsupported host never compile', async t => {
  const s = setup(t), messages = [];
  const failing = fixturePort({ onPrepare: () => { throw new Error('PREPARE_FIXTURE_FAILED'); } });
  assert.equal(await main(OLD_VECTORS.mac, { ...s.options, runtime: failing, cli: s.cli, log: m => messages.push(m) }), 1);
  assert.match(messages.join('\n'), /PREPARE_FIXTURE_FAILED/); assert.equal(fs.existsSync(s.log), false);
  const hollow = fixturePort({ onPrepare: () => {} }); // "succeeds" but leaves nothing verifiable
  await assert.rejects(runTauriInvocation(planTauriInvocation(OLD_VECTORS.windows), { ...s.options, runtime: hollow, cli: s.cli }), { code: 'ENKI_RUNTIME_UNVERIFIED' });
  assert.equal(fs.existsSync(s.log), false);
  const untouched = fixturePort();
  await assert.rejects(runTauriInvocation(planTauriInvocation(OLD_VECTORS.mac), { ...s.options, hostVersion: 'v20.18.1', runtime: untouched, cli: s.cli }), { code: 'ENKI_HOST_NODE_UNSUPPORTED' });
  assert.deepEqual(untouched.events, [], 'refused before any check or preparation'); assert.equal(fs.existsSync(s.log), false);
});
test('pass-through commands never touch preparation, even on an old host', async t => {
  const s = setup(t), forbidden = new Proxy({}, { get() { throw new Error('preparation port touched'); } });
  for (const argv of [['--version'], ['dev'], ['build', '--help']]) {
    const result = await runTauriInvocation(planTauriInvocation(argv), { ...s.options, hostVersion: 'v18.0.0', runtime: forbidden, cli: s.cli });
    assert.deepEqual(result, { code: 0, signal: null }); assert.deepEqual(s.read().argv, argv);
  }
});
const waitFor = async (file, limitMs = 10_000) => { const until = Date.now() + limitMs; while (!fs.existsSync(file)) { if (Date.now() > until) throw new Error('fixture never started'); await new Promise(r => setTimeout(r, 20)); } };
test('cancellation or deadline during preparation is bounded and never compiles', async t => {
  const s = setup(t), waiting = fixturePort({ onPrepare: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('fixture saw abort')), { once: true })) });
  const controller = new AbortController(); setTimeout(() => controller.abort(new Error('OWNER_CANCEL')), 100);
  let started = Date.now();
  await assert.rejects(runTauriInvocation(planTauriInvocation(OLD_VECTORS.mac), { ...s.options, signal: controller.signal, runtime: waiting, cli: s.cli }), { code: 'ENKI_TAURI_CANCELLED' });
  assert.ok(Date.now() - started < 2000); assert.equal(fs.existsSync(s.log), false);
  started = Date.now();
  await assert.rejects(runTauriInvocation(planTauriInvocation(OLD_VECTORS.windows), { ...s.options, prepareTimeoutMs: 150, runtime: waiting, cli: s.cli }), { code: 'ENKI_TAURI_DEADLINE' });
  assert.ok(Date.now() - started < 2000); assert.equal(fs.existsSync(s.log), false);
  const aborted = new AbortController(); aborted.abort(new Error('before start'));
  assert.equal(await main(OLD_VECTORS.mac, { ...s.options, signal: aborted.signal, runtime: fixturePort(), cli: s.cli, log: () => {} }), 130);
});
test('cancellation or deadline during the CLI stops a non-cooperative primary within bounds', async t => {
  for (const mode of ['cancel', 'deadline']) {
    const s = setup(t, { FIXTURE_HANG: '1', FIXTURE_STUBBORN: '1' }), controller = new AbortController();
    const running = runTauriInvocation(planTauriInvocation(OLD_VECTORS['linux-deb']), { ...s.options, signal: controller.signal, timeoutMs: mode === 'deadline' ? 500 : 60_000, runtime: fixturePort({ ready: true }), cli: s.cli });
    await waitFor(s.log); const started = Date.now();
    if (mode === 'cancel') controller.abort(new Error('OWNER_CANCEL'));
    await assert.rejects(running, error => error.code === (mode === 'cancel' ? 'ENKI_TAURI_CANCELLED' : 'ENKI_TAURI_DEADLINE') && error.cleanup === 'primary-exited');
    assert.ok(Date.now() - started < 3000, `${mode} bounded by grace + escalation`);
  }
});
test('CLI spawn shape: this Node, the package bin, exact argv, shell:false, explicit cwd/env', async t => {
  const s = setup(t), calls = [];
  const spawnImpl = (program, args, options) => { calls.push({ program, args, options }); const child = new EventEmitter(); child.kill = () => true; setImmediate(() => child.emit('exit', 0, null)); return child; };
  await runTauriInvocation(planTauriInvocation(OLD_VECTORS.mac), { ...s.options, runtime: fixturePort({ ready: true }), cli: s.cli, spawnImpl });
  assert.equal(calls.length, 1); const [{ program, args, options }] = calls;
  assert.equal(program, process.execPath); assert.deepEqual(args, [s.cli, ...withRuntime(OLD_VECTORS.mac)]);
  assert.equal(options.shell, false); assert.equal(options.cwd, s.root); assert.equal(options.env, s.options.env); assert.equal(options.stdio, 'inherit');
});

function cliPackage(root, { version = '2.11.5', lockVersion = version, bin = { tauri: 'tauri.js' }, lockBin = bin } = {}) {
  const pkg = path.join(root, 'node_modules/@tauri-apps/cli'); fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@tauri-apps/cli', version, bin, main: 'main.js' }));
  fs.writeFileSync(path.join(pkg, 'tauri.js'), '// fixture\n'); fs.writeFileSync(path.join(pkg, 'main.js'), '// not the CLI bin\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@tauri-apps/cli': { version: lockVersion, bin: lockBin } } }));
  return pkg;
}
test('official @tauri-apps/cli metadata "./tauri.js" matches the npm-normalized lock "tauri.js"', t => {
  const root = temporary(t);
  // Literal published 2.11.5 package.json bin vs the root package-lock entry npm ci writes.
  const pkg = cliPackage(root, { bin: { tauri: './tauri.js' }, lockBin: { tauri: 'tauri.js' } });
  assert.equal(resolveTauriCli(root), path.join(pkg, 'tauri.js'));
  cliPackage(root, { bin: { tauri: 'tauri.js' }, lockBin: { tauri: './tauri.js' } }); assert.equal(resolveTauriCli(root), path.join(pkg, 'tauri.js'));
  cliPackage(root, { bin: './tauri.js', lockBin: { cli: 'tauri.js' } }); assert.throws(() => resolveTauriCli(root), { code: 'ENKI_TAURI_CLI_UNVERIFIED' }, 'string bin names the unscoped package (cli), not tauri');
  cliPackage(root, { bin: { tauri: './tauri.js' }, lockBin: { tauri: 'main.js' } }); assert.throws(() => resolveTauriCli(root), /bin does not match/);
  cliPackage(root, { bin: { tauri: './tauri.js', extra: 'main.js' }, lockBin: { tauri: 'tauri.js' } }); assert.throws(() => resolveTauriCli(root), /bin does not match/);
  cliPackage(root, { bin: { tauri: './tauri.js' }, lockBin: { tauri: '../tauri.js' } }); assert.throws(() => resolveTauriCli(root), /Unsafe/);
  cliPackage(root, { bin: { tauri: '/abs/tauri.js' } }); assert.throws(() => resolveTauriCli(root), /Unsafe/);
  cliPackage(root, { bin: { tauri: '\\tauri.js' } }); assert.throws(() => resolveTauriCli(root), /Unsafe/);
  cliPackage(root, { bin: { tauri: 'C:tauri.js' } }); assert.throws(() => resolveTauriCli(root), /Unsafe/);
  cliPackage(root, { bin: {} }); assert.throws(() => resolveTauriCli(root), /Unsafe/);
});
test('normalizedBin equates only equivalent contained spellings', () => {
  assert.deepEqual(normalizedBin({ tauri: './tauri.js' }, '@tauri-apps/cli'), { tauri: 'tauri.js' });
  assert.deepEqual(normalizedBin('./bin//x.js', '@tauri-apps/cli'), { cli: 'bin/x.js' });
  assert.deepEqual(normalizedBin({ b: 'b.js', a: './a.js' }, 'x'), normalizedBin({ a: 'a.js', b: './b.js' }, 'x'), 'key order is not identity');
  for (const unsafe of [undefined, null, [], ['tauri.js'], { tauri: '' }, { tauri: '.' }, { tauri: 'a/../b.js' }, { tauri: 7 }, { '': 'tauri.js' }]) assert.equal(normalizedBin(unsafe, '@tauri-apps/cli'), null, JSON.stringify(unsafe));
});
test('the CLI is the installed package bin verified against package-lock, never PATH or main', t => {
  const root = temporary(t);
  assert.throws(() => resolveTauriCli(root), { code: 'ENKI_TAURI_CLI_MISSING' });
  const pkg = cliPackage(root); assert.equal(resolveTauriCli(root), path.join(pkg, 'tauri.js'));
  cliPackage(root, { lockVersion: '2.0.0' }); assert.throws(() => resolveTauriCli(root), { code: 'ENKI_TAURI_CLI_UNVERIFIED' });
  cliPackage(root, { bin: { tauri: '../escape.js' } }); assert.throws(() => resolveTauriCli(root), /Unsafe/);
  cliPackage(root, { bin: { tauri: 'missing.js' } }); assert.throws(() => resolveTauriCli(root), /regular file/);
});
test('a linked CLI package directory is refused', { skip: process.platform === 'win32' && 'POSIX symlink fixture' }, t => {
  const root = temporary(t), real = cliPackage(path.join(root, 'elsewhere')); fs.mkdirSync(path.join(root, 'node_modules/@tauri-apps'), { recursive: true });
  fs.copyFileSync(path.join(root, 'elsewhere/package-lock.json'), path.join(root, 'package-lock.json'));
  fs.symlinkSync(real, path.join(root, 'node_modules/@tauri-apps/cli')); assert.throws(() => resolveTauriCli(root), /not a link/);
});
test('this checkout resolves the actual installed @tauri-apps/cli tauri.js (not executed)', { skip: !fs.existsSync(path.join(REPO, 'node_modules/@tauri-apps/cli')) && 'root npm ci not run' }, () => {
  assert.equal(resolveTauriCli(REPO), path.join(fs.realpathSync.native(path.join(REPO, 'node_modules/@tauri-apps/cli')), 'tauri.js'));
});
// Real reuse verification (prepare.mjs) over an owned fixture repository/artifact.
function preparedRepo(t) {
  const repo = temporary(t), write = (relative, text) => { const file = path.join(repo, ...relative.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  for (const name of ['agent', 'shared', 'browser', 'pi']) write(`src-tauri/resources/${name}/index.txt`, name);
  write('src-tauri/resources/agent/node_modules/dep/index.js', 'not staged by copyTree');
  for (const relative of ['scripts/runtime/prepare.mjs', 'scripts/runtime/artifact.mjs', 'src-tauri/runtime-node.entitlements', 'src-tauri/runtime-node-adhoc.entitlements']) write(relative, relative);
  const current = path.join(repo, 'src-tauri/target/enki-agent/current'), identity = { platform: 'darwin-arm64', signingIdentity: '-' };
  write('src-tauri/target/enki-agent/current/node/bin/node', 'node'); write('src-tauri/target/enki-agent/current/app/dist/main.js', 'main');
  const manifest = () => fs.writeFileSync(path.join(current, MANIFEST), JSON.stringify(buildManifest(current, { version: '0.85.1-fixture', contract: 1, node: 'node/bin/node', entry: 'app/dist/main.js' })));
  manifest();
  const receipt = path.join(repo, 'src-tauri/target/enki-agent/preparation-receipt.json');
  fs.writeFileSync(receipt, JSON.stringify({ schema: 1, platform: identity.platform, remote: false, signingIdentity: '-', inputs: preparationDigest(repo, identity), version: '0.85.1-fixture', manifestSha256: sha256File(path.join(current, MANIFEST)) }));
  return { repo, current, identity, write, manifest, receipt };
}
test('reuse requires the manifest-bound receipt, unchanged sources and a fully verifying artifact', t => {
  const { repo, current, identity, write, manifest, receipt } = preparedRepo(t), problems = options => preparedRuntimeProblems(repo, { ...identity, ...options }).join('; ');
  assert.equal(problems(), '');
  write('src-tauri/resources/agent/node_modules/dep/index.js', 'changed'); assert.equal(problems(), '', 'unstaged trees do not affect reuse');
  assert.match(problems({ platform: 'win32-x64' }), /another platform/);
  assert.match(problems({ signingIdentity: 'Developer ID Application: X' }), /signing identity/);
  assert.match(problems({ remote: true }), /remote/);
  write('src-tauri/resources/pi/index.txt', 'edited'); assert.match(problems(), /sources changed/);
  write('src-tauri/resources/pi/index.txt', 'pi'); write('scripts/runtime/prepare.mjs', 'new preparation code'); assert.match(problems(), /sources changed/);
  write('scripts/runtime/prepare.mjs', 'scripts/runtime/prepare.mjs'); assert.equal(problems(), '');
  write('src-tauri/runtime-node-adhoc.entitlements', 'changed ad-hoc signing policy'); assert.match(problems(), /sources changed/);
  write('src-tauri/runtime-node-adhoc.entitlements', 'src-tauri/runtime-node-adhoc.entitlements'); assert.equal(problems(), '');
  fs.writeFileSync(path.join(current, 'app/dist/main.js'), 'tampered'); assert.match(problems(), /hash mismatch/);
  manifest(); assert.match(problems(), /unexpected manifest sha256/, 'a regenerated manifest is not the prepared one');
  fs.rmSync(receipt); assert.match(problems(), /no usable preparation receipt/);
});
test('a tampered prepared runtime is re-prepared before compile, and refused if preparation cannot repair it', async t => {
  const fixture = preparedRepo(t), s = setup(t), plan = planTauriInvocation(OLD_VECTORS.mac, { platform: 'darwin', arch: 'arm64' }), repairs = [];
  const port = repair => ({ preparedRuntimeProblems, async prepare(options) { repairs.push(options.platform); assert.equal(fs.existsSync(s.log), false); if (repair) fs.writeFileSync(path.join(fixture.current, 'app/dist/main.js'), 'main'); } });
  fs.writeFileSync(path.join(fixture.current, 'app/dist/main.js'), 'tampered');
  assert.deepEqual(await runTauriInvocation(plan, { ...s.options, repo: fixture.repo, runtime: port(true), cli: s.cli }), { code: 0, signal: null });
  assert.deepEqual(repairs, ['darwin-arm64']); assert.deepEqual(s.read().argv, withRuntime(OLD_VECTORS.mac));
  fs.rmSync(s.log); fs.writeFileSync(path.join(fixture.current, 'app/dist/main.js'), 'tampered again');
  await assert.rejects(runTauriInvocation(plan, { ...s.options, repo: fixture.repo, runtime: port(false), cli: s.cli }), { code: 'ENKI_RUNTIME_UNVERIFIED' });
  assert.equal(fs.existsSync(s.log), false, 'no compile with a runtime that does not verify');
});
test('package.json routes the old public `npm run tauri` through this entry; build:platform keeps explicit prepare', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts.tauri, 'node scripts/runtime/tauri-entry.mjs');
  for (const name of ['build:linux', 'build:windows', 'build:macos', 'build:release:macos']) assert.match(scripts[name], /runtime:prepare -- --platform \S+ && tauri build .*--config src-tauri\/tauri\.runtime\.conf\.json/);
});
