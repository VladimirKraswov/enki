// Bootstrap process settlement and resource-cap regressions with OWN fixture
// processes only (no Cargo, no network, no installed runner). The descendant
// fixtures end themselves; tests wait for their completion markers so nothing
// outlives the test, and they prove the product never signalled them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bootstrapJobs, bootstrapRunner, bounded } from './build-runner.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = t => { const root = fs.realpathSync.native(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'build-runner-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(file, limitMs = 10_000) {
  const until = Date.now() + limitMs;
  while (!fs.existsSync(file)) { if (Date.now() > until) throw new Error(`fixture marker never appeared: ${file}`); await sleep(50); }
}
const baseEnv = marker => ({ PATH: process.env.PATH, MARKER: marker, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) });
// The descendant keeps the inherited stdout/stderr pipes for holdMs. With GONE
// set it first waits until its primary is REAPED by this test process
// (kill(pid, 0) succeeds for a zombie), i.e. Node has already reported the
// primary's exit, writes GONE, and only then starts holding.
const holderChild = holdMs => `const fs=require('fs'),parent=Number(process.env.PRIMARY);const hold=()=>setTimeout(()=>fs.writeFileSync(process.env.MARKER,'done'),${holdMs});`
  + `if(!process.env.GONE)hold();else{const t=setInterval(()=>{try{process.kill(parent,0)}catch{clearInterval(t);fs.writeFileSync(process.env.GONE,'gone');hold()}},10)}`;
// Primary that exits at once after starting the holder. Final seam review: the
// former cold `node -e` primary sometimes needed >300 ms to exit while large
// dependency copies ran, so a 300 ms deadline/cancel landed BEFORE the primary
// exit and exercised the other (group-kill) branch. On POSIX the primary is a
// tiny `/bin/sh`; the holder still inherits the pipes from the moment it forks.
// Production deadlines and assertions are unchanged.
function pipeHolder(marker, holdMs, gone) {
  const env = { ...baseEnv(marker), NODE: process.execPath, PROGRAM: holderChild(holdMs), ...(gone ? { GONE: gone } : {}) };
  if (process.platform !== 'win32') return ['/bin/sh', ['-c', 'PRIMARY=$$ "$NODE" -e "$PROGRAM" & exit 0'], env];
  // Windows libuv kills non-detached children when their primary exits.
  // This finite self-ending fixture must outlive that primary to hold pipes.
  const primary = "require('child_process').spawn(process.execPath,['-e',process.env.PROGRAM],{stdio:['ignore','inherit','inherit'],detached:true,windowsHide:true,env:{...process.env,PRIMARY:String(process.pid)}});process.exit(0)";
  return [process.execPath, ['-e', primary], env];
}

test('primary exit with a pipe-holding descendant settles as typed cleanup-unknown within the drain bound', async t => {
  const marker = path.join(temporary(t), 'marker'), [program, argv, env] = pipeHolder(marker, 1500), started = Date.now();
  await assert.rejects(bounded(program, argv, { cwd: REPO, env, timeoutMs: 30_000, drainMs: 200 }),
    error => error.code === 'ENKI_BUILD_CLEANUP_UNKNOWN' && error.cleanup === 'unknown');
  assert.ok(Date.now() - started < 1200, 'settled by the drain bound, not by the descendant');
  assert.equal(fs.existsSync(marker), false, 'did not wait for the pipe holder');
  await eventually(marker); // never signalled: it completed on its own
});
test('a deadline after primary exit settles instead of hanging on held pipes', async t => {
  const marker = path.join(temporary(t), 'marker'), [program, argv, env] = pipeHolder(marker, 1500), started = Date.now();
  // The typed cleanup-unknown code itself proves the deadline came AFTER the
  // primary exit (before it, the product kills the group: `signalled-group`).
  await assert.rejects(bounded(program, argv, { cwd: REPO, env, timeoutMs: 300, drainMs: 60_000 }),
    error => error.code === 'ENKI_BUILD_CLEANUP_UNKNOWN' && /did not finish within 300 ms/.test(error.message));
  assert.ok(Date.now() - started < 1200);
  assert.equal(fs.existsSync(marker), false);
  await eventually(marker);
});
test('cancellation after primary exit settles instead of hanging on held pipes', async t => {
  const root = temporary(t), marker = path.join(root, 'marker'), gone = path.join(root, 'gone'), controller = new AbortController();
  const [program, argv, env] = pipeHolder(marker, 1500, gone);
  const settled = bounded(program, argv, { cwd: REPO, env, timeoutMs: 30_000, drainMs: 60_000, signal: controller.signal });
  settled.catch(() => {}); // asserted below; never an unhandled rejection meanwhile
  // Cancel exactly once the primary has provably exited (no cold-start guess).
  await eventually(gone);
  const cancelled = Date.now();
  controller.abort(new Error('OWNED_CANCEL'));
  await assert.rejects(settled, error => error.code === 'ENKI_BUILD_CLEANUP_UNKNOWN' && /OWNED_CANCEL/.test(error.message));
  assert.ok(Date.now() - cancelled < 1000, 'settled at the cancellation, not by the descendant or the drain bound');
  assert.equal(fs.existsSync(marker), false, 'did not wait for the pipe holder');
  await eventually(marker);
});
test('trailing output inside the drain bound still succeeds normally', async t => {
  const marker = path.join(temporary(t), 'marker');
  // Natural exits (no process.exit) so asynchronous macOS pipe writes are flushed.
  const program = `require('child_process').spawn(process.execPath,['-e',"setTimeout(()=>{process.stdout.write('TRAILING');require('fs').writeFileSync(process.env.MARKER,'done')},200)"],{stdio:['ignore','inherit','inherit'],detached:process.platform==='win32',windowsHide:true}).unref();process.stdout.write('PRIMARY;')`;
  assert.equal(await bounded(process.execPath, ['-e', program], { cwd: REPO, env: baseEnv(marker), timeoutMs: 30_000, drainMs: 5_000 }), 'PRIMARY;TRAILING');
  assert.ok(fs.existsSync(marker));
});
test('a deadline before primary exit kills the owned group, including pipe holders', { skip: process.platform === 'win32' && 'Windows group termination is the real cargo Job (CI runner cases)' }, async t => {
  const marker = path.join(temporary(t), 'marker'), started = Date.now();
  const program = `require('child_process').spawn(process.execPath,['-e',"setTimeout(()=>require('fs').writeFileSync(process.env.MARKER,'late'),1500)"],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`;
  await assert.rejects(bounded(process.execPath, ['-e', program], { cwd: REPO, env: baseEnv(marker), timeoutMs: 300, drainMs: 5_000 }),
    error => /did not finish within 300 ms/.test(error.message) && error.cleanup === 'signalled-group');
  assert.ok(Date.now() - started < 3000);
  await sleep(2000);
  assert.equal(fs.existsSync(marker), false, 'group member survived the owned deadline');
});

test('bootstrap parallelism is capped at 2 and invalid values are refused, not dropped', () => {
  assert.equal(bootstrapJobs({}), 2);
  assert.equal(bootstrapJobs({ CARGO_BUILD_JOBS: '' }), 2);
  assert.equal(bootstrapJobs({ CARGO_BUILD_JOBS: '1' }), 1);
  assert.equal(bootstrapJobs({ CARGO_BUILD_JOBS: '2' }), 2);
  assert.equal(bootstrapJobs({ CARGO_BUILD_JOBS: '16' }), 2);
  for (const value of ['0', '-1', 'abc', '2.5', ' 2']) assert.throws(() => bootstrapJobs({ CARGO_BUILD_JOBS: value }), /positive integer/);
});

// POSIX fixture toolchain: rustc prints the fixture sysroot whose bin/ holds
// shell-script cargo/rustc. Exercises the REAL bootstrapRunner argv/env path.
function toolchain(root, cargoBody) {
  const sysroot = path.join(root, 'sysroot'), bin = path.join(sysroot, 'bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'rustc'), `#!/bin/sh\nprintf '%s\\n' '${sysroot}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'cargo'), `#!/bin/sh\n${cargoBody}\n`, { mode: 0o755 });
  return `${bin}:/usr/bin:/bin`;
}
const posixOnly = { skip: process.platform === 'win32' && 'POSIX shell fixture toolchain' };
test('bootstrap passes an explicit capped job count and no credentials to cargo', posixOnly, async t => {
  const root = temporary(t), log = path.join(root, 'log'), base = path.join(root, 'runner');
  const PATH = toolchain(root, `for a in "$@"; do printf '%s\\n' "$a"; done > '${log}.args'\nenv > '${log}.env'\nexit 3`);
  const source = { PATH, HOME: '/owner-home-unchanged', CARGO_BUILD_JOBS: '16', TAURI_SIGNING_PRIVATE_KEY: 'k', ARVELA_HUB_ADMIN_TOKEN: 't', OPENAI_API_KEY: 'p', NODE_OPTIONS: '--require /x' };
  await assert.rejects(bootstrapRunner({ repo: REPO, base, source, drainMs: 2_000 }), /exited 3/);
  const args = fs.readFileSync(`${log}.args`, 'utf8').split('\n'), env = fs.readFileSync(`${log}.env`, 'utf8');
  assert.equal(args[args.indexOf('--jobs') + 1], '2');
  assert.ok(args.includes('--locked') && args.includes('--release'));
  assert.match(env, /^CARGO_BUILD_JOBS=2$/m);
  assert.match(env, /^HOME=\/owner-home-unchanged$/m, 'HOME is preserved, never repurposed');
  for (const key of ['TAURI_SIGNING_PRIVATE_KEY', 'ARVELA_HUB_ADMIN_TOKEN', 'OPENAI_API_KEY', 'NODE_OPTIONS']) assert.doesNotMatch(env, new RegExp(`^${key}=`, 'm'));
  assert.deepEqual(fs.readdirSync(base), [], 'a settled failed compile leaves no private directory');
  source.CARGO_BUILD_JOBS = '1';
  await assert.rejects(bootstrapRunner({ repo: REPO, base, source, drainMs: 2_000 }), /exited 3/);
  const again = fs.readFileSync(`${log}.args`, 'utf8').split('\n'); assert.equal(again[again.indexOf('--jobs') + 1], '1');
});
test('an unsettled compile publishes no receipt and keeps its owned directory', posixOnly, async t => {
  const root = temporary(t), marker = path.join(root, 'marker'), base = path.join(root, 'runner');
  const PATH = toolchain(root, `( sleep 1; : > '${marker}' ) &\nexit 0`);
  let failure;
  await assert.rejects(bootstrapRunner({ repo: REPO, base, source: { PATH }, drainMs: 200 }), error => { failure = error; return error.code === 'ENKI_BUILD_CLEANUP_UNKNOWN'; });
  assert.equal(fs.existsSync(marker), false, 'settled without waiting for the background holder');
  const kept = fs.readdirSync(base); assert.equal(kept.length, 1, 'possibly still-written directory was not deleted');
  assert.equal(failure.retained, path.join(fs.realpathSync(base), kept[0]));
  assert.equal(fs.existsSync(path.join(failure.retained, 'provenance.json')), false, 'no provenance/receipt for an incomplete compile');
  await eventually(marker);
});
