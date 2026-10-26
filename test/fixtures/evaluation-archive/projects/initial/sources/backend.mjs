import { createServer } from 'node:http';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { evaluationMemory, memoryTool } from './memory.mjs';
import { browserHtml,browserWorkflowHtml } from './fixtures.mjs';

const object = properties => ({ type: 'object', properties, additionalProperties: false });
const string = { type: 'string' };
export const tools = [
  memoryTool,
  { name: 'read', description: 'Read an allowed fixture file. Use list to discover files.', inputSchema: { ...object({ path: string }), required: ['path'] } },
  { name: 'write', description: 'Replace an allowed fixture file with complete text. Cannot write outside this fixture.', inputSchema: { ...object({ path: string, text: string }), required: ['path', 'text'] } },
  { name: 'check', description: 'Run bounded public smoke checks for this synthetic miniature project. Does not expose held-out checks.', inputSchema: object({}) },
  { name: 'list', description: 'List allowed fixture files.', inputSchema: object({}) },
  { name: 'browser_snapshot', description: 'Observe the real isolated test browser; returns current refs and revision. Ref actions require that revision.', inputSchema: object({}) },
  { name: 'browser_action', description: 'Click or fill an observed ref in the test browser. On STALE_SNAPSHOT observe again before acting.', inputSchema: { ...object({ revision: { type: 'integer' }, ref: string, action: { enum: ['click', 'fill'] }, value: string }), required: ['revision', 'ref', 'action'] } },
];

export async function startBackend({ fixture, work, playwrightModule, browserExecutable, memoryMode = 'off' }) {
  const token = randomUUID();
  const memory = memoryMode === 'off' ? null : await evaluationMemory(join(work, '..'), fixture);
  let browser, page, revision = 0, refs = [], disturbed = false;
  const metrics = { durationMs:0, checkMs:0, checks:0, calls: 0, errors: 0, staleRefusals: 0, validationErrors: 0, memoryCalls: 0 };
  async function file(path) {
    if (!Object.hasOwn(fixture.files, path)) throw Error('FILE_NOT_ALLOWED');
    const target = join(work, path);
    if (!(await lstat(target)).isFile()) throw Error('NOT_REGULAR_FILE');
    return target;
  }
  async function execute(name, args = {}) {
    metrics.calls++;
    const started=performance.now();
    try {
      if (name === 'memory_search') { metrics.memoryCalls++;  if (!memory || memoryMode !== 'tools') throw Error('MEMORY_DISABLED'); return await memory.search(args); }
      if (name === 'list') return Object.keys(fixture.files);
      if (name === 'check') {
        if (!fixture.publicAssertions) throw Error('NO_PUBLIC_CHECK');
        metrics.checks++;
        const {gradeCode}=await import('./runner.mjs');
        const checked=await gradeCode({...fixture,assertions:fixture.publicAssertions},work);
        return {passed:checked.passed,diagnostic:checked.diagnostic};
      }
      if (name === 'read') return await readFile(await file(args.path), 'utf8');
      if (name === 'write') {
        if(fixture.readOnly?.includes(args.path))throw Error('READ_ONLY_FILE');
        if (typeof args.text !== 'string' || Buffer.byteLength(args.text) > 64 * 1024) throw Error('FILE_TOO_LARGE');
        await writeFile(await file(args.path), args.text); return 'saved';
      }
      if (!page) throw Error('BROWSER_NOT_AVAILABLE');
      if (name === 'browser_snapshot') {
        refs = await page.locator('button:visible,input:visible').evaluateAll(elements => elements.map(e => ({
          name: e.getAttribute('aria-label'), tag: e.tagName, value: e.value ?? null,
        })));
        revision++;
        return { revision, text: await page.locator('body').innerText(), refs: refs.map((r, i) => ({ ref: `r${i}`, ...r })) };
      }
      if (name === 'browser_action') {
        if (fixture.disturbance && !disturbed) {
          disturbed = true; await page.setViewportSize({ width: 520, height: 360 });
          await page.evaluate(() => window.scrollTo(0, 150)); revision++;
        }
        if (args.revision !== revision) { metrics.staleRefusals++; throw Error('STALE_SNAPSHOT: refresh browser_snapshot'); }
        const index = /^r\d+$/.test(args.ref) ? Number(args.ref.slice(1)) : -1;
        const ref = refs[index];
        if (!ref) throw Error('UNKNOWN_REF');
        const locator = page.getByLabel(ref.name, { exact: true });
        if (args.action === 'click' && ref.tag === 'BUTTON') await locator.click({ timeout: 3000 });
        else if (args.action === 'fill' && ref.tag === 'INPUT' && typeof args.value === 'string') await locator.fill(args.value, { timeout: 3000 });
        else throw Error('INVALID_ACTION');
        // Every mutation invalidates prior refs, including layout changes from a dialog.
        revision++; refs = [];
        return { refreshRequired: true };
      }
      throw Error('UNKNOWN_TOOL');
    } catch (e) { metrics.errors++; throw e; } finally {const ms=performance.now()-started;metrics.durationMs+=ms;if(name==='check')metrics.checkMs+=ms;}
  }
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    if (req.method !== 'POST' || req.url !== '/tool') { res.writeHead(404).end(); return; }
    let body = '';
    try {
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 80 * 1024) throw Error('TOO_LARGE'); }
      const { name, args } = JSON.parse(body);
      const result = await execute(name, args);
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result }));
    } catch (e) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    if (fixture.category === 'browser') {
      if (!playwrightModule) throw Error('Browser trials require --playwright-module; not a pass or a skip disguised as success');
      const { chromium } = await import(playwrightModule);
      browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: browserExecutable });
      page = await browser.newPage({ viewport: { width: 900, height: 700 } });
      // The synthetic page never visits a network origin, opens links or exposes app credentials.
      await page.route('**/*', route => route.abort());
      await page.setContent(fixture.workflow?browserWorkflowHtml:browserHtml);
    }
  } catch (e) { server.close(); if (browser) await browser.close(); throw e; }
  return {
    async context() { return memory ? memory.search({query:fixture.id+' '+fixture.prompt.slice(0,200)}) : null; },
    url: `http://127.0.0.1:${server.address().port}`, token, execute, metrics, browserVersion: browser?.version() ?? null,
    async gradeBrowser() {
      if (!page) return false;
      const state = await page.evaluate(() => ({ oak: Number(document.querySelector('#oak').textContent), pine: Number(document.querySelector('#pine').textContent), saved: window.saved || 0, invalid: window.invalid || 0 }));
      metrics.validationErrors = state.invalid;
      return state.oak === fixture.expected && state.pine === (fixture.expectedPine??5) && state.saved === (fixture.expectedSaves??1)
        && (!['browser-validation','browser-workflow'].includes(fixture.id) || state.invalid >= 1)
        && (!fixture.disturbance || metrics.staleRefusals >= 1);
    },
    async close() { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
