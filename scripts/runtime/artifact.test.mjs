// node --test scripts/runtime/*.test.mjs
// Artifact verification, lock review gate and atomic upgrade/rollback of the
// bundled runtime. Uses temporary directories only; downloads nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MANIFEST, buildManifest, listFiles, parseShasums, promote, rollback, safeRelative, setDirectoryFlushPort, validateLock, verifyArtifact,
} from './artifact.mjs';
import { trustedRunner } from './native-port.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temp = (tag) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `enki-artifact-${tag}-`)));
// Windows promotion needs the native durable flush port: the exact runner from
// the bootstrap receipt (`node scripts/runtime/build-runner.mjs --out <dir>`).
const windowsPort = process.platform === 'win32' && process.env.ENKI_TEST_NATIVE_RUNNER
  ? trustedRunner({ path: process.env.ENKI_TEST_NATIVE_RUNNER, sha256: process.env.ENKI_TEST_NATIVE_RUNNER_SHA256 }) : undefined;
if (windowsPort) setDirectoryFlushPort(windowsPort);
const promotion = { skip: process.platform === 'win32' && !windowsPort && 'Windows promotion requires ENKI_TEST_NATIVE_RUNNER(+_SHA256) (native flush port)' };

function fakeArtifact(root, version, marker = version) {
  fs.mkdirSync(path.join(root, 'node/bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app/dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node/bin/node'), `node ${marker}`);
  fs.writeFileSync(path.join(root, 'app/dist/main.js'), `// main ${marker}`);
  fs.writeFileSync(path.join(root, 'app/package.json'), '{}');
  const manifest = buildManifest(root, { version, contract: 1, node: 'node/bin/node', entry: 'app/dist/main.js' });
  fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify(manifest));
  return root;
}

const pinnedLock = () => {
  const hex = 'a'.repeat(64);
  return {
    schema: 1, contract: 1, sdk: { version: '0.85.1' },
    node: {
      version: '22.19.0', source: 'https://nodejs.org/dist/v22.19.0/',
      artifacts: {
        'darwin-arm64': { file: 'node-v22.19.0-darwin-arm64.tar.gz', binary: 'bin/node', sha256: hex },
        'win32-x64': { file: 'node-v22.19.0-win-x64.zip', binary: 'node.exe', sha256: hex },
        'linux-x64': { file: 'node-v22.19.0-linux-x64.tar.xz', binary: 'bin/node', sha256: hex },
      },
    },
    review: { status: 'PINNED' },
  };
};

test('the committed lock fails closed until a reviewer pins every checksum', () => {
  const committed = JSON.parse(fs.readFileSync(path.join(repo, 'src-tauri/resources/agent/runtime-lock.json'), 'utf8'));
  if (committed.review?.status === 'PINNED') {
    for (const platform of ['darwin-arm64', 'win32-x64', 'linux-x64']) assert.ok(validateLock(committed, platform).sha256);
  } else {
    assert.throws(() => validateLock(committed, 'linux-x64'), /not reviewed|sha256/);
  }
  assert.equal(committed.sdk.version, '0.85.1');
  const agent = JSON.parse(fs.readFileSync(path.join(repo, 'src-tauri/resources/agent/package.json'), 'utf8'));
  assert.equal(agent.dependencies['@earendil-works/pi-coding-agent'], '0.85.1', 'SDK must be an exact pin');
});

test('lock validation refuses unofficial sources, old Node and malformed hashes', () => {
  assert.ok(validateLock(pinnedLock(), 'linux-x64'));
  const unofficial = pinnedLock(); unofficial.node.source = 'https://mirror.example/node/';
  assert.throws(() => validateLock(unofficial, 'linux-x64'), /official/);
  const old = pinnedLock(); old.node.version = '22.18.0';
  assert.throws(() => validateLock(old, 'linux-x64'), /22\.19/);
  const bad = pinnedLock(); bad.node.artifacts['win32-x64'].sha256 = 'XYZ';
  assert.throws(() => validateLock(bad, 'linux-x64'), /win32-x64/);
  const unreviewed = pinnedLock(); unreviewed.review.status = 'UNPINNED';
  assert.throws(() => validateLock(unreviewed, 'linux-x64'), /not reviewed/);
  assert.throws(() => validateLock(pinnedLock(), 'freebsd-x64'), /Unsupported/);
});

test('SHASUMS256 parsing keeps exact file names', () => {
  const parsed = parseShasums(`${'b'.repeat(64)}  node-v22.19.0-linux-x64.tar.xz\n${'c'.repeat(64)} *node-v22.19.0-win-x64.zip\njunk\n`);
  assert.equal(parsed['node-v22.19.0-linux-x64.tar.xz'], 'b'.repeat(64));
  assert.equal(parsed['node-v22.19.0-win-x64.zip'], 'c'.repeat(64));
});

test('manifest paths mirror the native supervisor rules', () => {
  for (const ok of ['node/bin/node', 'app/dist/main.js']) assert.ok(safeRelative(ok));
  for (const bad of ['', '/etc/passwd', '../x', 'a/../../b', 'a\\b', 'a//b', './a']) assert.equal(safeRelative(bad), false, bad);
});

test('a verified artifact detects tampering, unlisted and missing files', () => {
  const root = fakeArtifact(temp('verify'), '0.85.1-0123456789abcdef');
  assert.deepEqual(verifyArtifact(root), []);
  fs.writeFileSync(path.join(root, 'app/dist/main.js'), '// changed');
  assert.ok(verifyArtifact(root).some((p) => p.startsWith('hash mismatch app/dist/main.js')));
  fs.writeFileSync(path.join(root, 'app/extra.js'), 'x');
  assert.ok(verifyArtifact(root).some((p) => p === 'unlisted file app/extra.js'));
  fs.rmSync(path.join(root, 'node/bin/node'));
  assert.ok(verifyArtifact(root).some((p) => p === 'missing node/bin/node'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('symbolic links are refused in artifacts', { skip: process.platform === 'win32' }, () => {
  const root = fakeArtifact(temp('link'), '1.0.0');
  fs.symlinkSync('/etc/hosts', path.join(root, 'app/link'));
  assert.throws(() => listFiles(root), /symbolic link/);
  assert.throws(() => buildManifest(root, { version: '1.0.0', contract: 1, node: 'node/bin/node', entry: 'app/dist/main.js' }), /symbolic link/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('upgrade is an atomic swap and rollback restores the previous artifact', promotion, () => {
  const root = temp('promote');
  const first = fakeArtifact(path.join(root, 'stage-1'), '0.85.1-aaaaaaaaaaaaaaaa', 'one');
  promote(root, first);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'current', MANIFEST))).version, '0.85.1-aaaaaaaaaaaaaaaa');
  const second = fakeArtifact(path.join(root, 'stage-2'), '0.85.1-bbbbbbbbbbbbbbbb', 'two');
  promote(root, second);
  assert.equal(fs.readFileSync(path.join(root, 'current/node/bin/node'), 'utf8'), 'node two');
  assert.equal(fs.readFileSync(path.join(root, 'previous/node/bin/node'), 'utf8'), 'node one');
  rollback(root);
  assert.equal(fs.readFileSync(path.join(root, 'current/node/bin/node'), 'utf8'), 'node one');
  assert.equal(fs.readFileSync(path.join(root, 'previous/node/bin/node'), 'utf8'), 'node two');
  assert.deepEqual(verifyArtifact(path.join(root, 'current')), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unverified staging artifact is never promoted and current stays intact', promotion, () => {
  const root = temp('refuse');
  promote(root, fakeArtifact(path.join(root, 'stage-ok'), '1.0.0', 'good'));
  const broken = fakeArtifact(path.join(root, 'stage-bad'), '1.0.1', 'bad');
  fs.writeFileSync(path.join(broken, 'node/bin/node'), 'tampered');
  // The verifier's actual message names the exact failure (tampered bytes).
  assert.throws(() => promote(root, broken), /Artifact does not verify: hash mismatch/);
  assert.equal(fs.readFileSync(path.join(root, 'current/node/bin/node'), 'utf8'), 'node good');
  assert.throws(() => rollback(root), /No previous/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('runtime build outputs stay outside the native fingerprint inputs', () => {
  const ignore = fs.readFileSync(path.join(repo, 'src-tauri/resources/agent/.gitignore'), 'utf8');
  for (const entry of ['node_modules', 'dist', 'runtime-version.json']) assert.match(ignore, new RegExp(`^/?${entry.replace('.', '\\.')}/?$`, 'm'));
  const overlay = JSON.parse(fs.readFileSync(path.join(repo, 'src-tauri/tauri.runtime.conf.json'), 'utf8'));
  for (const source of Object.keys(overlay.bundle.resources)) assert.ok(source.startsWith('target/'), source);
  const build = fs.readFileSync(path.join(repo, 'src-tauri/resources/agent/build.mjs'), 'utf8');
  assert.match(build, /must run in a staging copy/);
});
