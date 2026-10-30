import { setTimeout as pause } from 'node:timers/promises';
import { normalizeEnvironment, environmentOptions } from './preferences.mjs';
import { applyUserAgentClientHints, stealthInitScript, stealthUserAgent } from './stealth.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { evictableSession, sessionKey } from './session.mjs';
// A private lifecycle/transport bridge. Browser behavior is implemented by
// Microsoft's unmodified Playwright MCP; the trusted panel projects pixels.
import fs from 'node:fs/promises';
import { realpath } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createView } from './view.mjs';
import { actionTools, createActions, createMetrics, validateComposition, createToolQueue } from './actions.mjs';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw new Error('An absolute managed runtime directory is required');
const readyFile = path.join(root, 'ready.json');
const token = crypto.randomBytes(32).toString('hex');
const instanceId = crypto.randomUUID();
const workspace = path.join(root, 'workspace');
await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
await fs.mkdir(path.join(root, 'profile'), { recursive: true, mode: 0o700 });
const sessions = new Map();
// Only profiles created by THIS daemon may be removed on shutdown. Browser
// close events can race transport shutdown; ownership must outlive the event.
const temporaryProfiles = new Set();
async function removeTemporaryProfile(profile) {
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  temporaryProfiles.delete(profile);
}
const sessionContext = new AsyncLocalStorage();
let selectedKey = 'legacy'; // Older CLI clients are isolated once Desktop selects a chat.
let selectedScope = null;
let selectionRevision = 0;
let environment = normalizeEnvironment();
try { environment = normalizeEnvironment(JSON.parse(await fs.readFile(path.join(root, 'preferences.json'), 'utf8'))); } catch {}
let defaultMode = 'fast';
try { const mode = JSON.parse(await fs.readFile(path.join(root, 'interaction.json'), 'utf8')).mode; if (['fast', 'human'].includes(mode)) defaultMode = mode; } catch {}
// Bounded per-chat sessions. At the bound only a provably idle session is
// released: not the selected chat, no open browser, no composition and no
// request in flight. Its persistent profile stays on disk under its own key,
// so the same chat later reopens the same isolated profile.
function newOwnedSession(key, scope = null) {
  const owned = { key, scope, context: undefined, connections: new Map(), frameFlight: undefined, composition: undefined, serial: createToolQueue(), busy: 0, lastUsed: 0 };
  owned.view = createView(() => getContext(owned));
  owned.view.setMode(defaultMode);
  return owned;
}
// Schema discovery owns no chat, page or user workspace. Its one backend is
// outside the finite set of browser sessions and cannot evict a user's chat.
const inventorySession = newOwnedSession('inventory');
function ownedSession(key, scope = null) {
  if (!sessions.has(key)) {
    if (sessions.size >= 32) {
      const idle = evictableSession(sessions.values(), selectedKey);
      if (!idle) throw new Error('Restart browser service to release older sessions');
      sessions.delete(idle.key);
      for (const { client, official } of idle.connections.values()) { void client.close().catch(() => {}); void official.close().catch(() => {}); }
    }
    sessions.set(key, newOwnedSession(key, scope));
  }
  const owned = sessions.get(key);
  owned.lastUsed = Date.now();
  return owned;
}
const currentSession = () => sessionContext.getStore();
const metrics = createMetrics();
const validator = new AjvJsonSchemaValidator();
const validators = new WeakMap();
let closing = false;
const lifecycleQueue = createToolQueue();
const serial = (action, signal) => (currentSession()?.serial || lifecycleQueue)(action, signal);
async function getContext(owned = currentSession()) {
  if (!owned.context) {
    const settings = environment;
    const persistentProfile = owned.key === 'legacy' ? path.join(root, 'profile')
      : path.join(root, 'sessions', crypto.createHash('sha256').update(owned.key).digest('hex'), 'profile');
    const engineProfile = settings.engine === 'chrome' ? path.join(persistentProfile, 'chrome-profile') : persistentProfile;
    const profile = settings.storage === 'temporary'
      ? await fs.mkdtemp(path.join(root, 'temporary-profile-')) : engineProfile;
    if (settings.storage === 'temporary') temporaryProfiles.add(profile);
    await fs.mkdir(profile, { recursive: true, mode: 0o700 });
    // The reduced-signal hidden surface runs the full Chromium through the
    // "chromium" channel; an explicit headless-shell path would defeat it.
    const stealthChromiumChannel = settings.engine === 'chromium' && settings.reduceAutomationSignals && settings.display === 'embedded';
    const executablePath = process.platform === 'win32' && settings.engine === 'chromium' && !stealthChromiumChannel
      ? await promisify(realpath.native)(chromium.executablePath()) : undefined;
    const options = {
      ...environmentOptions(settings), viewport: { width: 1280, height: 800 },
      ...(settings.engine === 'chromium' ? {executablePath} : {}),
    };
    let identity;
    if (settings.reduceAutomationSignals && settings.display === 'embedded') {
      // The hidden surface must not announce "HeadlessChrome"; the version is
      // read from the real executable and a failure keeps the stock identity.
      identity = await stealthUserAgent({ settings, root, chromium });
      if (identity) options.userAgent = identity.userAgent;
    }
    let opened;
    try {
      opened = await chromium.launchPersistentContext(profile, options);
      if (settings.reduceAutomationSignals) {
        const initScript = stealthInitScript({ headless: settings.display === 'embedded', identity });
        if (initScript) await opened.addInitScript(initScript);
        if (identity) applyUserAgentClientHints(opened, identity, settings.locale || 'en-US');
      }
    } catch (error) {
      await opened?.close().catch(() => {});
      if (settings.storage === 'temporary') await removeTemporaryProfile(profile);
      throw error;
    }
    owned.context = opened; owned.settings = settings;
    opened.on('close', () => {
      if (owned.context === opened) { owned.context = undefined; owned.settings = undefined; }
      if (settings.storage === 'temporary') owned.cleanup = removeTemporaryProfile(profile).catch(() => {});
    });
  }
  return owned.context;
}
const config = {
  browser: { browserName: 'chromium', userDataDir: path.join(root, 'profile') },
  sharedBrowserContext: true, capabilities: ['core', 'vision', 'pdf'],
  webmcp: false, saveSession: false, codegen: 'none',
  outputDir: workspace, outputMaxSize: 100 * 1024 * 1024,
  console: { level: 'error' }, timeouts: { action: 10000, navigation: 60000, idle: 0 },
};
async function connection(candidate = workspace, access = 'project') {
  if (!path.isAbsolute(candidate) || !(await fs.stat(candidate)).isDirectory()) throw new Error('Workspace must be an existing absolute directory');
  candidate = await fs.realpath(candidate);
  const owned = currentSession();
  const connectionKey = JSON.stringify([candidate, access === 'full']);
  const existing = owned.connections.get(connectionKey);
  if (existing) return existing.client;
  // Each official backend captures its workspace at initialization. Do not
  // mutate roots on an initialized backend: that would leak file permissions
  // between projects. Backends within a session share its browser; tool calls
  // within each session use its own serialized queue. Other contexts stay independent.
  if (owned.connections.size >= 32) throw new Error('Restart the browser service to release older workspace connections');
  const outputDir = path.join(workspace, crypto.createHash('sha256').update(owned.key + candidate).digest('hex').slice(0, 24));
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const official = await createConnection({ ...config, outputDir, allowUnrestrictedFileAccess: access === 'full' }, () => getContext(owned));
  const client = new Client({ name: 'arvela-browser-owner', version: '1.0.0' }, { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(candidate).href, name: 'Approved current workspace' }] }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await official.connect(serverTransport);
  await client.connect(clientTransport);
  owned.connections.set(connectionKey, { client, official });
  return client;
}

// One execution boundary for ordinary and composed tools: identical geometry,
// mode, cancellation, tab ownership and keyboard limits on every path.
async function invokeTool(client, params, signal, owner = 'agent') {
  try {
    if (signal?.aborted) throw new Error('Cancelled before browser input');
    const delay = currentSession().settings?.actionDelayMs ?? environment.actionDelayMs;
    const observation = ['browser_snapshot','browser_take_screenshot','browser_console_messages','browser_network_requests','browser_network_request','browser_wait_for'].includes(params.name) || (params.name === 'browser_tabs' && params.arguments?.action === 'list');
    if (owner === 'agent' && delay && !observation) await pause(delay, undefined, {signal});
    try { await currentSession().view.before(client, params, owner, signal); }
    catch (error) {
      if (error && typeof error === 'object') { error.recovery ||= 'preparation'; throw error; }
      throw Object.assign(new Error('Browser preparation cancelled'), {recovery:'preparation'});
    }
    if (signal?.aborted) throw new Error('Cancelled before browser input');
    let result;
    if (params.name === 'browser_keyboard_type') {
      const args = params.arguments || {};
      if (typeof args.text !== 'string' || Buffer.byteLength(args.text) > 16384 || (args.submit !== undefined && typeof args.submit !== 'boolean')) throw new Error('Invalid keyboard input');
      const page = await currentSession().view.page();
      if (signal?.aborted) throw new Error('Cancelled before browser input');
      await page.keyboard.insertText(args.text);
      if (args.submit) { if (signal?.aborted) throw new Error('Cancelled before submit'); await page.keyboard.press('Enter'); }
      result = { content: [{ type: 'text', text: 'Keyboard input sent to the focused field. Inspect the result before another action.' }] };
    } else {
      // Cancelling an SDK request cannot undo input already delivered to the
      // browser. Keep this session's barrier until its backend call settles;
      // the outer deadline can report uncertainty without replaying/reordering.
      const read = ['browser_snapshot','browser_take_screenshot','browser_console_messages','browser_network_requests','browser_network_request','browser_wait_for'].includes(params.name)
        || (params.name === 'browser_tabs' && params.arguments?.action === 'list');
      result = await client.callTool(params, undefined, { ...(read ? { signal } : {}), timeout: 65000 });
    }
    if (params.name !== 'browser_close') await currentSession().view.after(client, params, result);
    return result;
  } finally { currentSession().view.failed(); }
}

function authorized(req) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(String(req.headers.authorization || ''));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
    && !req.headers.origin && /^127\.0\.0\.1:\d+$/.test(req.headers.host || '');
}
function reply(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const server = http.createServer(async (req, res) => {
  if (!authorized(req)) return reply(res, 403, { error: 'Unauthorized browser connection' });
  if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { instanceId, version: '0.0.83', running: !closing, browserOpen: !!sessions.get(selectedKey)?.context, scope: selectedScope, scopeKey: selectedKey, environment, environmentPending: [...sessions.values()].filter(s => s.context && JSON.stringify(s.settings) !== JSON.stringify(environment)).length, performance: metrics.snapshot() });
  // Frames do not wait behind a long navigation/tool call, so the panel stays
  // live while the agent acts. Bound to one capture at a time below.
  if (req.method === 'GET' && req.url === '/view') {
    try { return reply(res, 200, await captureFrame()); }
    catch { return reply(res, 503, { error: 'Browser frame unavailable' }); }
  }
  if (req.method !== 'POST') return reply(res, 404, { error: 'Unknown endpoint' });
  try {
    const request = await body(req);
    const cancellation = new AbortController();
    res.on('close', () => { if (!res.writableEnded) cancellation.abort(); });
    // Return before the engine's standard 60s MCP deadline, including queue and
    // context setup. No input is ever retried after cancellation.
    const requestSignal = request.method === 'tools/call'
      ? AbortSignal.any([cancellation.signal, AbortSignal.timeout(45000)]) : cancellation.signal;
    if (req.url === '/monitor-view') {
      if (request.pageId != null && (typeof request.pageId !== 'string' || !/^[0-9]{1,20}$/.test(request.pageId))) throw new Error('Invalid observed page');
      return reply(res, 200, await captureFrame(request.pageId || undefined));
    }
    if (req.url === '/stop') {
      reply(res, 200, { stopped: true });
      void close(); return;
    }
    if (req.url !== '/rpc') return reply(res, 404, { error: 'Unknown endpoint' });
    if (request.method === 'desktop/preferences') {
      const next = normalizeEnvironment(request.environment);
      await lifecycleQueue(async () => {
        const file = path.join(root, 'preferences.json');
        const temporary = `${file}.${crypto.randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify(next), {mode:0o600});
          await fs.rename(temporary, file);
        } finally { await fs.rm(temporary, {force:true}).catch(() => {}); }
        environment = next;
      });
      return reply(res, 200, {result:{environment, pending: [...sessions.values()].filter(s => s.context && JSON.stringify(s.settings) !== JSON.stringify(environment)).length}});
    }
    if (request.method === 'desktop/default-mode') {
      if (!['fast', 'human'].includes(request.mode)) throw new Error('Invalid browser mode');
      const target = sessions.get(selectedKey);
      await lifecycleQueue(async () => {
        await fs.writeFile(path.join(root, 'interaction.json'), JSON.stringify({ mode: request.mode }), { mode: 0o600 });
        defaultMode = request.mode;
      });
      if (target) await target.serial(() => target.view.setMode(request.mode));
      return reply(res, 200, { result: { mode: defaultMode } });
    }
    if (request.method === 'desktop/session') {
      if (!Number.isSafeInteger(request.revision) || request.revision < 1) throw new Error('Invalid selection revision');
      let key = null, scope = null;
      if (request.session !== null) {
        if (!path.isAbsolute(request.workspace) || !(await fs.stat(request.workspace)).isDirectory()) throw new Error('Invalid session workspace');
        const directory = await fs.realpath(request.workspace);
        key = sessionKey(directory, request.session); scope = { directory, ...request.session };
      }
      // A slower realpath from an older selection cannot overwrite a newer one.
      if (request.revision > selectionRevision) {
        selectionRevision = request.revision; selectedKey = key; selectedScope = scope;
      }
      return reply(res, 200, { result: { scope: selectedScope, scopeKey: selectedKey } });
    }
    const manual = request.owner === 'user' || request.method.startsWith('desktop/');
    let key, scope;
    if (manual) {
      if (!selectedKey) throw new Error('Select a chat before opening its browser');
      key = selectedKey; scope = selectedScope;
      if (scope) request.workspace = scope.directory;
      if (request.scopeKey !== undefined && request.scopeKey !== key) throw new Error('Selected chat changed; no input sent');
    } else if (request.session) {
      const directory = await fs.realpath(request.workspace);
      key = sessionKey(directory, request.session); scope = { directory, ...request.session };
    } else key = 'legacy';
    const owned = request.method === 'tools/list' ? inventorySession : ownedSession(key, scope);
    owned.busy++;
    try { return await sessionContext.run(owned, async () => {
    // Signal interruption immediately, even if the manual request waits in the queue.
    if (request.owner === 'user' || ['desktop/mode', 'desktop/resize', 'desktop/type', 'desktop/reload', 'desktop/forward', 'desktop/click', 'desktop/drag', 'desktop/wheel', 'desktop/key', 'desktop/copy'].includes(request.method)) currentSession().view.interrupt(false);
    else if (request.method === 'tools/call') currentSession().view.interrupt(false);
    if (request.method === 'tools/call' || request.owner === 'user' || request.method.startsWith('desktop/') && request.method !== 'desktop/reveal') currentSession().composition?.abort('interrupted');
    const queuedAt = performance.now();
    let beganExecution = false, reportedDeadline = false;
    const result = await serial(async () => {
      beganExecution = true;
      const queueMs = performance.now() - queuedAt;
      if (requestSignal.aborted) throw new Error('Cancelled');
      if (manual && key !== selectedKey) throw new Error('Selected chat changed; no input sent');
      if (request.expected) currentSession().view.assertCurrent(request.expected);
      if (request.method === 'desktop/mode') {
        currentSession().view.setMode(request.mode);
        await fs.writeFile(path.join(root, 'interaction.json'), JSON.stringify({ mode: request.mode }), { mode: 0o600 });
        return currentSession().view.state();
      }
      if (request.method === 'desktop/resize') {
        await currentSession().view.resize(request.width, request.height);
        return currentSession().view.state();
      }
      if (request.method === 'desktop/reveal') {
        await currentSession().view.page();
        return { revealed: true };
      }
      if (['desktop/click', 'desktop/drag', 'desktop/wheel', 'desktop/key', 'desktop/copy'].includes(request.method)) {
        if (!request.expected) throw new Error('A displayed frame is required');
        return currentSession().view.manual(request.method, request);
      }
      if (request.method === 'desktop/type') {
        if (typeof request.text !== 'string' || Buffer.byteLength(request.text) > 16384) throw new Error('Invalid text');
        currentSession().view.changed();
        await (await currentSession().view.page()).keyboard.insertText(request.text);
        return { typed: true };
      }
      if (request.method === 'desktop/reload' || request.method === 'desktop/forward') {
        const page = await currentSession().view.page();
        currentSession().view.changed();
        if (request.method === 'desktop/reload') await page.reload({ timeout: 60000 });
        else await page.goForward({ timeout: 60000 });
        return { navigated: true };
      }
      // Discovery has no workspace authority and must not consume one backend
      // per chat/worktree in the shared legacy discovery scope. Actual calls
      // below still capture the exact caller's workspace and access policy.
      const client = await connection(request.method === 'tools/list' ? workspace : request.workspace,
        request.method === 'tools/list' ? 'project' : request.access);
      if (request.method === 'tools/list') {
        const inventory = await client.listTools();
        const base = [...inventory.tools, { name: 'browser_keyboard_type', description: 'Type or paste text with the keyboard into the currently focused field. Click the field with the mouse first. No DOM selectors or implicit focus changes.',
          inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 16384 }, submit: { type: 'boolean' } }, required: ['text'], additionalProperties: false } }];
        const custom = actionTools(base);
        validators.set(client, new Map([...base, ...custom].map(tool => [tool.name, validator.getValidator(tool.inputSchema)])));
        return { ...inventory, tools: [...base, ...custom].map(tool => ({ ...tool,
          description: `${tool.description || ''}${/^browser_mouse_/.test(tool.name) ? ' XY input requires a fresh CSS viewport screenshot; resize/scroll/shared input invalidates old coordinates. A rejected action returns a fresh image and never replays.' : ['browser_click', 'browser_fill_form', 'browser_type', 'browser_select_option', 'browser_evaluate', 'browser_run_code'].includes(tool.name) ? ' Fast mode only; human mode requires mouse XY and browser_keyboard_type.' : tool.name === 'browser_take_screenshot' ? ' For XY input use scale=css, fullPage=false and no element target. Desktop mode and viewport are reported with results.' : ['browser_network_requests', 'browser_console_messages'].includes(tool.name) ? ' Optional filename must stay inside approved workspace/output roots; omit it to return text. Arbitrary /tmp paths are not approved.' : tool.name === 'browser_network_request' ? ' Use a current index from browser_network_requests. Relist after the browser context restarts; old indexes are not portable.' : ''}` })) };
      }
      if (request.method === 'tools/call' && ['browser_observe', 'browser_action', 'browser_sequence'].includes(request.params?.name)) {
        if (!validators.has(client)) {
          const inventory = await client.listTools();
          const keyboard = { name: 'browser_keyboard_type', inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 16384 }, submit: { type: 'boolean' } }, required: ['text'], additionalProperties: false } };
          const base = [...inventory.tools, keyboard];
          validators.set(client, new Map([...base, ...actionTools(base)].map(tool => [tool.name, validator.getValidator(tool.inputSchema)])));
        }
        let actionMs = 0, observeMs = 0;
        const actions = createActions({ identity: currentSession().view.identity, validate: (name, args) => {
          validateComposition(name, args, validators.get(client));
        }, call: async (params, signal) => {
          const began = performance.now();
          try { return await invokeTool(client, params, signal);
          } finally {
            if (['browser_snapshot', 'browser_take_screenshot'].includes(params.name)) observeMs += performance.now() - began;
            else actionMs += performance.now() - began;
          }
        } });
        let value;
        const owned = new AbortController(); currentSession().composition = owned;
        try { value = await actions.run(request.params.name, request.params.arguments || {}, AbortSignal.any([requestSignal, owned.signal])); return { ...value, content: [...value.content, { type: 'text', text: `Desktop browser state: ${JSON.stringify(currentSession().view.state())}` }] }; }
        finally { if (currentSession().composition === owned) currentSession().composition = undefined; metrics.record({ failed: !value || value.isError || reportedDeadline, queueMs, actionMs, observeMs, completedSteps: value?.structuredContent?.completed }); }
      }
      if (request.method === 'tools/call') {
        const began = performance.now();
        let failed = true;
        try {
          // Listing stays lazy; only actual actions create the browser.
          let result;
          try { result = await invokeTool(client, request.params, requestSignal, request.owner === 'user' ? 'user' : 'agent'); }
          catch (error) {
            if (error.recovery === 'preparation') return {
              isError:true,content:[{type:'text',text:'Browser context preparation did not finish. No requested input was sent. Reinspect the browser; reconnect the integration if preparation keeps failing.'}],
              structuredContent:{desktopBrowserRecovery:true,reason:'preparation',completed:0,uncertainLastAction:false,noReplay:true},
            };
            if (!['mode', 'geometry'].includes(error.recovery)) throw error;
            const fresh = await invokeTool(client, { name: 'browser_take_screenshot', arguments: { scale: 'css', type: 'png' } }, requestSignal);
            return { isError: true, content: [{ type: 'text', text: `${error.message}\nDesktop browser state: ${JSON.stringify(currentSession().view.state())}` }, ...(fresh?.content || [])],
              structuredContent: { desktopBrowserRecovery: true, reason: error.recovery, ...currentSession().view.state() } };
          }
        if (request.reveal && !result.isError && currentSession().context) {
          const pages = currentSession().context.pages();
          const page = pages.find(page => page.url() === request.params?.arguments?.url) || pages.at(-1);
          await page?.bringToFront();
        }
        failed = !!result.isError;
        return { ...result, content: [...(result.content || []), { type: 'text', text: `Desktop browser state: ${JSON.stringify(currentSession().view.state())}` }] };
        } finally { const elapsed = performance.now() - began; const read = ['browser_snapshot', 'browser_take_screenshot', 'browser_console_messages', 'browser_network_requests'].includes(request.params?.name); metrics.record({ failed: failed || reportedDeadline, queueMs, actionMs: read ? 0 : elapsed, observeMs: read ? elapsed : 0 }); }
      }
      throw new Error('Only official browser tool methods are supported');
    }, requestSignal).catch(error => {
      if (!requestSignal.aborted || request.method !== 'tools/call') throw error;
      reportedDeadline = true;
      if (!beganExecution) metrics.record({failed:true,queueMs:performance.now()-queuedAt,completedSteps:0});
      return {isError:true,content:[{type:'text',text:beganExecution ? 'Browser call cancelled or timed out (including setup). Input may have been delivered. Inspect the current page before continuing; never replay it blindly.' : 'Browser call timed out or was cancelled while queued. This request sent no input. Inspect the current page before continuing.'}],structuredContent:{desktopBrowserRecovery:true,reason:'deadline',uncertainLastAction:beganExecution,noReplay:true}};
    });
    reply(res, 200, { result });
    }); } finally { owned.busy--; }
  } catch {
    // Tool payloads and error details can contain passwords/page content. Never
    // write them to process logs or native errors. MCP tool errors stay in results.
    reply(res, 400, { error: 'Browser request failed; check its tool arguments, workspace and browser state' });
  }
});
async function captureFrame(observedPageId) {
  const key = selectedKey, scope = selectedScope, owned = sessions.get(key);
  if (!owned?.context) return { browserOpen: false, busy: false, tabs: [], scope };
  if (owned.frameFlight && owned.frameFlightPageId !== observedPageId) {
    await owned.frameFlight.catch(() => {});
    return captureFrame(observedPageId);
  }
  if (!owned.frameFlight) {
    owned.frameFlightPageId = observedPageId;
    owned.frameFlight = (async () => {
    try { return await owned.view.frame(owned.context, observedPageId); }
    catch (error) { if (!error.frameChanged) throw error; return owned.view.frame(owned.context, observedPageId); }
  })().finally(() => { owned.frameFlight = undefined; });
  }
  const frame = await owned.frameFlight;
  if (selectedKey !== key) return { browserOpen: false, busy: false, tabs: [], scope: selectedScope };
  return { ...frame, scope, scopeKey: key };
}
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const temporary = `${readyFile}.${instanceId}.tmp`;
await fs.writeFile(temporary, JSON.stringify({ port, token, pid: process.pid, instanceId, version: '0.0.83' }), { mode: 0o600 });
await fs.rename(temporary, readyFile);
async function close() {
  if (closing) return; closing = true;
  try {
    const ready = JSON.parse(await fs.readFile(readyFile, 'utf8'));
    if (ready.instanceId === instanceId) await fs.unlink(readyFile);
  } catch {}
  server.close();
  for (const owned of [inventorySession, ...sessions.values()]) {
    for (const { client, official } of owned.connections.values()) {
      await client.close().catch(() => {}); await official.close().catch(() => {});
    }
    await owned.context?.close().catch(() => {});
    await owned.cleanup;
  }
  let cleanupFailed = false;
  for (const profile of [...temporaryProfiles]) {
    try { await removeTemporaryProfile(profile); } catch { cleanupFailed = true; }
  }
  if (cleanupFailed) process.stderr.write('Enki: temporary browser profile cleanup failed\n');
  process.exit(cleanupFailed ? 1 : 0);
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
// Desktop keeps the write end of this pipe for the daemon's whole lifetime.
// EOF means the owner exited or crashed: close the browser instead of leaving
// an orphaned service holding the profile. Manual smoke runs do not opt in.
if (process.env.OCDESKTOP_BROWSER_OWNER_PIPE === '1') {
  process.stdin.on('end', () => void close());
  process.stdin.on('error', () => void close());
  process.stdin.resume();
}
process.on('uncaughtException', () => { process.stderr.write('Browser runtime failed. Restart it from Desktop settings.\n'); void close(); });
process.on('unhandledRejection', () => { process.stderr.write('Browser runtime failed. Restart it from Desktop settings.\n'); void close(); });
