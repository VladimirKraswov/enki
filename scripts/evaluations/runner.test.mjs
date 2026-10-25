// Execution-adapter contract of the evaluation runner (no agent, model or
// network is started). The ONLY engine is the pinned bundled Pi SDK. The former
// external OpenCode/Pi CLI baselines are retired by the owner's requirement
// (one agent loop): they are refused, never launched; their historical event
// streams stay parseable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_ENGINES, ENGINES, HISTORICAL_ENGINES, launcher, parseAgentEvents, parseEngines, pinnedSdkCli } from './runner.mjs';
import { SDK_CONTRACT } from '../runtime/sdk-contract.mjs';

const temporary = t => { const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'eval-adapter-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
function sdkPackage(root, manifest) {
  const dir = path.join(root, 'node_modules/@earendil-works/pi-coding-agent');
  fs.mkdirSync(path.join(dir, 'dist/bundle'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  return dir;
}

test('the default run probes no external CLI: it is the pinned bundled SDK only', () => {
  assert.equal(DEFAULT_ENGINES, 'pi-sdk');
  assert.deepEqual(parseEngines(), ['pi-sdk']);
  // Retired external CLIs are refused even on explicit request.
  for (const bad of ['', 'pi-sdk,pi-sdk', 'claude', 'pi-sdk,unknown', 'opencode', 'pi', 'opencode,pi', 'pi-sdk,opencode'])
    assert.throws(() => parseEngines(bad), /Unknown\/duplicate/, bad);
  assert.deepEqual([...ENGINES], ['pi-sdk']);
  assert.deepEqual([...HISTORICAL_ENGINES].sort(), ['opencode', 'pi']);
});

test('pi-sdk launches the verified package CLI with this Node, never PATH', t => {
  const root = temporary(t), dir = sdkPackage(root, { name: '@earendil-works/pi-coding-agent', version: SDK_CONTRACT.sdk, bin: { pi: 'dist/bundle/cli.js' } });
  assert.deepEqual(pinnedSdkCli(root), { cli: path.join(dir, 'dist/bundle/cli.js'), version: SDK_CONTRACT.sdk });
  const sdk = () => pinnedSdkCli(root);
  assert.deepEqual(launcher('pi-sdk', sdk), { command: process.execPath, prefix: [path.join(dir, 'dist/bundle/cli.js')] });
  for (const retired of ['opencode', 'pi']) assert.throws(() => launcher(retired, () => { throw Error('not consulted'); }), { code: 'EVAL_ENGINE_RETIRED' });
  assert.throws(() => launcher('bash'), { code: 'EVAL_UNKNOWN_ENGINE' });
});

test('a missing, foreign, other-version or escaping SDK package is refused', t => {
  assert.throws(() => pinnedSdkCli(temporary(t)), { code: 'EVAL_SDK_MISSING' });
  for (const manifest of [
    { name: '@earendil-works/pi-coding-agent', version: '0.0.1', bin: { pi: 'dist/bundle/cli.js' } },
    { name: 'pi-coding-agent', version: SDK_CONTRACT.sdk, bin: { pi: 'dist/bundle/cli.js' } },
    { name: '@earendil-works/pi-coding-agent', version: SDK_CONTRACT.sdk, bin: { pi: '../../escape.js' } },
    { name: '@earendil-works/pi-coding-agent', version: SDK_CONTRACT.sdk, bin: { pi: '/abs/cli.js' } },
    { name: '@earendil-works/pi-coding-agent', version: SDK_CONTRACT.sdk, bin: 'dist/bundle/cli.js' },
  ]) {
    const root = temporary(t); sdkPackage(root, manifest);
    assert.throws(() => pinnedSdkCli(root), { code: 'EVAL_SDK_UNVERIFIED' }, JSON.stringify(manifest));
  }
});

test('pi-sdk JSON events are parsed exactly like the Pi CLI stream', () => {
  const stream = [JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0 } } }), 'not json', JSON.stringify({ type: 'error' })].join('\n');
  assert.deepEqual(parseAgentEvents('pi-sdk', stream), parseAgentEvents('pi', stream));
  assert.deepEqual(parseAgentEvents('pi-sdk', stream), { assistantTurns: 1, errors: 1, tokens: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0 } });
});
