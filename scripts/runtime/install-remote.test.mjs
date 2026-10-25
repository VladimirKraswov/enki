import './artifact-test-port.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MANIFEST, acquireArtifactLease, buildManifest, sha256File, verifyArtifact } from './artifact.mjs';
import { inspectArtifact, installRemote, publishImmutable } from './install-remote.mjs';
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'remote-publish-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'candidate'), dist = path.join(root, 'dist');
  fs.mkdirSync(path.join(candidate, 'node/bin'), { recursive: true }); fs.mkdirSync(path.join(candidate, 'app/dist'), { recursive: true }); fs.mkdirSync(dist);
  // Deliberately not an executable. Authentication/publish must not run it.
  fs.writeFileSync(path.join(candidate, 'node/bin/node'), 'THIS_MUST_NEVER_EXECUTE');
  fs.writeFileSync(path.join(candidate, 'app/dist/main.js'), "throw Error('CANDIDATE_MAIN_MUST_NOT_EXECUTE')");
  fs.writeFileSync(path.join(candidate, 'app/dist/daemon-control.js'), "throw Error('AUTHENTICATED_CONTROL_IMPORT')");
  fs.writeFileSync(path.join(candidate, 'app/package-lock.json'), '{}'); fs.writeFileSync(path.join(candidate, 'app/runtime-lock.json'), '{}');
  fs.writeFileSync(path.join(candidate, 'app/runtime-version.json'), JSON.stringify({ version: '1234567890abcdef', sdk: '0.85.1', node: '24.22.1', dataSchema: 2, contract: 1 }));
  const manifest = buildManifest(candidate, { version: '0.85.1-1234567890abcdef', contract: 1, node: 'node/bin/node', entry: 'app/dist/main.js' });
  fs.writeFileSync(path.join(candidate, MANIFEST), JSON.stringify(manifest));
  return { root, candidate, dist, hash: sha256File(path.join(candidate, MANIFEST)), manifest };
}
test('candidate authentication is required before dynamic import or creating a data directory', async t => {
  const f = fixture(t), data = path.join(f.root, 'untouched');
  await assert.rejects(installRemote({ dist: f.dist, candidate: f.candidate, expectedManifestSha256: 'a'.repeat(64), data }), /authentication/);
  assert.equal(fs.existsSync(data), false); assert.deepEqual(fs.readdirSync(f.dist), []);
  await assert.rejects(installRemote({ dist: f.dist, candidate: f.candidate, data }), /Authenticated expected/);
});
test('tampered candidate payload fails all-file verification even with the correct authenticated manifest digest', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.candidate, 'app/dist/daemon-control.js'), "throw Error('UNVERIFIED_CONTROL_RAN')");
  await assert.rejects(installRemote({ dist: f.dist, candidate: f.candidate, expectedManifestSha256: f.hash, data: path.join(f.root, 'data') }), /hash mismatch/);
  assert.deepEqual(fs.readdirSync(f.dist), []);
});
test('immutable publisher verifies both newly copied and already existing versions, refusing corruption', t => {
  const f = fixture(t), lease = acquireArtifactLease(f.dist);
  try {
  const target = publishImmutable(f.dist, f.candidate, f.hash); assert.deepEqual(verifyArtifact(target), []);
  const before = fs.statSync(target); assert.equal(publishImmutable(f.dist, f.candidate, f.hash), target); assert.equal(fs.statSync(target).ino, before.ino);
  fs.writeFileSync(path.join(target, 'node/bin/node'), 'CORRUPT_EXISTING');
  assert.throws(() => publishImmutable(f.dist, f.candidate, f.hash), /hash mismatch/); assert.equal(fs.readFileSync(path.join(target, 'node/bin/node'), 'utf8'), 'CORRUPT_EXISTING');
  } finally { lease.release(); } // Close the owned OS lease before fixture teardown.
});
test('publisher OS lease spans asynchronous work and concurrent acquisition cannot replace or unlink it', async t => {
  const f = fixture(t), first = acquireArtifactLease(f.dist); const file = path.join(f.dist, '.runtime-artifact-lease.sqlite'), before = fs.statSync(file).ino;
  try { await new Promise(resolve => setTimeout(resolve, 5)); assert.throws(() => acquireArtifactLease(f.dist), /locked/); assert.equal(fs.statSync(file).ino, before); }
  finally { first.release(); }
  const again = acquireArtifactLease(f.dist); again.release(); assert.equal(fs.statSync(file).ino, before);
});
test('portable version and runtime metadata reject mismatches before invoking the candidate', t => {
  const f = fixture(t); assert.equal(inspectArtifact(f.candidate, f.hash).info.dataSchema, 2);
  const info = path.join(f.candidate, 'app/runtime-version.json'); const value = JSON.parse(fs.readFileSync(info, 'utf8')); value.version = 'abcdef1234567890'; fs.writeFileSync(info, JSON.stringify(value));
  const changed = buildManifest(f.candidate, { version: f.manifest.version, contract: 1, node: 'node/bin/node', entry: 'app/dist/main.js' }); fs.writeFileSync(path.join(f.candidate, MANIFEST), JSON.stringify(changed));
  assert.throws(() => inspectArtifact(f.candidate, sha256File(path.join(f.candidate, MANIFEST))), /metadata/);
});
