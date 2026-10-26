#!/usr/bin/env node
// Trusted build helper. Imports do not start a download, build or SDK.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLATFORMS, MANIFEST, REMOTE_LAUNCHER, buildManifest, hostPlatform, listFiles,
  promote, recoverArtifacts, rollback, safeRelative, setDirectoryFlushPort, sha256, sha256File, validateLock, verifyArtifact } from './artifact.mjs';
import { runBuildJob, trustedRunner } from './native-port.mjs';
import { bootstrapRunner, discardRunner } from './build-runner.mjs';
import { assertSdkContract } from './sdk-contract.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP = new Set(['node_modules', 'dist', 'coverage', '.vite', 'runtime-version.json', 'test', '.DS_Store', '.npmrc']);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
// Native realpath: on Windows this expands 8.3 short names, which the native
// flush port requires because it accepts only exact canonical paths.
const physical = directory => fs.realpathSync.native(directory);
function tool(paths) { const file = paths.find(p => path.isAbsolute(p) && fs.existsSync(p)); if (!file) throw new Error(`Trusted tool missing: ${paths.join(', ')}`); return file; }

let windowsRunner;
/** Own Unix process group, bounded diagnostics and deadline. Windows runs every
 * job through the trusted native runner (suspended start, kill-on-close Job
 * assigned before resume); there is no unowned spawn fallback. `runner` is a
 * bootstrap receipt ({ path, sha256 }), re-verified before every job. */
export function run(program, argv, { cwd, env, timeoutMs = 600_000, signal, capture = false, runner = windowsRunner } = {}) {
  if (!path.isAbsolute(program)) return Promise.reject(new Error('Executable must be absolute'));
  if (process.platform === 'win32') {
    if (!env) return Promise.reject(new Error('Windows build jobs require an explicit environment'));
    let file; try { file = trustedRunner(runner); } catch (error) { return Promise.reject(error); }
    return runBuildJob(file, { program, argv, cwd, env, timeoutMs, capture }, { signal });
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('Build cancelled')); return; }
    const child = spawn(program, argv, { cwd, env, shell: false, detached: true, windowsHide: true,
      stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'] });
    let failure, output = '', length = 0, escalation, reaped = false, complete;
    const terminate = reason => {
      failure ??= reason;
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') failure = error; }
      escalation ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} escalation = undefined; if (reaped) complete(); }, 1000);
    };
    const abort = () => terminate(signal.reason ?? new Error('Build cancelled'));
    const timer = setTimeout(() => terminate(new Error(`Build timed out: ${path.basename(program)}`)), timeoutMs);
    const read = chunk => { length += chunk.length; if (length > 1024 * 1024) terminate(new Error('Build output exceeds 1 MiB')); else output += chunk.toString('utf8'); };
    child.stdout?.on('data', read); child.stderr?.on('data', read);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => { failure = error; });
    child.once('close', (code, killed) => {
      reaped = true;
      complete = () => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure || code !== 0) reject(failure ?? new Error(`${path.basename(program)} exited ${code ?? killed}: ${output.slice(-2000)}`)); else resolve(output);
      };
      if (!escalation) complete();
    });
  });
}
/** Explicit private npm configuration/cache; never repurpose HOME or USERPROFILE. */
export function buildEnvironment(nodeHome, work, platform = process.platform, source = process.env) {
  const cache = path.join(work, 'npm-cache'), devdir = path.join(work, 'node-gyp'), config = path.join(work, 'empty-user.npmrc'), globalConfig = path.join(work, 'empty-global.npmrc');
  for (const directory of [cache, devdir]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(config, '', { mode: 0o600 }); fs.writeFileSync(globalConfig, '', { mode: 0o600 });
  // Windows system locations (not user configs or credentials) are needed by
  // cmd.exe, tar.exe and node-gyp's Visual Studio discovery.
  const windowsSystem = platform === 'win32' ? ['SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS'] : [];
  const env = {}; for (const key of ['HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', ...windowsSystem]) if (source[key] !== undefined) env[key] = source[key];
  const bin = platform === 'win32' ? nodeHome : path.join(nodeHome, 'bin');
  env.PATH = platform === 'win32' ? [bin, path.join(source.SystemRoot ?? 'C:\\Windows', 'System32')].join(';') : [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  return Object.assign(env, { TMPDIR: work, TMP: work, TEMP: work,
    npm_config_userconfig: config, npm_config_globalconfig: globalConfig, npm_config_cache: cache,
    npm_config_registry: 'https://registry.npmjs.org/', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    npm_config_nodedir: nodeHome, npm_config_devdir: devdir, npm_config_fetch_retries: '2', npm_config_fetch_timeout: '120000', npm_config_fetch_retry_maxtimeout: '10000' });
}
export async function download(url, file, expected, options = {}) {
  const { signal, retryDelayMs = 500 } = options;
  for (let attempt = 0; ; attempt++) {
    try { return await downloadOnce(url, file, expected, options); }
    catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const transient = error instanceof TypeError || error.retryable === true || error.message === 'Download timed out';
      if (!transient || attempt >= 2) {
        throw new Error(`Не удалось скачать ${path.basename(file)} с ${new URL(url).hostname}: ${error.message}${transient ? '. Проверьте подключение и повторите сборку; данные приложения сохранены.' : ''}`, { cause: error });
      }
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Download cancelled')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, retryDelayMs * (attempt + 1));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
}
async function downloadOnce(url, file, expected, { signal, timeoutMs = 120_000, maxBytes = 160 * 1024 * 1024, fetcher = fetch } = {}) {
  if (!digest(expected) || new URL(url).protocol !== 'https:') throw new Error('Download requires HTTPS and reviewed SHA256');
  if (fs.existsSync(file) && sha256File(file) === expected) return;
  const partial = `${file}.${crypto.randomUUID()}.part`, controller = new AbortController(), abort = () => controller.abort(signal.reason);
  if (signal?.aborted) throw signal.reason ?? new Error('Download cancelled'); signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Download timed out')), timeoutMs); let fd;
  try {
    const response = await fetcher(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || !response.body || response.url && new URL(response.url).protocol !== 'https:') throw Object.assign(new Error(`Download failed: HTTP ${response.status}`), { retryable: response.status === 429 || response.status >= 500 });
    const advertised = response.headers.get('content-length');
    if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > maxBytes)) throw new Error('Download exceeds byte limit');
    fd = fs.openSync(partial, 'wx', 0o600); let bytes = 0; const hash = crypto.createHash('sha256');
    for await (const chunk of response.body) {
      if (controller.signal.aborted) throw controller.signal.reason; bytes += chunk.length; if (bytes > maxBytes) throw new Error('Download exceeds byte limit');
      hash.update(chunk); fs.writeFileSync(fd, chunk);
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    if (hash.digest('hex') !== expected) throw new Error(`Checksum mismatch: ${path.basename(file)}`);
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(partial, file);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (fd !== undefined) fs.closeSync(fd); fs.rmSync(partial, { force: true }); }
}
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Source contains a link: ${source}`);
    if (entry.isDirectory()) copyTree(source, target); else if (entry.isFile()) fs.copyFileSync(source, target); else throw new Error('Source contains a special file');
  }
}
const sh = value => `'${value.replaceAll("'", "'\\''")}'`;
const wrapperPath = value => { if (!safeRelative(value)) throw new Error('Unsafe package CLI path'); return value; };
/** POSIX wrapper: every artifact-relative suffix is one literal single-quoted
 * word composed after "$base", so $, `, \, ", ' and globs are never evaluated. */
export function posixWrapper(up, nodeRelative, relative, isNode) {
  if (up !== '.' && !/^\.\.(\/\.\.)*$/.test(up)) throw new Error('Unsafe wrapper ancestor');
  const at = value => `"$base"${sh('/' + wrapperPath(value))}`;
  const command = isNode ? `${at(nodeRelative)} ${at(relative)}` : at(relative);
  return `#!/bin/sh\nset -eu\ncase "$0" in */*) here=\${0%/*} ;; *) here=. ;; esac\nbase=$(CDPATH= cd -- "$here"/${sh(up)} && pwd -P)\nexec ${command} "$@"\n`;
}
/** cmd.exe wrapper: delayed expansion is explicitly disabled (so ! is literal
 * even under /V:ON or registry defaults) and % is doubled for the percent phase.
 * Paths are always inside double quotes; safeRelative already rejects ", control
 * characters and wildcards, which cannot be quoted safely in batch files. */
export function windowsWrapper(up, nodeRelative, relative, isNode) {
  if (up !== '.' && !/^\.\.(\/\.\.)*$/.test(up)) throw new Error('Unsafe wrapper ancestor');
  const cmd = value => wrapperPath(value).replaceAll('/', '\\').replaceAll('%', '%%');
  const at = value => `"%base%\\${cmd(value)}"`;
  const command = isNode ? `${at(nodeRelative)} ${at(relative)}` : at(relative);
  return `@ECHO OFF\r\nSETLOCAL EnableExtensions DisableDelayedExpansion\r\nFOR %%I IN ("%~dp0${up.replaceAll('/', '\\')}") DO SET "base=%%~fI"\r\n${command} %*\r\n`;
}
/** Retain package CLI semantics with relocatable wrappers. JS scripts remain
 * at their original package path so import.meta-relative assets still resolve. */
export function materializeBinLinks(root, nodeRelative) {
  root = physical(root);
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name); if (entry.isDirectory()) { visit(full); continue; } if (!entry.isSymbolicLink()) continue;
      if (!['bin', '.bin'].includes(path.basename(directory))) throw new Error(`Unexpected package link: ${path.relative(root, full)}`);
      const target = fs.realpathSync(full); if (!target.startsWith(root + path.sep) || !fs.statSync(target).isFile()) throw new Error('Package bin escapes artifact');
      const relative = path.relative(root, target).split(path.sep).join('/'); if (!safeRelative(relative)) throw new Error('Unsafe package CLI path');
      const head = Buffer.alloc(160), fd = fs.openSync(target, 'r'); let size;
      try { size = fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
      const isNode = /\.[cm]?js$/.test(target) || /^#![^\n]*\bnode\b/.test(head.subarray(0, size).toString());
      const up = path.relative(directory, root).split(path.sep).join('/') || '.';
      // Generate both before unlinking so an unsafe path fails closed with the link intact.
      const posix = posixWrapper(up, nodeRelative, relative, isNode), windows = windowsWrapper(up, nodeRelative, relative, isNode);
      fs.unlinkSync(full); fs.writeFileSync(full, posix, { mode: 0o755 });
      fs.writeFileSync(full + '.cmd', windows, { mode: 0o755 });
    }
  }; visit(root);
}
async function extract(archive, into, env, signal) {
  fs.mkdirSync(into, { recursive: true, mode: 0o700 });
  const tar = process.platform === 'win32' ? tool([path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')]) : tool(['/usr/bin/tar', '/bin/tar']);
  const listing = await run(tar, ['-tf', archive], { env, signal, capture: true, timeoutMs: 30_000 });
  for (const name of listing.split(/\r?\n/).filter(Boolean)) if (!safeRelative(name.replace(/\/$/, ''))) throw new Error(`Unsafe archive path: ${name}`);
  await run(tar, ['-xf', archive, '-C', into], { env, signal, timeoutMs: 60_000 });
  const names = fs.readdirSync(into); if (names.length !== 1 || !fs.statSync(path.join(into, names[0])).isDirectory()) throw new Error('Unexpected authenticated archive layout');
  return path.join(into, names[0]);
}
async function stageTools(lock, platform, app, cache, work, env, signal) {
  const bin = path.join(app, 'sdk-profile/bin'), licenses = path.join(app, 'sdk-profile/licenses');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(licenses, { recursive: true });
  for (const name of ['rg', 'fd']) {
    const spec = lock.tools?.[name]?.artifacts?.[platform];
    if (!spec || !digest(spec.sha256) || !safeRelative(spec.file) || spec.file.includes('/') || !safeRelative(spec.binary)) throw new Error(`No reviewed ${name} artifact for ${platform}`);
    const source = name === 'rg' ? 'https://github.com/BurntSushi/ripgrep/releases/download/' : 'https://github.com/sharkdp/fd/releases/download/';
    if (typeof spec.url !== 'string' || !spec.url.startsWith(source) || new URL(spec.url).search || !spec.url.endsWith('/' + spec.file)) throw new Error('Tool URL does not match primary release pin');
    const archive = path.join(cache, spec.file); await download(spec.url, archive, spec.sha256, { signal, maxBytes: 40 * 1024 * 1024 });
    const extracted = await extract(archive, path.join(work, `extract-${name}`), env, signal), sourceFile = path.join(extracted, ...spec.binary.split('/'));
    if (!fs.lstatSync(sourceFile).isFile()) throw new Error('Tool is not a regular file');
    const target = path.join(bin, name + (platform.startsWith('win32') ? '.exe' : '')); fs.copyFileSync(sourceFile, target); fs.chmodSync(target, 0o755);
    let count = 0; for (const file of fs.readdirSync(extracted)) if (/^(LICENSE|COPYING|UNLICENSE|NOTICE)/i.test(file) && fs.lstatSync(path.join(extracted, file)).isFile()) { fs.copyFileSync(path.join(extracted, file), path.join(licenses, `${name}-${file}`)); count++; }
    if (!count) throw new Error(`Tool license missing: ${name}`);
  }
}
function pruneForeignNative(app, platform) {
  const prebuilds = path.join(app, 'node_modules/node-pty/prebuilds');
  if (fs.existsSync(prebuilds)) for (const item of fs.readdirSync(prebuilds)) if (item !== platform) fs.rmSync(path.join(prebuilds, item), { recursive: true });
  if (!platform.startsWith('win32')) fs.rmSync(path.join(app, 'node_modules/node-pty/third_party/conpty'), { recursive: true, force: true });
  const native = path.join(app, 'node_modules/@earendil-works/pi-tui/native');
  if (fs.existsSync(native)) for (const item of ['darwin', 'win32']) if (!platform.startsWith(item)) fs.rmSync(path.join(native, item), { recursive: true, force: true });
}
/** npm prune and official Node archives may contain empty package directories.
 * Normalize the owned, quiescent app dependencies and bundled Node tree before
 * signing/inventory. Validate both bounded trees before removing anything;
 * never follow links or remove files/nonempty dirs. */
export function pruneEmptyPackageDirectories(artifact, { maxEntries = 200_000, maxDepth = 64 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 200_000 ||
      !Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 64) throw new Error('Invalid package cleanup bounds');
  const root = path.resolve(artifact), packages = path.join(root, 'app/node_modules'), directories = new Map(), empty = [];
  const roots = new Set([packages]);
  const inspect = directory => {
    const stat = fs.lstatSync(directory, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() || physical(directory) !== directory) throw new Error('Package cleanup requires physical directories');
    return stat;
  };
  const unchanged = directory => {
    const stat = inspect(directory), before = directories.get(directory);
    if (!before || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('Package directory changed during cleanup');
  };
  for (const directory of [root, path.join(root, 'app')]) directories.set(directory, inspect(directory));
  const bundledNode = path.join(root, 'node');
  try { inspect(bundledNode); roots.add(bundledNode); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let entries = 0;
  const walk = (directory, depth) => {
    if (depth > maxDepth) throw new Error('Package cleanup exceeds depth limit');
    directories.set(directory, inspect(directory));
    let removable = true;
    const dir = fs.opendirSync(directory);
    try {
      let entry;
      while ((entry = dir.readSync()) !== null) {
        if (++entries > maxEntries) throw new Error('Package cleanup exceeds entry limit');
        const full = path.join(directory, entry.name), stat = fs.lstatSync(full);
        if (!safeRelative(path.relative(root, full).split(path.sep).join('/'))) throw new Error('Unsafe package cleanup path');
        if (stat.isSymbolicLink()) throw new Error('Package cleanup refuses symbolic links');
        if (stat.isDirectory()) { if (!walk(full, depth + 1)) removable = false; }
        else if (stat.isFile()) removable = false;
        else throw new Error('Package cleanup refuses special files');
      }
    } finally { dir.closeSync(); }
    unchanged(directory);
    if (removable && !roots.has(directory)) empty.push(directory);
    return removable;
  };
  for (const directory of roots) walk(directory, 0);
  // Postorder, non-recursive removal. Recheck every owned ancestor's identity;
  // a newly nonempty directory makes rmdir fail rather than deleting its files.
  for (const directory of empty) {
    for (let ancestor = directory; ; ancestor = path.dirname(ancestor)) {
      unchanged(ancestor);
      if (ancestor === root) break;
    }
    fs.rmdirSync(directory);
  }
  return empty.map(directory => path.relative(root, directory).split(path.sep).join('/'));
}
/** Hardened ad-hoc binaries have no team identity to share with their native
 * addons. Only this exact local signing mode gets the Node-specific exception;
 * Developer ID keeps library validation and signs every addon with its team. */
export function runtimeNodeEntitlements(repo, identity) {
  return path.join(repo, 'src-tauri', identity === '-' ? 'runtime-node-adhoc.entitlements' : 'runtime-node.entitlements');
}
/** The pinned macOS prebuild ships spawn-helper without an executable bit.
 * Normalize only owned physical helpers, before signing. Libraries stay as-is. */
export function normalizePtyHelpers(app, platform) {
  if (platform !== 'darwin-arm64') return;
  const base = path.join(app, 'node_modules/node-pty');
  if (physical(base) !== base) throw new Error('Packaged node-pty directory is not physical');
  let found = false;
  for (const suffix of ['build/Release', 'build/Debug', `prebuilds/${platform}`]) {
    const directory = path.join(base, ...suffix.split('/')), file = path.join(directory, 'spawn-helper');
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || physical(directory) !== directory || physical(file) !== file) throw new Error('Packaged PTY helper is not a physical file');
    fs.chmodSync(file, 0o755); found = true;
  }
  if (!found) throw new Error('Packaged PTY spawn-helper is missing');
}
async function sign(artifact, platform, identity, repo, env, signal) {
  if (platform !== 'darwin-arm64') return;
  const magic = new Set(['feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca']);
  for (const relative of listFiles(artifact)) {
    const file = path.join(artifact, ...relative.split('/')), fd = fs.openSync(file, 'r'), head = Buffer.alloc(4);
    try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); } if (!magic.has(head.toString('hex'))) continue;
    const extra = relative === 'node/bin/node' ? ['--entitlements', runtimeNodeEntitlements(repo, identity)] : [];
    await run('/usr/bin/codesign', ['--force', '--timestamp=none', '--options', 'runtime', ...extra, '--sign', identity, file], { env, signal, timeoutMs: 60_000 });
  }
}
/** Test the actual final interpreter and its own packaged native module after
 * pruning and signing. A pre-sign build-host import cannot detect a signing
 * policy rejection. Refusal leaves staging unpromoted, preserving current. */
export async function verifyPackagedNodePty(artifact, nodeRelative, { env, signal } = {}) {
  if (!safeRelative(nodeRelative)) throw new Error('Unsafe packaged interpreter path');
  const app = path.join(artifact, 'app');
  const probe = `import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';
const app=fs.realpathSync.native(process.cwd());const expected=path.join(app,'node_modules/node-pty');const root=fs.realpathSync.native(expected);
if(root!==expected)throw Error('Packaged node-pty directory is not physical');
const require=createRequire(path.join(app,'package.json'));const entry=fs.realpathSync.native(require.resolve('node-pty'));
if(!entry.startsWith(root+path.sep))throw Error('node-pty resolved outside its packaged directory');
const pty=require(entry);if(typeof pty.spawn!=='function')throw Error('Invalid packaged node-pty ABI');
if(process.platform==='darwin'){const native=require(path.join(root,'lib/utils.js')).loadNativeModule('pty');
const helper=path.resolve(path.dirname(entry),native.dir,'spawn-helper');
if(!helper.startsWith(root+path.sep)||!fs.lstatSync(helper).isFile()||fs.realpathSync.native(helper)!==helper)throw Error('Packaged PTY helper escaped');
fs.accessSync(helper,fs.constants.X_OK);}`;
  await run(path.join(artifact, ...nodeRelative.split('/')), ['--input-type=module', '-e', probe], { cwd: app, env, signal, capture: true, timeoutMs: 30_000 });
}
/** Windows: compile the native runner from THIS authenticated source into a
 * fresh private directory, then bind it for jobs and durable directory flushes
 * before any artifact recovery may rename directories. An older installed Enki
 * driving the update needs no runner of its own. Toolchain absence is a typed,
 * explicit failure; there is no fallback. Returns a release function. */
async function configureNativePort(repo, signal) {
  if (process.platform !== 'win32') return () => {};
  const identity = await bootstrapRunner({ repo, base: path.join(repo, 'src-tauri', 'target', 'enki-build-runner'), signal });
  windowsRunner = identity; setDirectoryFlushPort(trustedRunner(identity));
  return () => { setDirectoryFlushPort(undefined); windowsRunner = undefined; discardRunner(identity); };
}
const RECEIPT = 'preparation-receipt.json';
const PREPARATION_CODE = ['scripts/runtime/prepare.mjs', 'scripts/runtime/artifact.mjs', 'src-tauri/runtime-node.entitlements', 'src-tauri/runtime-node-adhoc.entitlements'];
/** Digest of everything that determines the prepared artifact's bytes: the
 * staged resource trees (exact copyTree SKIP semantics; links/special files
 * refused), the preparation code, Mac runtime entitlements and the options. */
export function preparationDigest(repo, { platform, remote = false, signingIdentity = '-' }) {
  const root = physical(repo), lines = [JSON.stringify({ schema: 1, platform, remote: remote === true, signingIdentity })];
  const add = relative => lines.push(`${relative}\0${sha256File(path.join(root, ...relative.split('/')))}`);
  const walk = relative => {
    const entries = fs.readdirSync(path.join(root, ...relative.split('/')), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child); else if (entry.isFile()) add(child); else throw new Error(`Runtime source is not a regular file: ${child}`);
    }
  };
  for (const name of ['agent', 'shared', 'browser', 'pi']) walk(`src-tauri/resources/${name}`);
  for (const relative of PREPARATION_CODE) add(relative);
  return sha256(lines.join('\n'));
}
/** Why the promoted runtime cannot be reused for this exact source and options
 * ([] = reusable). Evidence is the receipt bound to the current manifest SHA256,
 * freshly recomputed input hashes and full artifact verification; an environment
 * flag or a mere directory is never evidence. */
export function preparedRuntimeProblems(repo, { platform, remote = false, signingIdentity = '-' }) {
  const out = path.join(repo, 'src-tauri/target/enki-agent');
  let owned, receipt;
  try {
    owned = physical(out); recoverArtifacts(owned);
    const file = path.join(owned, RECEIPT); if (!fs.lstatSync(file).isFile()) throw new Error('receipt is not a regular file');
    receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { return [`no usable preparation receipt (${error.code ?? error.message})`]; }
  const problems = [];
  if (!receipt || receipt.schema !== 1 || !digest(receipt.manifestSha256) || !digest(receipt.inputs)) return ['invalid preparation receipt'];
  if (receipt.platform !== platform) problems.push('prepared for another platform');
  if (receipt.remote !== (remote === true)) problems.push('prepared with another remote option');
  if (receipt.signingIdentity !== signingIdentity) problems.push('prepared with another signing identity');
  if (problems.length) return problems;
  let inputs; try { inputs = preparationDigest(repo, { platform, remote, signingIdentity }); } catch (error) { return [error.message]; }
  if (receipt.inputs !== inputs) return ['runtime sources changed since preparation'];
  return verifyArtifact(path.join(owned, 'current'), { manifestSha256: receipt.manifestSha256 });
}
function writeReceipt(owned, receipt) {
  const temporary = path.join(owned, `.${RECEIPT}.${crypto.randomUUID()}.tmp`);
  try { fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, path.join(owned, RECEIPT)); }
  finally { fs.rmSync(temporary, { force: true }); }
}
export async function prepare({ platform, remote = false, repo = REPO, signal, signingIdentity = '-' }) {
  if (!PLATFORMS.includes(platform) || hostPlatform() !== platform) throw new Error('Preparation must run on its exact target platform');
  // Every SDK/Node pin agrees with the reviewed contract before anything is built.
  assertSdkContract(repo);
  const release = await configureNativePort(repo, signal);
  try { return await prepareWithPort({ platform, remote, repo, signal, signingIdentity }); } finally { release(); }
}
async function prepareWithPort({ platform, remote, repo, signal, signingIdentity }) {
  const resources = path.join(repo, 'src-tauri/resources'), source = path.join(resources, 'agent');
  const lock = JSON.parse(fs.readFileSync(path.join(source, 'runtime-lock.json'), 'utf8')), pin = validateLock(lock, platform);
  if (!fs.existsSync(path.join(source, 'package-lock.json'))) throw new Error('Reviewed dependency lock missing');
  // Bound BEFORE staging: a source change during preparation fails reuse checks.
  const inputs = preparationDigest(repo, { platform, remote, signingIdentity });
  const out = path.join(repo, 'src-tauri/target/enki-agent'); fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const owned = physical(out); recoverArtifacts(owned); const cache = path.join(owned, 'cache'); fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const work = fs.mkdtempSync(path.join(owned, 'work-'));
  try {
    const archive = path.join(cache, pin.file); await download(new URL(pin.file, lock.node.source).href, archive, pin.sha256, { signal });
    const nodeHome = await extract(archive, path.join(work, 'node-extract'), buildEnvironment(path.dirname(process.execPath), work), signal);
    const node = path.join(nodeHome, ...pin.binary.split('/')), env = buildEnvironment(nodeHome, work);
    const npm = path.join(nodeHome, platform === 'win32-x64' ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js');
    const staging = path.join(work, 'resources'); for (const name of ['agent', 'shared', 'browser', 'pi']) copyTree(path.join(resources, name), path.join(staging, name));
    const app = path.join(staging, 'agent');
    await run(node, [npm, 'ci', '--ignore-scripts'], { cwd: app, env, signal });
    // Exact reviewed lifecycle allowlist; pinned Node headers and PATH.
    await run(node, [npm, 'rebuild', 'node-pty', '--foreground-scripts'], { cwd: app, env, signal });
    await run(node, ['--input-type=module', '-e', "import pty from 'node-pty'; if(typeof pty.spawn!=='function')throw Error('Invalid node-pty ABI')"], { cwd: app, env, signal, timeoutMs: 30_000 });
    await run(node, ['build.mjs'], { cwd: app, env, signal });
    await run(node, [npm, 'prune', '--omit=dev', '--ignore-scripts'], { cwd: app, env, signal }); pruneForeignNative(app, platform);
    const info = JSON.parse(fs.readFileSync(path.join(app, 'runtime-version.json'), 'utf8')), version = `${lock.sdk.version}-${info.version}`, artifact = path.join(work, 'artifact');
    fs.mkdirSync(path.join(artifact, 'app'), { recursive: true }); fs.renameSync(nodeHome, path.join(artifact, 'node'));
    for (const name of ['package.json', 'package-lock.json', 'runtime-lock.json', 'runtime-version.json']) fs.copyFileSync(path.join(app, name), path.join(artifact, 'app', name));
    for (const name of ['dist', 'node_modules']) fs.renameSync(path.join(app, name), path.join(artifact, 'app', name));
    await stageTools(lock, platform, path.join(artifact, 'app'), cache, work, env, signal);
    for (const name of ['include', 'share', 'README.md', 'CHANGELOG.md']) fs.rmSync(path.join(artifact, 'node', name), { recursive: true, force: true });
    const nodeRelative = `node/${pin.binary}`; materializeBinLinks(artifact, nodeRelative);
    if (remote) { if (platform !== 'linux-x64') throw new Error('Remote tarball requires Linux x64'); fs.mkdirSync(path.join(artifact, 'bin')); fs.writeFileSync(path.join(artifact, 'bin/enki-runtime'), REMOTE_LAUNCHER, { mode: 0o755 }); }
    pruneEmptyPackageDirectories(artifact);
    normalizePtyHelpers(path.join(artifact, 'app'), platform);
    await sign(artifact, platform, signingIdentity, repo, env, signal);
    await verifyPackagedNodePty(artifact, nodeRelative, { env, signal });
    const manifest = buildManifest(artifact, { version, contract: lock.contract, node: nodeRelative, entry: 'app/dist/main.js' }); fs.writeFileSync(path.join(artifact, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
    const errors = verifyArtifact(artifact); if (errors.length) throw new Error(errors.slice(0, 5).join('; '));
    if (remote) {
      const dist = path.join(owned, 'dist'); fs.mkdirSync(dist, { recursive: true }); const tarball = path.join(dist, `enki-runtime-linux-x64-${version}.tar.gz`);
      await run(tool(['/usr/bin/tar', '/bin/tar']), ['--owner=0', '--group=0', '--numeric-owner', '--sort=name', '--mtime=@0', '-czf', tarball, '-C', work, 'artifact'], { env, signal });
      fs.writeFileSync(tarball + '.sha256', `${sha256File(tarball)}  ${path.basename(tarball)}\n`);
    }
    const current = promote(owned, artifact);
    // Written only after a verified promotion and bound to its manifest bytes; a
    // crash before this line, a rollback or a later promotion invalidates reuse.
    writeReceipt(owned, { schema: 1, platform, remote: remote === true, signingIdentity, inputs, version, manifestSha256: sha256File(path.join(current, MANIFEST)) });
    return { version, current };
  } finally { recoverArtifacts(owned); fs.rmSync(work, { recursive: true, force: true }); }
}
/** `npm run runtime:prepare` (through prepare-entry.mjs, which checks the host
 * Node first). Resolves the exit code. */
export async function main(argv) {
  const out = path.join(REPO, 'src-tauri/target/enki-agent');
  try {
    if (argv.includes('--rollback') || argv.includes('--verify')) {
      const release = await configureNativePort(REPO);
      try {
        if (argv.includes('--rollback')) console.log(rollback(physical(out)));
        else { recoverArtifacts(physical(out)); const errors = verifyArtifact(path.join(physical(out), 'current')); if (errors.length) throw new Error(errors.join('\n')); console.log('Runtime artifact verifies'); }
      } finally { release(); }
    } else { const index = argv.indexOf('--platform'); console.log(await prepare({ platform: index < 0 ? undefined : argv[index + 1], remote: argv.includes('--remote-tarball'), signingIdentity: process.env.ENKI_CODESIGN_IDENTITY || '-' })); }
    return 0;
  } catch (error) { console.error(`runtime:prepare: ${error.message}`); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
