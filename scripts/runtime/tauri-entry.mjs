#!/usr/bin/env node
// Source-owned `npm run tauri` entry (package.json scripts.tauri). The FIRST
// 0.2 -> 2.0 source update is compiled by an older installed Enki whose builder
// knows only `npm ci` then `npm run tauri -- build ... --ci -- --locked`; it
// never runs runtime:prepare nor passes the runtime resources config. For
// `build`/`bundle` this entry therefore prepares (or reuses only after full
// verification) the bundled agent runtime from THIS authenticated source, then
// runs the installed @tauri-apps/cli package bin with the runtime config
// inserted before Cargo's `--`. Help/version/dev/info and every other command
// pass through unchanged, without preparation or downloads. Static imports are
// Node builtins plus the import-free host-node.mjs guard: the host check runs
// BEFORE the node:sqlite helpers load.
// No side effects at import.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostNodeProblem as hostProblem } from './host-node.mjs';

export const RUNTIME_CONFIG = 'src-tauri/tauri.runtime.conf.json';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PREPARED = new Set(['build', 'bundle']);
const HELP = new Set(['-h', '--help', '-V', '--version']);
const typed = (code, message, extra) => Object.assign(new Error(message), { code }, extra);
const cancelled = signal => typed('ENKI_TAURI_CANCELLED', 'Build cancelled; the app was not compiled', { cause: signal && signal.reason });

/** null when this host interpreter can run runtime preparation (see host-node.mjs). */
export function hostNodeProblem(version = process.version) {
  return hostProblem(version);
}

function hasRuntimeConfig(options) {
  for (let i = 0; i < options.length; i++) {
    if ((options[i] === '--config' || options[i] === '-c') && options[i + 1] === RUNTIME_CONFIG) return true;
    if (options[i] === `--config=${RUNTIME_CONFIG}`) return true;
  }
  return false;
}

/** Pure plan for `tauri <argv>`. Original arguments keep their exact bytes and
 * relative order; `build`/`bundle` gain `--config <runtime>` immediately before
 * the first Cargo `--` (or at the end) unless the caller already passes it. */
export function planTauriInvocation(argv, { platform = process.platform, arch = process.arch } = {}) {
  if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string')) throw new TypeError('argv must be an array of strings');
  const original = Object.freeze(argv.slice());
  let index = 0;
  while (index < original.length && original[index].startsWith('-') && original[index] !== '--') index++;
  const command = index < original.length && original[index] !== '--' ? original[index] : null;
  const separator = command === null ? -1 : original.indexOf('--', index + 1);
  const options = command === null ? [] : original.slice(index + 1, separator < 0 ? original.length : separator);
  const help = original.slice(0, index).concat(options).some(arg => HELP.has(arg));
  const prepare = PREPARED.has(command) && !help;
  let args = original;
  if (prepare && !hasRuntimeConfig(options)) {
    const at = separator < 0 ? original.length : separator;
    args = Object.freeze([...original.slice(0, at), '--config', RUNTIME_CONFIG, ...original.slice(at)]);
  }
  return Object.freeze({ command, prepare, platform: `${platform}-${arch}`, original, args });
}

export function compilerArguments(args, env, buildEnv) {
  if (buildEnv === env || !env.CARGO_TARGET_DIR || buildEnv.CARGO_TARGET_DIR) return args;
  return [...args, ...(args.includes('--') ? [] : ['--']), '--target-dir', env.CARGO_TARGET_DIR];
}

/** npm-equivalent bin map, or null when any entry is not a plain contained
 * relative path. npm-ci writes the lock in normalized form: a string bin names
 * the unscoped package, and `./tauri.js` (official package metadata) is the same
 * file as `tauri.js` (package-lock). Only these spellings are equated; names,
 * targets and entry count must still agree exactly. */
export function normalizedBin(bin, name) {
  const entries = typeof bin === 'string' ? [[String(name).replace(/^@[^/]+\//, ''), bin]]
    : bin && typeof bin === 'object' && !Array.isArray(bin) ? Object.entries(bin) : null;
  if (!entries || entries.length === 0) return null;
  const normalized = {};
  for (const [key, value] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!key || typeof value !== 'string' || /^[\\/]|^[A-Za-z]:/.test(value) || path.isAbsolute(value)) return null;
    const parts = value.split(/[\\/]/).filter(part => part !== '' && part !== '.');
    if (parts.length === 0 || parts.includes('..')) return null;
    normalized[key] = parts.join('/');
  }
  return normalized;
}

/** Installed root @tauri-apps/cli package bin, from its own package metadata and
 * cross-checked against the root package-lock that `npm ci` installed. Never
 * PATH, a node_modules/.bin shim, an installed Enki or a recursive npm script. */
export function resolveTauriCli(repo = REPO) {
  const root = path.join(repo, 'node_modules', '@tauri-apps', 'cli');
  let stat;
  try { stat = fs.lstatSync(root); } catch { throw typed('ENKI_TAURI_CLI_MISSING', 'Installed @tauri-apps/cli not found; run npm ci first'); }
  if (!stat.isDirectory()) throw typed('ENKI_TAURI_CLI_UNVERIFIED', '@tauri-apps/cli must be an installed directory, not a link');
  const real = fs.realpathSync.native(root);
  let pkg, locked;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8'));
    locked = JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8')).packages['node_modules/@tauri-apps/cli'];
  } catch (error) { throw typed('ENKI_TAURI_CLI_UNVERIFIED', `Cannot read @tauri-apps/cli metadata: ${error.message}`); }
  if (!pkg || pkg.name !== '@tauri-apps/cli' || !locked || pkg.version !== locked.version)
    throw typed('ENKI_TAURI_CLI_UNVERIFIED', 'Installed @tauri-apps/cli does not match package-lock.json; run npm ci');
  const bins = normalizedBin(pkg.bin, pkg.name), lockedBins = normalizedBin(locked.bin, pkg.name);
  if (!bins || !lockedBins || typeof bins.tauri !== 'string')
    throw typed('ENKI_TAURI_CLI_UNVERIFIED', 'Unsafe @tauri-apps/cli bin path');
  if (JSON.stringify(bins) !== JSON.stringify(lockedBins))
    throw typed('ENKI_TAURI_CLI_UNVERIFIED', 'Installed @tauri-apps/cli bin does not match package-lock.json; run npm ci');
  const file = path.join(real, ...bins.tauri.split('/'));
  let fileStat;
  try { fileStat = fs.lstatSync(file); } catch { fileStat = undefined; }
  if (!fileStat || !fileStat.isFile() || !fs.realpathSync.native(file).startsWith(real + path.sep))
    throw typed('ENKI_TAURI_CLI_UNVERIFIED', '@tauri-apps/cli bin must be a regular file inside its package');
  return file;
}

async function withDeadline(signal, timeoutMs, label, action) {
  const controller = new AbortController(), abort = () => controller.abort(cancelled(signal));
  if (signal) signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(typed('ENKI_TAURI_DEADLINE', `${label} did not finish within ${timeoutMs} ms; the app was not compiled`)), timeoutMs);
  try { return await action(controller.signal); }
  catch (error) { throw controller.signal.aborted ? controller.signal.reason : error; }
  finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', abort); }
}

/** The CLI runs as `<this node> <tauri.js> ...args`, shell:false, inherited
 * stdio, explicit cwd/env, inside the caller's process group/Job so an older
 * builder's owned-tree termination still covers cargo/rustc. Cancellation or
 * deadline signals only the not-yet-exited primary (Node refuses to signal a
 * reaped child) and reports what is actually known about cleanup. */
function spawnCli(file, args, { repo, env, signal, timeoutMs, graceMs, spawnImpl }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(cancelled(signal)); return; }
    const child = spawnImpl(process.execPath, [file, ...args], { cwd: repo, env, shell: false, stdio: 'inherit', windowsHide: true });
    let failure, escalation, abandon, done = false;
    const finish = (outcome, value) => {
      if (done) return; done = true;
      clearTimeout(timer); clearTimeout(escalation); clearTimeout(abandon);
      if (signal) signal.removeEventListener('abort', onAbort);
      outcome(value);
    };
    const stop = reason => {
      if (failure) return; failure = reason;
      child.kill('SIGTERM');
      escalation = setTimeout(() => {
        child.kill('SIGKILL');
        abandon = setTimeout(() => finish(reject, Object.assign(failure, { cleanup: 'unknown' })), graceMs);
      }, graceMs);
    };
    const onAbort = () => stop(cancelled(signal));
    const timer = setTimeout(() => stop(typed('ENKI_TAURI_DEADLINE', `Tauri CLI did not finish within ${timeoutMs} ms`)), timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', error => finish(reject, failure || typed('ENKI_TAURI_CLI_SPAWN', `Tauri CLI did not start: ${error.message}`)));
    child.once('exit', (code, killed) => finish(failure ? reject : resolve, failure ? Object.assign(failure, { cleanup: 'primary-exited' }) : { code, signal: killed }));
  });
}

/** Executes a plan. For prepared commands the runtime is prepared (or reused
 * after verification) and re-verified BEFORE the CLI spawns; host refusal,
 * failure, deadline or cancellation means no compile. Resolves { code, signal }. */
export async function runTauriInvocation(plan, options = {}) {
  const { repo = REPO, signal, env = { ...process.env }, hostVersion = process.version, runtime, cli, spawnImpl = spawn,
    prepareTimeoutMs = 45 * 60_000, timeoutMs = 120 * 60_000, graceMs = 5_000, log = () => {} } = options;
  if (signal && signal.aborted) throw cancelled(signal);
  if (plan.prepare) {
    const problem = hostNodeProblem(hostVersion);
    if (problem) throw typed('ENKI_HOST_NODE_UNSUPPORTED', problem);
    const port = runtime || await import('./prepare.mjs');
    const identity = { platform: plan.platform, signingIdentity: env.ENKI_CODESIGN_IDENTITY || '-' };
    if (port.preparedRuntimeProblems(repo, identity).length === 0) log(`reusing the verified bundled runtime for ${plan.platform}`);
    else {
      log(`preparing the bundled agent runtime for ${plan.platform} from this source`);
      await withDeadline(signal, prepareTimeoutMs, 'Runtime preparation', inner => port.prepare({ ...identity, repo, signal: inner }));
    }
    if (signal && signal.aborted) throw cancelled(signal);
    const problems = port.preparedRuntimeProblems(repo, identity);
    if (problems.length) throw typed('ENKI_RUNTIME_UNVERIFIED', `Prepared runtime does not verify for this source (${problems.slice(0, 3).join('; ')}); refusing to build an app without it`);
  }
  const compile = buildEnv => {
    // Keep the native builder's isolated output directory explicit while avoiding
    // CARGO_TARGET_DIR in rustc's hashed environment (it changes every attempt).
    const args = compilerArguments(plan.args, env, buildEnv);
    return spawnCli(cli || resolveTauriCli(repo), args, { repo, env: buildEnv, signal, timeoutMs, graceMs, spawnImpl });
  };
  if (plan.command === 'build' && plan.prepare && env.ENKI_BUILD_CACHE_CONFIG) {
    const { withBuildCache } = await import('../build-cache/client.mjs');
    return withBuildCache({ repo, env, signal, log }, compile);
  }
  return compile(env);
}

/** CLI semantics: exit code of the Tauri CLI, 1 on refusal/failure, 130 on cancel. */
export async function main(argv, options = {}) {
  const log = options.log || (message => process.stderr.write(`tauri-entry: ${message}\n`));
  try {
    const { code, signal } = await runTauriInvocation(planTauriInvocation(argv), { ...options, log });
    if (signal) log(`Tauri CLI ended by ${signal}`);
    return code === null || code === undefined ? 1 : code;
  } catch (error) {
    log(`${error.code ? `${error.code}: ` : ''}${error.message}${error.cleanup ? ` (cleanup: ${error.cleanup})` : ''}`);
    return error.code === 'ENKI_TAURI_CANCELLED' ? 130 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // Older hosts may lack AbortController; they still reach the explicit host
  // diagnostic (prepared commands) or a plain pass-through (everything else).
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  if (controller) for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(name, () => controller.abort(new Error(`Received ${name}`)));
  process.exitCode = await main(process.argv.slice(2), { signal: controller && controller.signal });
}
