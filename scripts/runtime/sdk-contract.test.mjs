// The SDK/Node contract audit: the committed tree is synchronized, and every
// single deliberate drift fails with its precise file/field before any build.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SDK_CONTRACT, auditSdkContract, qualifiedRuntime } from './sdk-contract.mjs';
import { requireTarget, upgradePlan } from './sdk-upgrade.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AGENT = 'src-tauri/resources/agent';
const FILES = [`${AGENT}/package.json`, `${AGENT}/package-lock.json`, `${AGENT}/runtime-lock.json`, `${AGENT}/src/protocol.ts`,
  `${AGENT}/src/plugin-ui/sdk-ui-compat.ts`, `${AGENT}/src/plugin-ui/resource-compat.ts`, `${AGENT}/build.mjs`, '.github/workflows/desktop.yml', '.github/workflows/evaluations.yml'];
function copy(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sdk-contract-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of FILES) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.copyFileSync(path.join(REPO, name), path.join(root, name)); }
  return root;
}
const editJson = (root, name, edit) => { const file = path.join(root, name), value = JSON.parse(fs.readFileSync(file, 'utf8')); edit(value); fs.writeFileSync(file, JSON.stringify(value)); };
const protocolSchema = () => Number(/export const SCHEMA_VERSION = (\d+);/.exec(fs.readFileSync(path.join(REPO, AGENT, 'src/protocol.ts'), 'utf8'))[1]);
const editText = (root, name, from, to) => { const file = path.join(root, name), text = fs.readFileSync(file, 'utf8'); assert.ok(text.includes(from), `${name} contains ${from}`); fs.writeFileSync(file, text.replace(from, to)); };

test('the committed tree is synchronized with the reviewed contract', () => {
  assert.deepEqual(auditSdkContract(REPO), []);
  assert.ok(qualifiedRuntime(SDK_CONTRACT.sdk, SDK_CONTRACT.node));
});

test('each single deliberate pin/hash drift fails with its exact field', t => {
  const key = '@earendil-works/pi-tui';
  const cases = [
    [r => editJson(r, `${AGENT}/package.json`, v => { v.dependencies[key] = '0.85.2'; }), `dependencies.${key}`],
    [r => editJson(r, `${AGENT}/package.json`, v => { v.overrides[key] = '^0.85.1'; }), `overrides.${key}`],
    [r => editJson(r, `${AGENT}/package-lock.json`, v => { v.packages[''].dependencies[key] = '0.85.2'; }), `packages[""].dependencies.${key}`],
    [r => editJson(r, `${AGENT}/package-lock.json`, v => { v.packages[`node_modules/${key}`].version = '0.85.2'; }), `packages["node_modules/${key}"].version`],
    [r => editJson(r, `${AGENT}/package-lock.json`, v => { v.packages[`node_modules/${key}`].integrity = 'sha1-x'; }), `packages["node_modules/${key}"].integrity`],
    [r => editJson(r, `${AGENT}/runtime-lock.json`, v => { v.sdk.version = '0.85.2'; }), 'sdk.version'],
    [r => editJson(r, `${AGENT}/runtime-lock.json`, v => { v.node.version = '24.22.2'; }), 'node.version'],
    [r => editText(r, `${AGENT}/src/protocol.ts`, `SDK_VERSION = "${SDK_CONTRACT.sdk}"`, 'SDK_VERSION = "0.85.2"'), 'SDK_VERSION'],
    [r => editText(r, `${AGENT}/src/plugin-ui/sdk-ui-compat.ts`, SDK_CONTRACT.descriptors.themeSha256, '0'.repeat(64)), 'themeSha256'],
    [r => editText(r, `${AGENT}/src/plugin-ui/sdk-ui-compat.ts`, SDK_CONTRACT.descriptors.resourceLoaderSha256, '1'.repeat(64)), 'resourceLoaderSha256'],
    [r => editText(r, `${AGENT}/build.mjs`, 'runtimePin.sdk.version', '"0.85.1"'), 'SDK pin source'],
    [r => editText(r, '.github/workflows/desktop.yml', `node-version: ${SDK_CONTRACT.node}`, 'node-version: 24'), 'node-version'],
    [r => editText(r, '.github/workflows/evaluations.yml', `node-version: ${SDK_CONTRACT.node}`, 'node-version: 24'), 'node-version'],
    // Data schema: protocol.ts is the authority; the stale runtime-lock copy
    // (written into runtime-version.json) is the drift, in either direction.
    [r => editJson(r, `${AGENT}/runtime-lock.json`, v => { v.dataSchema = protocolSchema() - 1; }), 'dataSchema'],
    [r => editText(r, `${AGENT}/src/protocol.ts`, `SCHEMA_VERSION = ${protocolSchema()};`, `SCHEMA_VERSION = ${protocolSchema() + 1};`), 'dataSchema'],
    [r => editText(r, `${AGENT}/src/protocol.ts`, `SCHEMA_VERSION = ${protocolSchema()};`, 'SCHEMA_VERSION = Number("3");'), 'SCHEMA_VERSION'],
    [r => editText(r, `${AGENT}/build.mjs`, 'runtimePin.dataSchema', '3'), 'data schema source'],
    // Qualification probes: ONE consumer hardcoded while the binding and every
    // other reference stay intact (formerly all returned []).
    [r => editText(r, `${AGENT}/build.mjs`, 'pkg.dependencies[key] !== PINNED_SDK', `pkg.dependencies[key] !== "${SDK_CONTRACT.sdk}"`), 'SDK dependency check'],
    [r => editText(r, `${AGENT}/build.mjs`, 'installed.version !== PINNED_SDK', `installed.version !== "${SDK_CONTRACT.sdk}"`), 'SDK dependency check'],
    [r => editText(r, `${AGENT}/build.mjs`, '["SCHEMA_VERSION", PINNED_DATA_SCHEMA]', `["SCHEMA_VERSION", ${protocolSchema()}]`), 'SCHEMA_VERSION guard'],
    [r => editText(r, `${AGENT}/build.mjs`, '["SDK_VERSION", PINNED_SDK]', `["SDK_VERSION", "${SDK_CONTRACT.sdk}"]`), 'SDK_VERSION guard'],
    [r => editText(r, `${AGENT}/build.mjs`, '["CONTRACT_VERSION", PINNED_CONTRACT]', '["CONTRACT_VERSION", 1]'), 'CONTRACT_VERSION guard'],
    [r => editText(r, `${AGENT}/build.mjs`, 'dataSchema: PINNED_DATA_SCHEMA,', `dataSchema: ${protocolSchema()},`), 'artifact dataSchema'],
    [r => editText(r, `${AGENT}/build.mjs`, 'sdk: PINNED_SDK,', 'sdk: pkg.dependencies["@earendil-works/pi-coding-agent"],'), 'artifact sdk'],
    [r => editText(r, `${AGENT}/build.mjs`, 'contract: PINNED_CONTRACT,', 'contract: 1,'), 'artifact contract'],
    // A second, unaudited read of a lock field is drift even if all sites remain.
    [r => editText(r, `${AGENT}/build.mjs`, 'const PINNED_CONTRACT', 'const SHADOW = runtimePin.sdk.version;\nconst PINNED_CONTRACT'), 'SDK pin source'],
  ];
  for (const [mutate, field] of cases) {
    const root = copy(t); mutate(root);
    const drift = auditSdkContract(root);
    assert.equal(drift.length, 1, `${field}: ${JSON.stringify(drift)}`);
    assert.equal(drift[0].field, field);
  }
});

test('the upgrade command requires a literal target and lists every touched pin', () => {
  for (const bad of [undefined, '', 'latest', '^0.86.0', '0.86', '0.86.x', '>=0.86.0', 'v0.86.0', '0.86.0-beta.1']) assert.throws(() => requireTarget(bad), /literal X\.Y\.Z/, String(bad));
  assert.equal(requireTarget('0.86.0'), '0.86.0');
  const plan = upgradePlan('0.86.0'), files = plan.edits.map(edit => edit.file);
  for (const name of FILES.slice(0, 5)) assert.ok(files.includes(name), name);
  assert.ok(files.includes('scripts/runtime/sdk-contract.mjs'));
  assert.ok(plan.edits.find(edit => edit.file.endsWith('sdk-ui-compat.ts')).fields.some(field => /REVIEW/.test(field)), 'descriptor change requires review');
  assert.ok(plan.gates.some(gate => /test:runtime/.test(gate)));
});
