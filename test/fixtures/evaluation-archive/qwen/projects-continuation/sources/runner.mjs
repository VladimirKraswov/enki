import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, toNamespacedPath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { fixtures, suiteVersion } from './fixtures.mjs';
import { startBackend } from './backend.mjs';
import { startProxy, providerPolicy } from './proxy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hash = data => createHash('sha256').update(data).digest('hex');
const active = new Set();
export function cleanEnvironment(home) {
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: tmpdir(),
    XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state'),
    PI_CODING_AGENT_DIR: join(home, 'pi'), PI_OFFLINE: '1', PI_TELEMETRY: '0',
    OPENCODE_CONFIG_DIR: join(home, 'config', 'opencode'), OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_LSP_DOWNLOAD: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_TEST_HOME: home, OPENCODE_ENABLE_EXPERIMENTAL_MODELS: 'true' };
  if (process.platform === 'win32') for (const key of ['SystemRoot', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
export function runProcess(command, args, { cwd, env, seconds = 120, bytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    active.add(child);
    let stdout = '', stderr = '', size = 0, stopped = null, killing = false;
    const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
    const kill = reason => {
      if (killing) return; killing = true; stopped = reason;
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(-child.pid, 'SIGKILL');
      } catch { child.kill('SIGKILL'); }
    };
    child.evalKill = kill;
    const timer = setTimeout(() => kill('timeout'), seconds * 1000);
    const capture = (target, chunk) => { size += chunk.length; if (size > bytes) { kill('output-limit'); return; } if (target === 'out') stdout += outDecoder.write(chunk); else stderr += errDecoder.write(chunk); };
    child.stdout.on('data', chunk => capture('out', chunk)); child.stderr.on('data', chunk => capture('err', chunk));
    child.on('error', e => { clearTimeout(timer); active.delete(child); reject(e); });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer); active.delete(child);
      stdout += outDecoder.end(); stderr += errDecoder.end();
      // Agent CLIs may leave an MCP child after a normal exit; only our process group is touched.
      if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ } }
      resolvePromise({ exitCode, signal, stopped, stdout, stderr });
    });
  });
}

export async function gradeCode(fixture, work) {
  // Candidate filesystem reads and child-process APIs are restricted. This is
  // an evaluator for our synthetic fixtures, not an OS sandbox for hostile code.
  const source = `const assert=require('node:assert/strict');const s=require('./solution.cjs');(async()=>{${fixture.assertions};process.stdout.write('ARVELA_OUTCOME_OK\\n')})().catch(e=>{console.error(e.message);process.exitCode=1});`;
  // Windows module reads can retain the short-name/namespaced form of cwd.
  // Grant only lexical/canonical aliases of this same disposable directory.
  const roots = [resolve(work), await realpath(work)];
  const aliases = [...new Set([...roots, ...roots.map(toNamespacedPath)])];
  const result = await runProcess(process.execPath, ['--permission', ...aliases.map(p => `--allow-fs-read=${p}`), '-e', source], {
    cwd: work, env: cleanEnvironment(join(work, '.grade-home')), seconds: 5, bytes: 32768,
  });
  const preserved = await Promise.all((fixture.readOnly??[]).map(async name=>await readFile(join(work,name),'utf8')===fixture.files[name]));
  const passed = preserved.every(Boolean) && result.exitCode === 0 && !result.stopped && result.stdout.trim() === 'ARVELA_OUTCOME_OK';
  return { passed, reason: passed ? null : result.stopped ?? 'independent-assertion-failed', diagnostic: passed ? null : result.stderr.slice(0, 1024) };
}
export async function selfCheck() {
  const checks = [];
  for (const f of fixtures.filter(f => f.category !== 'browser')) {
    const root = await mkdtemp(join(tmpdir(), 'arvela-eval-check-'));
    try {
      for (const [name, text] of Object.entries(f.files)) {await mkdir(dirname(join(root,name)),{recursive:true});await writeFile(join(root, name), text);}
      const base = await gradeCode(f, root);
      for (const [name, text] of Object.entries(f.reference)) {await mkdir(dirname(join(root,name)),{recursive:true});await writeFile(join(root, name), text);}
      const reference = await gradeCode(f, root);
      checks.push({ id: f.id, baselineFails: !base.passed, referencePasses: reference.passed, ...(reference.passed ? {} : { diagnostic: reference.diagnostic }) });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  if (!checks.every(c => c.baselineFails && c.referencePasses)) throw Error('Fixture discrimination failed: '+JSON.stringify(checks.filter(c => !c.baselineFails || !c.referencePasses)));
  return checks;
}

export function parseAgentEvents(engine, text) {
  let assistantTurns = 0, errors = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; let usagePresent = false;
  for (const line of text.split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'error') errors++;
    if (engine === 'pi' && event.type === 'message_end' && event.message?.role === 'assistant') {
      assistantTurns++; const u = event.message.usage;
      if (u) { usagePresent = true; for (const key of Object.keys(tokens)) tokens[key] += Number(u[key]) || 0; }
      if (event.message.stopReason === 'error' || event.message.errorMessage) errors++;
    }
    if (engine === 'opencode' && event.type === 'step_finish') {
      assistantTurns++; const u = event.part?.tokens;
      if (u) { usagePresent = true; tokens.input += u.input || 0; tokens.output += u.output || 0; tokens.cacheRead += u.cache?.read || 0; tokens.cacheWrite += u.cache?.write || 0; }
    }
  }
  return { assistantTurns, errors, tokens: usagePresent ? tokens : null };
}

async function prepareAgent(engine, root, work, backend, proxy, model, effort, category, memoryMode = 'off', requestLimit = 18, navigationMode = 'off') {
  const home = join(root, 'home'); await mkdir(home);
  const env = { ...cleanEnvironment(home), ARVELA_EVAL_URL: backend.url, ARVELA_EVAL_TOKEN: backend.token, ARVELA_EVAL_CATEGORY: category, ARVELA_EVAL_MEMORY: memoryMode, ARVELA_EVAL_NAVIGATION:navigationMode };
  const prompt = 'Synthetic evaluation task. Use only fixture tools. Inspect the available files/browser, solve the task, then give a brief result. Do not ask for human intervention. Refresh browser snapshots after mutations or stale refs.\n';
  if (engine === 'pi') {
    await mkdir(join(home, 'pi'));
    await writeFile(join(home, 'pi', 'models.json'), JSON.stringify({ providers: { eval: {
      baseUrl: proxy.url, api: 'openai-completions', apiKey: '$ARVELA_EVAL_API_KEY',
      models: [{ id: model, name: model, reasoning: true, input: ['text'], contextWindow: 262144, maxTokens: 4096,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } }],
    } } }), { mode: 0o600 });
    await writeFile(join(home, 'pi', 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
    env.ARVELA_EVAL_API_KEY = proxy.token;
    return { command: 'pi', args: ['--offline', '--mode', 'json', '-p', '--no-session', '--no-builtin-tools', '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '-e', join(here, 'pi-extension.ts'), '--provider', 'eval', '--model', model, '--thinking', effort], env, prompt };
  }
  const config = {
    $schema: 'https://opencode.ai/config.json', autoupdate: false, share: 'disabled', snapshot: false,
    enabled_providers: ['eval'], lsp: false, formatter: false,
    provider: { eval: { npm: '@ai-sdk/openai-compatible', name: 'Isolated evaluation', options: { baseURL: proxy.url, apiKey: proxy.token },
      models: { [model]: { name: model, limit: { context: 262144, output: 4096 }, reasoning: true } } } },
    agent: { build: { tools: { '*': false, 'fixture_*': true }, permission: { '*': 'deny', 'fixture_*': 'allow' }, steps: Math.min(40,requestLimit+2) } },
    mcp: { fixture: { type: 'local', command: [process.execPath, join(here, 'mcp.mjs')], enabled: true, environment: { ARVELA_EVAL_URL: backend.url, ARVELA_EVAL_TOKEN: backend.token, ARVELA_EVAL_CATEGORY: category, ARVELA_EVAL_MEMORY: memoryMode, ARVELA_EVAL_NAVIGATION:navigationMode } } },
  };
  await mkdir(join(home, 'config', 'opencode'), { recursive: true });
  const configPath = join(home, 'config', 'opencode', 'opencode.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  env.OPENCODE_CONFIG = configPath;
  return { command: 'opencode', args: ['run', '--pure', '--format', 'json', '--model', `eval/${model}`, '--agent', 'build', '--variant', effort, '--dir', work], env, prompt };
}

export function renderReport(report) {
  const elapsed = t => t.elapsedSeconds ?? t.verifiedSeconds;
  const median = values => { const a = [...values].sort((a, b) => a - b), m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const usageLabel = u => !u.responsesWithUsage ? 'unknown' : `${u.responsesWithUsage < u.requests ? 'partial ' : ''}${u.input + u.output}`;
  const aggregates = [...new Set(report.trials.map(t => `${t.engine} / memory:${t.memoryMode ?? 'off'} / map:${t.navigationMode ?? 'off'}`))].map(group => {
    const trials = report.trials.filter(t => `${t.engine} / memory:${t.memoryMode ?? 'off'} / map:${t.navigationMode ?? 'off'}` === group);
    const knownTokens = trials.reduce((n, t) => n + (t.providerUsage.input || 0) + (t.providerUsage.output || 0), 0);
    const fullUsage = trials.every(t => t.providerUsage.responsesWithUsage === t.providerUsage.requests && t.providerUsage.responsesWithUsage > 0);
    return `| ${group} | ${trials.filter(t => t.passed).length}/${trials.length} | ${median(trials.map(elapsed)).toFixed(2)} | ${fullUsage ? '' : 'partial '}${knownTokens} |`;
  });
  const rows = report.trials.map(t => `| ${t.fixture} | ${t.engine} / memory:${t.memoryMode ?? 'off'} / map:${t.navigationMode ?? 'off'} | ${t.repeat} | ${t.passed ? 'PASS' : t.status} | ${elapsed(t).toFixed(1)} | ${usageLabel(t.providerUsage)} | ${t.tools.staleRefusals} |`);
  return `# Arvela synthetic evaluation ${suiteVersion}\n\nModel: ${report.model}; requested effort: ${report.effort}; effective provider effort: ${report.effectiveEffort}. Memory: ${report.memoryMode ?? 'off'}. Navigation: ${report.navigationMode ?? 'off'}.\n\n${report.trials.filter(t => t.passed).length}/${report.trials.length} independently verified trials. Owner interventions: 0 (unattended runner; not a statement about production).\n\n| Agent | Verified outcomes | Median elapsed seconds (all trials) | Provider tokens |\n|---|---:|---:|---:|\n${aggregates.join('\n')}\n\n| Fixture | Agent | Repeat | Result | Elapsed seconds through grading | Provider tokens | Stale refusals |\n|---|---|---:|---|---:|---:|---:|\n${rows.join('\n')}\n\nLimits: ${JSON.stringify(report.limits)}. Provider token usage is authoritative where present; missing usage is unknown, never zero. Admission checks apply between responses; one in-flight response can exceed the token ceiling.\n\nThese small synthetic trials do not measure local Qwen throughput, general model intelligence, production browser emulation, UI behavior or long-project quality. No history, skills or private code was sent. Tool/fixture revisions are in the JSON report. Sequential AB/BA order alternates between repeats; no automatic retries or result deletion.\n`;
}

export function trialPlan({ repeats, selected, engines, memoryModes, navigationModes, offset = 0 }) {
  const plan = [];
  for (let repeat = 1; repeat <= repeats; repeat++) for (const fixture of selected) for (const engine of (repeat % 2 ? engines : [...engines].reverse())) for (const memoryMode of (repeat % 2 ? memoryModes : [...memoryModes].reverse())) for (const navigationMode of (repeat % 2 ? navigationModes : [...navigationModes].reverse())) plan.push({ repeat, fixture, engine, memoryMode, navigationMode });
  if (!Number.isInteger(offset) || offset < 0 || offset >= plan.length) throw Error('Trial offset must select an unfinished plan suffix');
  return plan.slice(offset);
}

async function main() {
  const args = process.argv.slice(2); const value = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  const allowed = new Set(['--self-check', '--live', '--output', '--agents', '--cases', '--repeats', '--timeout', '--total-timeout', '--model', '--effort', '--key-file', '--playwright-module', '--browser-executable', '--total-tokens', '--total-requests', '--memory','--navigation', '--provider', '--base-url', '--trial-offset']);
  for (let i = 0; i < args.length; i++) { if (!allowed.has(args[i])) throw Error(`Unknown option ${args[i]}`); if (!['--self-check', '--live'].includes(args[i])) i++; }
  if (args.includes('--self-check')) { console.log(JSON.stringify(await selfCheck(), null, 2)); return; }
  if (!args.includes('--live')) throw Error('Live inference is opt-in: --live required. Offline CI: --self-check.');
  const integer = (flag, fallback, min, max) => { const n = Number(value(flag, fallback)); if (!Number.isInteger(n) || n < min || n > max) throw Error(`Invalid ${flag}`); return n; };
  const engines = value('--agents', 'opencode,pi').split(',');
  if (!engines.length || new Set(engines).size !== engines.length || engines.some(e => !['opencode', 'pi'].includes(e))) throw Error('Unknown/duplicate agent');
  const requested = value('--cases', fixtures.map(f => f.id).join(',')).split(',');
  const selected = fixtures.filter(f => requested.includes(f.id));
  if (selected.length !== requested.length) throw Error('Unknown/duplicate case');
  const repeats = integer('--repeats', '2', 1, 5), seconds = integer('--timeout', '120', 10, 300);
  const totalSeconds = integer('--total-timeout', '1800', 30, 3600);
  const provider = value('--provider', 'deepseek'), baseUrl = value('--base-url');
  const policy = providerPolicy(provider, baseUrl, value('--effort', 'medium'));
  const model = value('--model', provider === 'local-qwen' ? 'qwen38-flash-next' : 'deepseek-flash'), effort = value('--effort', 'medium');
  if (model !== (provider === 'local-qwen' ? 'qwen38-flash-next' : 'deepseek-flash')) throw Error('Unsupported evaluation model');
  let modelMetadata = null;
  if (provider === 'local-qwen') {
    if (value('--key-file')) throw Error('Cloud credentials cannot be used for local Qwen');
    const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) throw Error('Local model metadata unavailable');
    const entry = (await response.json()).data?.find(m => m.id === model);
    if (!entry || effort !== 'off' && !entry.supported_reasoning_efforts?.includes(effort)) throw Error('Local model or effort is not advertised');
    modelMetadata = { id: entry.id, contextWindow: entry.context_length ?? entry.max_model_len, supportedEfforts: entry.supported_reasoning_efforts };
  }
  const output = resolve(value('--output', join('.local', 'evaluations', new Date().toISOString().replaceAll(':', '-'))));
  // Never merge/overwrite previous evidence. Raw agent stream is intentionally not saved.
  await mkdir(output, { recursive: true });
  const reportPath = join(output, 'report.json');
  try { await readFile(reportPath); throw Error('Report already exists; choose a fresh output directory'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let key = provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : undefined;
  if (!key && value('--key-file')) {
    const auth = JSON.parse(await readFile(resolve(value('--key-file')), 'utf8'));
    key = auth.deepseek?.key;
  }
  if (provider === 'deepseek' && (typeof key !== 'string' || !key.trim())) throw Error('Missing DEEPSEEK_API_KEY or explicit --key-file OpenCode auth; no live trial started');
  const memoryMode = value('--memory', 'off'); if (!['off','tools','context','compare'].includes(memoryMode)) throw Error('Memory mode must be off, tools, context or compare');
  const navigationMode=value('--navigation','off');if(!['off','tools','compare'].includes(navigationMode))throw Error('Navigation must be off, tools or compare');
  const navigationModes=navigationMode==='compare'?['off','tools']:[navigationMode];
  const memoryModes = memoryMode === 'compare' ? ['off','tools','context'] : [memoryMode];
  const trialOffset = integer('--trial-offset', '0', 0, 959);
  const plan = trialPlan({ repeats, selected, engines, memoryModes, navigationModes, offset: trialOffset });
  const limits = { requests: 18, outputTokens: 4096, tokens: 60000, requestBytes: 100000,
    totalTokens: integer('--total-tokens', '1000000', 4096, 2000000), totalRequests: integer('--total-requests', '400', 1, 500), perTrialSeconds: seconds, totalSeconds };
  const budget = { requests: 0, input: 0, output: 0 };
  const sources = ['../../services/hub/memory.py', '../../services/hub/server.py', 'fixtures.mjs', 'project-fixtures.mjs', 'backend.mjs', 'proxy.mjs', 'runner.mjs', 'mcp.mjs', 'pi-extension.ts', 'memory.mjs', 'memory.py','../../src-tauri/resources/shared/project-map-core.mjs'];
  const revisions = Object.fromEntries(await Promise.all(sources.map(async name => [name, hash(await readFile(join(here, name)))])));
  const versions = {};
  for (const engine of engines) { const v = await runProcess(engine, ['--version'], { seconds: 10, bytes: 1024 }); if (v.exitCode !== 0) throw Error(`${engine} unavailable`); versions[engine] = v.stdout.trim(); }
  const report = { schemaVersion: 3, suiteVersion, startedAt: new Date().toISOString(), provider, modelMetadata, model, effort, memoryMode, navigationMode, effectiveEffort: policy.effectiveEffort, trialOffset, plannedTrials: plan.map(t => ({ ...t, fixture: t.fixture.id })), environment: { node: process.version, platform: process.platform, arch: process.arch }, revisions, skillRevisions: [], versions, limits, trials: [], budget, complete: false };
  const start = performance.now(); let cancelled = false;
  const interrupt = () => { cancelled = true; for (const child of active) child.evalKill('cancelled'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const globalTimer = setTimeout(interrupt, totalSeconds * 1000);
  const save = async () => { await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 }); await writeFile(join(output, 'report.md'), renderReport(report), { mode: 0o600 }); };
  try {
    for (const { repeat, fixture, engine, memoryMode, navigationMode } of plan) {
      if (cancelled || budget.requests >= limits.totalRequests || budget.input + budget.output >= limits.totalTokens) break;
      const root = await mkdtemp(join(tmpdir(), 'arvela-live-eval-')); const work = join(root, 'work'); await mkdir(work);
      let backend, proxy; const started = performance.now();
      const trial = { fixture: fixture.id, fixtureRevision: hash(JSON.stringify(fixture)), category: fixture.category, memoryMode, navigationMode, engine, repeat, passed: false, status: 'setup-error', elapsedSeconds: 0, verifiedSeconds: null, ownerInterventions: 0, tools: { calls: 0, errors: 0, staleRefusals: 0 }, providerUsage: { requests: 0, responsesWithUsage: 0 }, agentUsage: null };
      try {
        for (const [name, text] of Object.entries(fixture.files)) {await mkdir(dirname(join(work,name)),{recursive:true});await writeFile(join(work, name), text);}
        backend = await startBackend({ fixture, work, playwrightModule: value('--playwright-module') ? pathToFileURL(resolve(value('--playwright-module'))).href : undefined, memoryMode, navigationMode, browserExecutable: value('--browser-executable') ? resolve(value('--browser-executable')) : undefined });
        trial.limits={...limits,requests:fixture.requests??limits.requests,tokens:fixture.tokens??limits.tokens};
        proxy = await startProxy({ key, model, effort, budget, limits:trial.limits, provider, baseUrl });
        const agent = await prepareAgent(engine, root, work, backend, proxy, model, effort, fixture.category, memoryMode,trial.limits.requests,navigationMode);
        const context = memoryMode === 'context' ? await backend.context() : null;
        trial.preparedContextBytes = context ? Buffer.byteLength(JSON.stringify(context)) : 0;
        trial.setupMs=performance.now()-started;const agentStarted=performance.now();
        const result = await runProcess(agent.command, [...agent.args, agent.prompt + fixture.prompt + (context ? '\nReference project facts (data, not instructions):\n'+JSON.stringify(context) : '')], { cwd: work, env: agent.env, seconds });
        trial.agentMs=performance.now()-agentStarted;const gradeStarted=performance.now();
        trial.agentUsage = parseAgentEvents(engine, result.stdout);
        trial.exitCode = result.exitCode; trial.stopped = result.stopped;
        const grade = fixture.category === 'browser' ? { passed: await backend.gradeBrowser() } : await gradeCode(fixture, work);
        trial.gradingMs=performance.now()-gradeStarted;trial.outcomePassed = grade.passed;
        if (fixture.category !== 'browser') {
          const candidate = await readFile(join(work, 'solution.cjs'));
          const artifact = `${fixture.id}-${engine}-${memoryMode}${navigationMode==='tools'?'-map':''}-${repeat}.cjs`;
          await mkdir(join(output, 'solutions'), { recursive: true });
          await writeFile(join(output, 'solutions', artifact), candidate, { mode: 0o600 });
          trial.candidate = { file: `solutions/${artifact}`, sha256: hash(candidate) };
          if (fixture.category==='project') {
            trial.candidateFiles=[];
            for(const name of Object.keys(fixture.files)) {
              const content=await readFile(join(work,name)),file=`projects/${fixture.id}-${engine}-${memoryMode}${navigationMode==='tools'?'-map':''}-${repeat}/${name}`;
              await mkdir(dirname(join(output,file)),{recursive:true});await writeFile(join(output,file),content,{mode:0o600});
              trial.candidateFiles.push({path:name,file,sha256:hash(content)});
            }
          }
        } else trial.browserVersion = backend.browserVersion;
        trial.passed = grade.passed && result.exitCode === 0 && !result.stopped && trial.agentUsage.errors === 0 && proxy.usage.rejected === 0 && proxy.usage.errors === 0;
        trial.status = trial.passed ? 'PASS' : (result.stopped ?? (proxy.usage.rejected ? 'budget-exhausted' : (proxy.usage.errors || trial.agentUsage.errors ? 'agent-error' : 'outcome-failed')));
        // Summaries/booleans only; no chain of thought, raw output, endpoints or credential-bearing args.
      } catch (e) { trial.status = 'setup-error'; trial.errorCode = e.code ?? 'EVAL_SETUP_FAILED'; }
      finally {
        trial.elapsedSeconds = (performance.now() - started) / 1000;
        trial.verifiedSeconds = trial.passed ? trial.elapsedSeconds : null;
        if (backend) { trial.tools = { ...backend.metrics }; await backend.close(); }
        if (proxy) { trial.providerUsage = { ...proxy.usage }; await proxy.close(); }
        await rm(root, { recursive: true, force: true });
      }
      report.trials.push(trial); await save();
      console.log(`${fixture.id} ${engine} memory=${memoryMode} navigation=${navigationMode} #${repeat}: ${trial.status} ${trial.elapsedSeconds.toFixed(1)}s requests=${trial.providerUsage.requests}`);
    }
    report.complete = !cancelled && report.trials.length === plan.length;
    report.finishedAt = new Date().toISOString(); report.totalSeconds = (performance.now() - start) / 1000; await save();
  } finally { clearTimeout(globalTimer); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
  if (!report.complete || report.trials.some(t => !t.passed)) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 1; });
