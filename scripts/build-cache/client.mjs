// Source-owned optional acceleration for authenticated native builds. No Hub
// device/admin key enters this process: only a device-scoped, four-hour lease.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { download } from '../runtime/prepare.mjs';
const exec = promisify(execFile);
const LOCK = JSON.parse(fs.readFileSync(new URL('./sccache-lock.json', import.meta.url)));
const MAX = 64 * 1024 * 1024;
const keyPattern = /^\/{1,2}(?:[a-f0-9]\/){0,3}[a-f0-9]{64}$/;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function descriptor(value, host = `${process.platform}-${process.arch}`) {
  const url = new URL(value.endpoint);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash
      || value.platform !== host || !/^[\w-]{32,128}$/.test(value.token ?? '')
      || typeof value.certificate !== 'string' || value.certificate.length > 32768) throw Error('Invalid cache capability');
  return { endpoint: url.origin, platform: host, token: value.token, certificate: value.certificate };
}

function request(config, method, suffix, bytes, signal) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api/build-cache/objects/${config.platform}${suffix}`, config.endpoint);
    const headers = { Authorization: `Bearer ${config.token}` };
    if (bytes) headers['Content-Length'] = String(bytes.length);
    const req = https.request(url, { method, headers, signal, ...(config.certificate ? { ca: config.certificate } : {}) }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > MAX) res.destroy(Error('Cache response too large')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (method === 'GET' && res.statusCode === 200 && (hash(body) !== res.headers['x-content-sha256'] || body.length !== Number(res.headers['content-length']))) reject(Error('Cache digest mismatch'));
        else resolve({ code: res.statusCode, body });
      });
    });
    const timer = setTimeout(() => req.destroy(Error('Cache deadline')), 8000);
    req.on('error', reject); req.on('close', () => clearTimeout(timer));
    req.end(bytes);
  });
}

/** Private loopback adapter preserves the Hub certificate and verifies object
 * digests before handing bytes to the compiler. Never redirects or logs tokens.
 * Two faults trip a circuit breaker for this build; cache misses are normal. */
export async function cacheProxy(config, { signal, transport = request, observe = () => {} } = {}) {
  let failures = 0, active = 0, hits = 0, misses = 0, writes = 0;
  const localToken = crypto.randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    const reply = (code, body = Buffer.alloc(0)) => { if (!res.destroyed) { res.writeHead(code, { 'Content-Length': body.length, Connection: 'close' }); res.end(body); } };
    observe({method:req.method,path:req.url,authorized:req.headers.authorization===`Bearer ${localToken}`});
    if (req.headers.authorization !== `Bearer ${localToken}` || !keyPattern.test(req.url ?? '') || !['GET', 'PUT'].includes(req.method)) return reply(403);
    if (failures >= 2 || active >= 2) return reply(req.method === 'GET' ? 404 : 503);
    active++;
    try {
      let body;
      if (req.method === 'PUT') {
        const size = Number(req.headers['content-length']);
        if (!Number.isSafeInteger(size) || size <= 0 || size > MAX || req.headers['transfer-encoding']) return reply(413);
        const parts = []; let received = 0;
        for await (const chunk of req) { received += chunk.length; if (received > size) throw Error('Oversized upload'); parts.push(chunk); }
        if (received !== size) throw Error('Truncated upload'); body = Buffer.concat(parts);
      }
      const result = await transport(config, req.method, req.url.replace(/^\/+/u, "/"), body, signal);
      if (result.code >= 400 && result.code !== 404) failures++;
      if (req.method === 'GET') { if (result.code === 200) hits++; else misses++; }
      else if (result.code === 201) writes++;
      reply(result.code, result.body);
    } catch { failures++; reply(req.method === 'GET' ? 404 : 503); }
    finally { active--; }
  });
  server.requestTimeout = 12000; server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { endpoint: `http://127.0.0.1:${server.address().port}/`, token: localToken,
    stats: () => ({ state: failures >= 2 ? 'unavailable' : 'active', hits, misses, writes }),
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

async function binary(root, signal, toolArchive) {
  const spec = LOCK.platforms[`${process.platform}-${process.arch}`];
  if (!spec) throw Error('Unsupported compiler cache platform');
  const archive = path.join(root, 'sccache.tar.gz');
  if (toolArchive) fs.copyFileSync(toolArchive, archive);
  // Optional acceleration must not delay an ordinary build for several minutes.
  const deadline = AbortSignal.timeout(120000);
  await download(spec.url, archive, spec.sha256, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline, timeoutMs: 90000, maxBytes: 20 * 1024 * 1024 });
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
  await exec(tar, ['-xf', archive, '-C', root], { signal, timeout: 30000, maxBuffer: 65536, windowsHide: true });
  const file = path.join(root, ...spec.binary.split('/'));
  if (!fs.lstatSync(file).isFile() || !fs.realpathSync.native(file).startsWith(fs.realpathSync.native(root) + path.sep)) throw Error('Invalid pinned cache tool');
  return file;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return String(port);
}
function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

/** CLI compilation runs once. A missing cache affects speed, never correctness
 * or availability. The cache daemon is our own foreground child; no global
 * sccache server is started, stopped, reconfigured or left behind. */
export async function withBuildCache({ repo, env, signal, log = () => {}, observe, toolArchive }, action) {
  const configFile = env.ENKI_BUILD_CACHE_CONFIG;
  if (!configFile || env.RUSTC_WRAPPER) return action(env);
  let proxy, child, exit, root, timer, config; let phase = 'configuration', enabled = false;
  const statusFile = path.join(repo, '.enki-build-cache-status.json');
  const status = value => { try { const tmp = statusFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(tmp, statusFile); } catch { /* Diagnostics cannot fail a build. */ } };
  let buildEnv = env;
  try {
    try {
      if (!fs.lstatSync(configFile).isFile() || fs.statSync(configFile).size > 65536) throw Error('Invalid capability file');
      config = descriptor(JSON.parse(fs.readFileSync(configFile, 'utf8')));
      root = fs.mkdtempSync(path.join(fs.realpathSync.native(repo), '.enki-compiler-cache-'));
      phase = 'download'; const tool = await binary(root, signal, toolArchive);
      proxy = await cacheProxy(config, { signal, observe });
      const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('SCCACHE_') && !['ENKI_BUILD_CACHE_CONFIG','RUSTC_WRAPPER','RUSTC_WORKSPACE_WRAPPER','CARGO_TARGET_DIR'].includes(k)));
      const conf = path.join(root, 'config'); fs.writeFileSync(conf, '', { mode: 0o600 });
      buildEnv = { ...clean, RUSTC_WRAPPER: tool, CARGO_INCREMENTAL: '0', SCCACHE_CONF: conf,
        SCCACHE_CACHED_CONF: path.join(root, 'cached-config'), SCCACHE_SERVER_PORT: await freePort(),
        SCCACHE_NO_DAEMON: '1', SCCACHE_CLIENT_SIDE: '1', SCCACHE_IDLE_TIMEOUT: '300',
        SCCACHE_SKIP_CACHE_CHECK: '1', SCCACHE_CACHE_READ_TIMEOUT_SECS: '10', SCCACHE_IGNORE_SERVER_IO_ERROR: '1',
        SCCACHE_BASEDIRS: [repo, env.CARGO_HOME || path.join(env.HOME || env.USERPROFILE, '.cargo')].join(path.delimiter),
        SCCACHE_WEBDAV_ENDPOINT: proxy.endpoint, SCCACHE_WEBDAV_TOKEN: proxy.token,
        SCCACHE_WEBDAV_DISABLE_CREATE_DIR: 'true', SCCACHE_WEBDAV_KEY_PREFIX: '/', SCCACHE_WEBDAV_RW_MODE: 'READ_WRITE' };
      phase = 'daemon'; child = spawn(tool, ['--start-server'], { cwd: repo, env: buildEnv, windowsHide: true, stdio: ['ignore', 'ignore', observe ? 'pipe' : 'ignore'] });
      let daemonError = '';
      child.stderr?.on('data', bytes => { if (daemonError.length < 4096) daemonError += bytes.toString().slice(0, 4096 - daemonError.length); });
      let ended = false; exit = new Promise(resolve => { child.once('error', () => { ended = true; resolve(); }); child.once('exit', () => { ended = true; resolve(); }); });
      let ready = false;
      const readyDeadline = Date.now() + 10000;
      while (Date.now() < readyDeadline && !ended && !signal?.aborted) {
        await pause(100);
        if (ended) break;
        try { await exec(tool, ['--show-stats'], { env: buildEnv, timeout: 500, windowsHide: true, maxBuffer: 65536 }); ready = !ended; if (ready) break; } catch {}
      }
      if (!ready) { observe?.({phase, exitCode:child.exitCode, signal:child.signalCode, error:daemonError.replaceAll(proxy.token,'[redacted]').replaceAll(config.token,'[redacted]')}); throw Error('Cache daemon not ready'); }
      enabled = true;
      status(proxy.stats()); timer = setInterval(() => status(proxy.stats()), 2000); timer.unref();
      log('Кэш компилятора подключён к Hub; совпадающие библиотеки будут загружены автоматически.');
    } catch (error) {
      observe?.({ phase, error: error.message });
      log(`Кэш: ${phase} (${error.code ?? error.name}).`);
      if (signal?.aborted) throw signal.reason;
      buildEnv = env; status({ state: 'unavailable' }); log('Кэш компилятора недоступен. Продолжаю обычную сборку.');
    }
    return await action(buildEnv);
  } finally {
    clearInterval(timer);
    // Cargo/CLI has settled before this child is stopped. Killing this exact
    // child never sends --stop-server to somebody else's daemon.
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (exit) {
      const closed = await Promise.race([exit.then(() => true), pause(3000).then(() => false)]);
      if (!closed) { child.kill('SIGKILL'); await Promise.race([exit, pause(2000)]); }
    }
    if (proxy) { status(enabled ? proxy.stats() : {state:'unavailable'}); await proxy.close(); }
    if (config) await new Promise(resolve => {
      const req = https.request(new URL('/api/build-cache/release', config.endpoint), { method: 'POST', headers: {Authorization:`Bearer ${config.token}`, 'Content-Length':'0'}, ...(config.certificate ? {ca:config.certificate} : {}) }, res => {res.resume();res.on('end',resolve);});
      const timeout = setTimeout(()=>{req.destroy();resolve();},1000); req.on('close',()=>clearTimeout(timeout));req.on('error',resolve);req.end();
    });
    if (root && (!child || child.exitCode !== null || child.signalCode !== null)) fs.rmSync(root, { recursive: true, force: true });
  }
}
