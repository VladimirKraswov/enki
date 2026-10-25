// Unsupported host Node is refused BEFORE any module that statically imports
// node:sqlite loads: the guard itself has no imports, and every CLI entry
// imports only the guard and loads the real module lazily.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardedMain, hostNodeProblem } from './host-node.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const staticImports = file => [...fs.readFileSync(path.join(here, file), 'utf8').matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]/gm)].map(m => m[1] ?? m[2]);

test('the host guard and the CLI entries load nothing that needs node:sqlite', () => {
  assert.deepEqual(staticImports('host-node.mjs'), []);
  for (const entry of ['prepare-entry.mjs', 'install-remote-entry.mjs']) assert.deepEqual(staticImports(entry), ['./host-node.mjs'], entry);
  // The tauri entry keeps builtins + the guard only (no prepare/artifact import).
  assert.deepEqual(staticImports('tauri-entry.mjs').filter(name => !name.startsWith('node:')), ['./host-node.mjs']);
  // The guarded modules really are the ones that need it.
  assert.ok(staticImports('artifact.mjs').includes('node:sqlite'));
  assert.ok(staticImports('install-remote.mjs').includes('node:sqlite'));
});

test('package scripts route runtime preparation through the guarded entry', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '../../package.json'), 'utf8'));
  assert.equal(pkg.scripts['runtime:prepare'], 'node scripts/runtime/prepare-entry.mjs');
  assert.equal(pkg.scripts.tauri, 'node scripts/runtime/tauri-entry.mjs');
});

test('an unsupported host is refused without loading the module; a supported one runs its main', async () => {
  const errors = [], original = console.error; console.error = message => errors.push(message);
  try {
    for (const version of ['v20.18.1', 'v22.12.0', 'v18.0.0', 'garbage']) {
      let loaded = false;
      const code = await guardedMain('install-remote', './install-remote.mjs', ['--rollback'], { version, action: 'The Enki Runtime installer', consequence: 'nothing was installed or changed', load: async () => { loaded = true; return { main: () => 0 }; } });
      assert.equal(code, 1, version); assert.equal(loaded, false, `${version}: module never loaded`);
    }
    assert.match(errors[0], /^install-remote: The Enki Runtime installer needs host Node\.js >=22\.13.*nothing was installed or changed\.$/);
  } finally { console.error = original; }
  const calls = [];
  const code = await guardedMain('runtime:prepare', './prepare.mjs', ['--platform', 'linux-x64'], { version: 'v24.22.1', load: async specifier => ({ main: async argv => { calls.push([specifier, argv]); return 7; } }) });
  assert.equal(code, 7); assert.deepEqual(calls, [['./prepare.mjs', ['--platform', 'linux-x64']]]);
  assert.equal(hostNodeProblem('v22.13.0'), null);
});

test('the guarded modules export the main their entries call', async () => {
  for (const module of ['./prepare.mjs', './install-remote.mjs']) assert.equal(typeof (await import(module)).main, 'function', module);
});
