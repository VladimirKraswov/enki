#!/usr/bin/env node
// Explicit-target Pi SDK core upgrade workflow (docs/SDK-UPGRADE.md).
//   --check                                  audit every pin against sdk-contract.mjs
//   --plan    --target X.Y.Z                 list every touched file/field and the gates
//   --prepare --target X.Y.Z --out <dir>     stage ONLY in <dir>: npm metadata+integrity
//            from the trusted registry, `npm ci --ignore-scripts`, candidate descriptor
//            hashes and a review report. The repository is never written.
// A literal X.Y.Z is required: no ranges, tags, "latest" or runtime auto-update.
// Compatibility descriptors are never blessed here; a human reviews and edits them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DESCRIPTOR_FILES, SDK_CONTRACT, auditSdkContract, exactVersion } from './sdk-contract.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AGENT = 'src-tauri/resources/agent';
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function requireTarget(value) {
  if (!exactVersion(value)) throw new Error('--target must be a literal X.Y.Z version (no range, tag or "latest")');
  return value;
}

/** Every file/field a reviewed upgrade changes, and the gates it must pass. */
export function upgradePlan(target, contract = SDK_CONTRACT) {
  requireTarget(target);
  const packages = contract.packages.map(name => `${contract.scope}/${name}`);
  return {
    from: contract.sdk, target, node: contract.node,
    edits: [
      { file: `${AGENT}/package.json`, fields: packages.flatMap(key => [`dependencies.${key}`, `overrides.${key}`]) },
      { file: `${AGENT}/package-lock.json`, fields: ['regenerated in staging by --prepare (root + every nested install, resolved + sha512 integrity)'] },
      { file: `${AGENT}/runtime-lock.json`, fields: ['sdk.version', 'node.* only if the SDK engine requires another pinned Node', 'dataSchema = protocol.ts SCHEMA_VERSION whenever a store migration is added'] },
      { file: `${AGENT}/src/protocol.ts`, fields: ['SDK_VERSION'] },
      { file: '.github/workflows/{desktop,evaluations}.yml', fields: ['node-version only if the pinned Node changes'] },
      { file: `${AGENT}/src/plugin-ui/sdk-ui-compat.ts`, fields: ['version', ...Object.keys(contract.descriptors), 'REVIEW: public types, plugin UI/theme/keybindings, resource loader'] },
      { file: 'scripts/runtime/sdk-contract.mjs', fields: ['sdk', 'descriptors (after review)', 'qualified: ADD target, KEEP previous for paired rollback'] },
    ],
    review: ['diff public SDK declarations for AgentSession/ModelRuntime/extension UI used by src/sdk and src/plugin-ui',
      'prefer newly public upstream exports over the private descriptor files', 'session JSONL format: old-source compatibility and paired rollback'],
    gates: ['npm run sdk:check', 'npm --prefix src-tauri/resources/agent run typecheck', 'npm run test:runtime (Vitest + every *.node.ts suite on the pinned Node)',
      'npm run test:runtime-artifact', 'Mac/Windows/Linux CI artifact + lifecycle jobs', 'remote installer upgrade AND paired rollback rehearsal'],
  };
}

function npmCli(nodeHome) {
  for (const candidate of [path.join(nodeHome, 'node_modules/npm/bin/npm-cli.js'), path.join(nodeHome, '../lib/node_modules/npm/bin/npm-cli.js')]) if (fs.existsSync(candidate)) return path.resolve(candidate);
  throw new Error('npm of the pinned Node interpreter was not found');
}

/** Isolated staging only. Returns the review report (also written to <out>/upgrade-report.json). */
export async function prepareUpgrade({ target, out, repo = REPO, signal }) {
  requireTarget(target);
  const drift = auditSdkContract(repo); if (drift.length) throw new Error(`Current SDK contract drifts; fix first: ${JSON.stringify(drift[0])}`);
  if (process.version !== `v${SDK_CONTRACT.node}`) throw new Error(`Run on the pinned Node v${SDK_CONTRACT.node} (found ${process.version})`);
  if (!path.isAbsolute(out ?? '') || fs.existsSync(out)) throw new Error('--out must be an absolute path that does not exist yet');
  const real = fs.realpathSync(repo), parent = fs.realpathSync(path.dirname(out));
  if (parent === real || parent.startsWith(real + path.sep)) throw new Error('--out must be outside the repository');
  const { buildEnvironment, run } = await import('./prepare.mjs');
  fs.mkdirSync(out, { mode: 0o700 }); const staging = path.join(out, 'agent'), work = path.join(out, 'work'); fs.mkdirSync(staging); fs.mkdirSync(work);
  for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(repo, AGENT, name), path.join(staging, name));
  const pkg = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8'));
  for (const name of SDK_CONTRACT.packages) { const key = `${SDK_CONTRACT.scope}/${name}`; pkg.dependencies[key] = target; pkg.overrides[key] = target; }
  fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  const nodeHome = path.dirname(process.execPath), npm = npmCli(nodeHome), env = buildEnvironment(nodeHome, work);
  await run(process.execPath, [npm, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: staging, env, signal, timeoutMs: 600_000 });
  await run(process.execPath, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: staging, env, signal, timeoutMs: 900_000 });
  const staged = { ...SDK_CONTRACT, sdk: target };
  const lockDrift = auditStagedLock(staging, staged);
  const root = path.join(staging, 'node_modules', SDK_CONTRACT.scope, 'pi-coding-agent'), installed = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const candidate = Object.fromEntries(Object.entries(DESCRIPTOR_FILES).map(([field, file]) => [field, fs.existsSync(path.join(root, file)) ? sha256(path.join(root, file)) : null]));
  const descriptorDiff = Object.fromEntries(Object.keys(candidate).filter(field => candidate[field] !== SDK_CONTRACT.descriptors[field]).map(field => [field, { reviewed: SDK_CONTRACT.descriptors[field], candidate: candidate[field] }]));
  const report = { schema: 1, plan: upgradePlan(target), installedVersion: installed.version, engines: installed.engines ?? null, pinnedNode: SDK_CONTRACT.node,
    lockDrift, descriptorDiff, status: lockDrift.length || installed.version !== target ? 'INVALID_STAGING' : 'REVIEW_REQUIRED',
    note: 'Candidate hashes are NOT compatibility approval. Review the SDK diff, then edit sdk-ui-compat.ts and sdk-contract.mjs by hand.' };
  fs.writeFileSync(path.join(out, 'upgrade-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return report;
}

/** Staged lock: all six packages at target everywhere, registry-resolved, sha512. */
function auditStagedLock(staging, contract) {
  const lock = JSON.parse(fs.readFileSync(path.join(staging, 'package-lock.json'), 'utf8')), drift = [];
  for (const name of contract.packages) {
    const key = `${contract.scope}/${name}`;
    for (const [where, entry] of Object.entries(lock.packages ?? {}).filter(([where]) => where === `node_modules/${key}` || where.endsWith(`/node_modules/${key}`))) {
      if (entry.version !== contract.sdk || entry.resolved !== `https://registry.npmjs.org/${key}/-/${name}-${contract.sdk}.tgz` || !String(entry.integrity ?? '').startsWith('sha512-')) drift.push({ where, version: entry.version ?? null });
    }
    if (lock.packages?.['']?.dependencies?.[key] !== contract.sdk) drift.push({ where: `packages[""].dependencies.${key}` });
  }
  return drift;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2), value = flag => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
  try {
    if (argv.includes('--check')) {
      const drift = auditSdkContract(REPO);
      for (const d of drift) console.error(`${d.file} ${d.field}: expected ${JSON.stringify(d.expected)}, found ${JSON.stringify(d.actual)}`);
      if (drift.length) process.exitCode = 1; else console.log(`SDK contract synchronized: ${SDK_CONTRACT.sdk} on Node ${SDK_CONTRACT.node}`);
    } else if (argv.includes('--plan')) console.log(JSON.stringify(upgradePlan(requireTarget(value('--target'))), null, 2));
    else if (argv.includes('--prepare')) console.log(JSON.stringify(await prepareUpgrade({ target: value('--target'), out: value('--out') }), null, 2));
    else throw new Error('Use --check, --plan --target X.Y.Z, or --prepare --target X.Y.Z --out <dir>');
  } catch (error) { console.error(`sdk:upgrade: ${error.message}`); process.exitCode = 1; }
}
