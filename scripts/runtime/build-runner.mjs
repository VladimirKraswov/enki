#!/usr/bin/env node
// Bootstrap of the trusted native build runner FROM the authenticated source
// being prepared: src-tauri/build-runner compiles the exact audited
// src-tauri/src/{process,build_job}.rs with serde/serde_json/libc only (no
// Tauri, frontend assets or agent runtime). runtime:prepare does this BEFORE
// runtime preparation, so the first source update driven by an older installed
// Enki (which has no --enki-build-job) still runs every Windows build job in an
// owned Job. No installed, discovered or candidate-supplied executable is used.
// No side effects at import.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RUNNER_SOURCES = ['src-tauri/build-runner/Cargo.toml', 'src-tauri/build-runner/Cargo.lock', 'src-tauri/build-runner/src/main.rs', 'src-tauri/src/process.rs', 'src-tauri/src/build_job.rs'];
const exe = platform => platform === 'win32' ? '.exe' : '';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// Toolchain/system locations only; never provider, signing or Hub credentials.
const TOOLCHAIN_ENV = ['PATH', 'HOME', 'USERPROFILE', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN', 'CARGO_NET_OFFLINE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  'LANG', 'LC_ALL', 'TZ', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LOCALAPPDATA', 'APPDATA', 'DEVELOPER_DIR', 'SDKROOT'];
// CARGO_BUILD_JOBS is not copied through the list above: it is validated and
// re-set explicitly (never above this cap) by bootstrapJobs.
const MAX_BOOTSTRAP_JOBS = 2;

/** Provenance: SHA256 of every runner input, read as regular files without links. */
export function runnerSourceDigest(repo) {
  const files = {};
  for (const relative of RUNNER_SOURCES) {
    const file = path.join(repo, ...relative.split('/')), stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error(`Runner source is not a regular file: ${relative}`);
    files[relative] = sha256(fs.readFileSync(file));
  }
  return { digest: sha256(RUNNER_SOURCES.map(name => `${name}\0${files[name]}\n`).join('')), files };
}

/** Exact identity check before every use: absolute normalized regular file
 * reached without links whose bytes still match the bootstrap receipt. */
export function verifyRunner(identity) {
  const file = identity?.path;
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file) throw new Error('Build runner path must be absolute and normalized');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || fs.realpathSync.native(file).toLowerCase() !== file.toLowerCase()) throw new Error('Build runner must be a regular file reached without links');
  if (!/^[a-f0-9]{64}$/.test(identity.sha256 ?? '') || sha256(fs.readFileSync(file)) !== identity.sha256) throw new Error('Build runner bytes do not match their bootstrap receipt');
  return file;
}

function onPath(name, env) {
  for (const directory of String(env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const file = path.join(directory, name);
    try { if (fs.statSync(file).isFile()) return file; } catch {}
  }
  throw new Error(`Rust toolchain missing: ${name} is not on PATH (required to bootstrap the native build runner)`);
}

/** Bounded child with an explicit environment. Unix: own process group, killed
 * only before Node reports its exit (after that the saved PGID is never
 * signalled: it may be reaped/reused). Windows: the REAL cargo (never the rustup
 * proxy) puts itself and every rustc/linker into its own kill-on-close Job, so
 * terminating it ends the compile tree. Output keeps a bounded tail.
 *
 * Settlement: normally on `close` (primary exited AND every pipe holder closed).
 * If something still holds stdout/stderr open `drainMs` after the primary exit,
 * or a deadline/cancel arrives after it, the pipes are released and the result
 * is a typed ENKI_BUILD_CLEANUP_UNKNOWN failure — never success, never a claim
 * that the owned tree settled. */
export function bounded(program, argv, { cwd, env, timeoutMs, signal, drainMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('Build cancelled')); return; }
    const child = spawn(program, argv, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', stdout = '', failure, exited = false, signalled = false, drain, settled = false;
    const name = path.basename(program);
    const settle = (outcome, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(drain); signal?.removeEventListener('abort', abort);
      outcome(value);
    };
    const unknown = cause => {
      // Stop waiting on pipes we cannot drain; the holder is NOT signalled.
      child.stdout.destroy(); child.stderr.destroy();
      settle(reject, Object.assign(new Error(`${name} exited but its owned process tree could not be confirmed settled (output still held open); cleanup unknown${cause ? `: ${cause.message}` : ''}`),
        { code: 'ENKI_BUILD_CLEANUP_UNKNOWN', cleanup: 'unknown', cause, output: tail }));
    };
    const stop = reason => {
      failure ??= reason;
      if (exited) { unknown(failure); return; }
      if (!child.pid || signalled) return;
      signalled = true;
      if (process.platform === 'win32') child.kill(); else try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    };
    const abort = () => stop(signal.reason ?? new Error('Build cancelled'));
    const timer = setTimeout(() => stop(new Error(`${name} did not finish within ${timeoutMs} ms`)), timeoutMs);
    const read = chunk => { tail = (tail + chunk.toString('utf8')).slice(-16_384); };
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString('utf8')).slice(-16_384); read(chunk); }); child.stderr.on('data', read);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => { failure ??= error; if (!child.pid) settle(reject, Object.assign(failure, { output: tail })); });
    child.once('exit', () => { exited = true; drain = setTimeout(() => unknown(failure), drainMs); });
    child.once('close', code => {
      if (failure) settle(reject, Object.assign(failure, { output: tail, cleanup: signalled ? 'signalled-group' : 'settled' }));
      else if (code !== 0) settle(reject, new Error(`${name} exited ${code}: ${tail.slice(-2000)}`));
      else settle(resolve, stdout);
    });
  });
}

/** Compile the runner into a fresh private directory under `base` and return
 * its receipt { path, sha256, root, sources }. The directory did not exist
 * before (mkdtemp), so no pre-planted binary can be picked up. */
/** Bootstrap compile parallelism: the caller's CARGO_BUILD_JOBS, capped at 2
 * (2 when unset). Anything but a positive integer is refused explicitly rather
 * than silently dropped or widened. */
export function bootstrapJobs(source = process.env) {
  const value = source.CARGO_BUILD_JOBS;
  if (value === undefined || value === '') return MAX_BOOTSTRAP_JOBS;
  if (!/^[1-9]\d{0,3}$/.test(String(value))) throw new Error(`CARGO_BUILD_JOBS must be a positive integer for the runner bootstrap (got ${JSON.stringify(String(value))})`);
  return Math.min(Number(value), MAX_BOOTSTRAP_JOBS);
}

/** Compile the runner into a fresh private directory under `base` and return
 * its receipt { path, sha256, root, sources }. The directory did not exist
 * before (mkdtemp), so no pre-planted binary can be picked up. A compile whose
 * process tree could not be confirmed settled publishes no receipt and keeps
 * (does not delete) its possibly still-written directory; the error names it. */
export async function bootstrapRunner({ repo, base, signal, source = process.env, platform = process.platform, timeoutMs = 20 * 60_000, drainMs = 10_000 }) {
  const sources = runnerSourceDigest(repo), jobs = bootstrapJobs(source);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(base), 'enki-build-runner-'));
  try {
    const env = {}; for (const key of TOOLCHAIN_ENV) if (source[key] !== undefined) env[key] = source[key];
    const work = path.join(root, 'tmp'), target = path.join(root, 'target'); fs.mkdirSync(work, { mode: 0o700 });
    Object.assign(env, { TMPDIR: work, TMP: work, TEMP: work, CARGO_TERM_COLOR: 'never', CARGO_INCREMENTAL: '0', CARGO_BUILD_JOBS: String(jobs) });
    const sysroot = (await bounded(onPath(`rustc${exe(platform)}`, env), ['--print', 'sysroot'], { cwd: root, env, timeoutMs: 60_000, signal, drainMs })).trim();
    if (!path.isAbsolute(sysroot)) throw new Error('rustc reported no absolute sysroot');
    const cargo = path.join(sysroot, 'bin', `cargo${exe(platform)}`), rustc = path.join(sysroot, 'bin', `rustc${exe(platform)}`);
    for (const tool of [cargo, rustc]) if (!fs.statSync(tool).isFile()) throw new Error(`Toolchain binary missing: ${tool}`);
    const manifest = path.join(repo, 'src-tauri', 'build-runner', 'Cargo.toml');
    // --jobs on the command line outranks any Cargo config file; the env copy
    // keeps nested cargo invocations under the same cap.
    await bounded(cargo, ['build', '--release', '--locked', '--jobs', String(jobs), '--manifest-path', manifest, '--target-dir', target],
      { cwd: path.dirname(manifest), env: { ...env, RUSTC: rustc, CARGO_TARGET_DIR: target }, timeoutMs, signal, drainMs });
    if (runnerSourceDigest(repo).digest !== sources.digest) throw new Error('Runner sources changed during bootstrap');
    const file = path.join(fs.realpathSync.native(target), 'release', `enki-build-runner${exe(platform)}`);
    const identity = { path: file, sha256: sha256(fs.readFileSync(file)), root, sources };
    fs.writeFileSync(path.join(root, 'provenance.json'), JSON.stringify({ schema: 1, runner: identity.sha256, sources, cargo, rustc }, null, 2) + '\n', { mode: 0o600 });
    verifyRunner(identity);
    return identity;
  } catch (error) {
    if (error?.cleanup === 'unknown') { error.retained = root; error.message += `; retained ${root} for inspection/cleanup after its processes are gone`; }
    else fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function discardRunner(identity) { if (identity?.root) fs.rmSync(identity.root, { recursive: true, force: true }); }

// Manual/CI: `node scripts/runtime/build-runner.mjs --out <private dir>` prints the receipt.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), index = process.argv.indexOf('--out');
  try {
    if (index < 0 || !path.isAbsolute(process.argv[index + 1] ?? '')) throw new Error('--out <absolute private directory> is required');
    console.log(JSON.stringify(await bootstrapRunner({ repo, base: process.argv[index + 1] })));
  } catch (error) { console.error(`build-runner: ${error.message}`); process.exitCode = 1; }
}
