// The ONE reviewed Pi SDK / runtime Node compatibility contract. Every pinned
// literal elsewhere is audited against it (auditSdkContract) before artifact
// preparation, in CI and by `npm run sdk:upgrade -- --check`. Changing it is a
// reviewed source change (docs/SDK-UPGRADE.md); nothing here selects "latest"
// or updates anything at runtime. No side effects at import.
import fs from 'node:fs';
import path from 'node:path';

export const SDK_CONTRACT = Object.freeze({
  scope: '@earendil-works',
  packages: Object.freeze(['pi-agent-core', 'pi-ai', 'pi-coding-agent', 'pi-tui', 'chord', 'pi-telemetry']),
  sdk: '0.85.1',
  node: '24.22.1',
  // PRIVATE compatibility boundary (plugin-ui/sdk-ui-compat.ts). Hashes are
  // copied here only by a human reviewer after the API review; the upgrade
  // tool computes candidates but never writes or blesses them.
  descriptors: Object.freeze({
    packageJsonSha256: 'f1738e4b42203e5f22bcb513f13fb2fb224f1e98d1f129ff042f87048665a94c',
    keybindingsSha256: '588794892300bacf84ddbea13e44882a63d9f03ddfeab5bdbe22cdb9d1816a73',
    themeSha256: '5ced0adb09ca8ce0f9b4eefcf89825755e9873cd53388825694025a4b046d1d5',
    resourceLoaderSha256: 'a1393de916487a2c47107ac7239f3139dcdb938705f88ba1ea5a954b3c8bb483',
  }),
  // Runtimes the trusted remote updater may install or roll back to. A newly
  // reviewed SDK is ADDED; the previous entry stays while exact paired rollback
  // to it must remain possible.
  qualified: Object.freeze([Object.freeze({ sdk: '0.85.1', node: '24.22.1' })]),
});
// Files hashed by the private descriptor, relative to the pi-coding-agent package.
export const DESCRIPTOR_FILES = Object.freeze({ packageJsonSha256: 'package.json', keybindingsSha256: 'dist/core/keybindings.js',
  themeSha256: 'dist/modes/interactive/theme/theme.js', resourceLoaderSha256: 'dist/core/extensions/loader.js' });

export const qualifiedRuntime = (sdk, node) => SDK_CONTRACT.qualified.some(entry => entry.sdk === sdk && entry.node === node);
export const exactVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);

/** Every place a pin lives, compared field by field. Returns precise drifts
 * `{ file, field, expected, actual }`; empty means synchronized. */
export function auditSdkContract(repo, contract = SDK_CONTRACT) {
  const drift = [], agent = path.join(repo, 'src-tauri/resources/agent');
  const check = (file, field, expected, actual) => { if (actual !== expected) drift.push({ file, field, expected, actual: actual ?? null }); };
  const json = file => JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8'));
  const text = file => fs.readFileSync(path.join(repo, file), 'utf8');
  const pkg = json('src-tauri/resources/agent/package.json'), lock = json('src-tauri/resources/agent/package-lock.json');
  for (const name of contract.packages) {
    const key = `${contract.scope}/${name}`;
    check('src-tauri/resources/agent/package.json', `dependencies.${key}`, contract.sdk, pkg.dependencies?.[key]);
    check('src-tauri/resources/agent/package.json', `overrides.${key}`, contract.sdk, pkg.overrides?.[key]);
    check('src-tauri/resources/agent/package-lock.json', `packages[""].dependencies.${key}`, contract.sdk, lock.packages?.['']?.dependencies?.[key]);
    const installs = Object.entries(lock.packages ?? {}).filter(([where]) => where === `node_modules/${key}` || where.endsWith(`/node_modules/${key}`));
    if (!installs.some(([where]) => where === `node_modules/${key}`)) check('src-tauri/resources/agent/package-lock.json', `packages["node_modules/${key}"]`, 'present', 'absent');
    for (const [where, entry] of installs) {
      check('src-tauri/resources/agent/package-lock.json', `packages["${where}"].version`, contract.sdk, entry.version);
      check('src-tauri/resources/agent/package-lock.json', `packages["${where}"].resolved`, `https://registry.npmjs.org/${key}/-/${name}-${contract.sdk}.tgz`, entry.resolved);
      check('src-tauri/resources/agent/package-lock.json', `packages["${where}"].integrity`, 'sha512', String(entry.integrity ?? '').split('-')[0]);
    }
  }
  const runtimeLock = json('src-tauri/resources/agent/runtime-lock.json');
  check('src-tauri/resources/agent/runtime-lock.json', 'sdk.package', `${contract.scope}/pi-coding-agent`, runtimeLock.sdk?.package);
  check('src-tauri/resources/agent/runtime-lock.json', 'sdk.version', contract.sdk, runtimeLock.sdk?.version);
  check('src-tauri/resources/agent/runtime-lock.json', 'node.version', contract.node, runtimeLock.node?.version);
  const protocol = text('src-tauri/resources/agent/src/protocol.ts');
  check('src-tauri/resources/agent/src/protocol.ts', 'SDK_VERSION', contract.sdk, /export const SDK_VERSION = "([^"]+)";/.exec(protocol)?.[1]);
  // The data schema has ONE authority: protocol.ts SCHEMA_VERSION (the real
  // Database user_version, native build.rs and paired backup receipts). The
  // runtime-lock copy is what build.mjs writes into the authenticated
  // runtime-version.json and what install-remote pairs backups against, so a
  // stale copy makes every real paired backup of the new runtime unrestorable.
  const schemaMatch = /export const SCHEMA_VERSION = ([1-9]\d*);/.exec(protocol);
  check('src-tauri/resources/agent/src/protocol.ts', 'SCHEMA_VERSION', 'positive integer literal', schemaMatch ? 'positive integer literal' : null);
  if (schemaMatch) check('src-tauri/resources/agent/runtime-lock.json', 'dataSchema', Number(schemaMatch[1]), runtimeLock.dataSchema);
  auditBuildBindings(text('src-tauri/resources/agent/build.mjs'), check);
  const compat = text('src-tauri/resources/agent/src/plugin-ui/sdk-ui-compat.ts');
  check('src-tauri/resources/agent/src/plugin-ui/sdk-ui-compat.ts', 'version', contract.sdk, /name: "@earendil-works\/pi-coding-agent", version: "([^"]+)"/.exec(compat)?.[1]);
  for (const [field, value] of Object.entries(contract.descriptors)) check('src-tauri/resources/agent/src/plugin-ui/sdk-ui-compat.ts', field, value, new RegExp(`${field}: "([a-f0-9]{64})"`).exec(compat)?.[1]);
  check('src-tauri/resources/agent/src/plugin-ui/resource-compat.ts', 'loader hash source', 'SDK_UI_COMPAT_0851.resourceLoaderSha256',
    /SDK_UI_COMPAT_0851\.resourceLoaderSha256/.exec(text('src-tauri/resources/agent/src/plugin-ui/resource-compat.ts'))?.[0]);
  check('scripts/runtime/sdk-contract.mjs', 'qualified includes current', true, qualifiedRuntime(contract.sdk, contract.node));
  // CI interpreter pin (repository checkouts only; device source packets may omit CI files).
  for (const [file, pattern] of [['.github/workflows/desktop.yml', /node-version:\s*["']?([0-9.]+)["']?/g], ['.github/workflows/evaluations.yml', /node-version:\s*["']?([0-9.]+)["']?/g]]) {
    if (!fs.existsSync(path.join(repo, file))) continue;
    const found = [...text(file).matchAll(pattern)].map(match => match[1]);
    if (!found.length) check(file, 'node-version', contract.node, 'absent');
    for (const version of found) check(file, 'node-version', contract.node, version);
  }
  return drift;
}

/**
 * build.mjs: each pin has exactly ONE binding to runtime-lock.json, and EVERY
 * semantic consumer (dependency refusal, protocol guards, authenticated
 * artifact metadata) uses that binding. Each site is its own field, so a single
 * hardcoded consumer is reported even while other references remain intact.
 */
const BUILD_BINDINGS = Object.freeze([
  ['SDK pin source', /^const PINNED_SDK = runtimePin\.sdk\.version;\r?$/gm, /runtimePin\.sdk\.version/g],
  ['data schema source', /^const PINNED_DATA_SCHEMA = runtimePin\.dataSchema;\r?$/gm, /runtimePin\.dataSchema/g],
  ['contract source', /^const PINNED_CONTRACT = runtimePin\.contract;\r?$/gm, /runtimePin\.contract\b/g],
  ['SDK dependency check', /pkg\.dependencies\[key\] !== PINNED_SDK \|\| pkg\.overrides\?\.\[key\] !== PINNED_SDK \|\| installed\.version !== PINNED_SDK\)/g],
  ['CONTRACT_VERSION guard', /\["CONTRACT_VERSION", PINNED_CONTRACT\]/g],
  ['SCHEMA_VERSION guard', /\["SCHEMA_VERSION", PINNED_DATA_SCHEMA\]/g],
  ['SDK_VERSION guard', /\["SDK_VERSION", PINNED_SDK\]/g],
  ['artifact sdk', /\bsdk: PINNED_SDK,/g],
  ['artifact contract', /\bcontract: PINNED_CONTRACT,/g],
  ['artifact dataSchema', /\bdataSchema: PINNED_DATA_SCHEMA,/g],
]);
export function auditBuildBindings(source, check, file = 'src-tauri/resources/agent/build.mjs') {
  const count = pattern => [...source.matchAll(pattern)].length;
  for (const [field, site, raw] of BUILD_BINDINGS) {
    const sites = count(site);
    // A second, unaudited read of the same lock field is also drift.
    const reads = raw ? count(raw) : sites;
    check(file, field, 'exactly one audited binding', sites === 1 && reads === 1 ? 'exactly one audited binding' : `${sites} binding(s), ${reads} lock read(s)`);
  }
}

/** Throws with every differing field: used before artifact preparation. */
export function assertSdkContract(repo) {
  const drift = auditSdkContract(repo);
  if (drift.length) throw new Error(`SDK contract drift (fix before preparing artifacts):\n${drift.map(d => `  ${d.file} ${d.field}: expected ${JSON.stringify(d.expected)}, found ${JSON.stringify(d.actual)}`).join('\n')}`);
}
