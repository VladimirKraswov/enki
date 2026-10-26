// Deterministic, offline normalization of an owned npm staging tree. Never
// touches global/user packages and never asks npm to resolve a newer version.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TARGETS = new Set(['darwin-arm64', 'linux-x64', 'win32-x64']);
const DEPENDENCIES = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const contained = (root, file) => file === root || file.startsWith(root + path.sep);

/** Refuse links/special files before any deletion, except npm .bin links whose
 * resolved file stays in this staging tree. Bound both entry count and depth. */
function inspect(root) {
  if (!path.isAbsolute(root) || fs.realpathSync.native(root) !== root || !fs.lstatSync(root).isDirectory()) throw Error('Compaction requires a physical staging root');
  let count = 0;
  const walk = (directory, depth) => {
    if (depth > 64) throw Error('Compaction depth limit');
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++count > 200_000) throw Error('Compaction entry limit');
      const file = path.join(directory, item.name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        if (path.basename(directory) !== '.bin' || !contained(root, fs.realpathSync.native(file)) || !fs.statSync(file).isFile()) throw Error('Compaction refuses package links');
      } else if (stat.isDirectory()) walk(file, depth + 1);
      else if (!stat.isFile()) throw Error('Compaction refuses special files');
    }
  };
  walk(root, 0);
}

function packages(root) {
  const found = [];
  const modules = directory => {
    if (!fs.existsSync(directory)) return;
    for (const item of fs.readdirSync(directory).sort()) {
      if (item.startsWith('.')) continue;
      const file = path.join(directory, item);
      if (!fs.statSync(file).isDirectory()) continue;
      if (item.startsWith('@')) {
        for (const child of fs.readdirSync(file).sort()) add(path.join(file, child));
      } else add(file);
    }
  };
  const add = directory => {
    const file = path.join(directory, 'package.json');
    if (!fs.existsSync(file)) return;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    found.push({ directory, pkg }); modules(path.join(directory, 'node_modules'));
  };
  modules(path.join(root, 'node_modules'));
  return found;
}

function supports(values, target) {
  if (values === undefined) return true;
  if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) throw Error('Invalid npm platform selector');
  const positive = values.filter(v => !v.startsWith('!'));
  return !values.includes('!' + target) && (positive.length === 0 || positive.includes(target) || positive.includes('any'));
}

function resolvePackage(root, from, name) {
  if (!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) throw Error('Unsafe dependency name');
  for (let directory = from; contained(root, directory); directory = path.dirname(directory)) {
    if (path.basename(directory) !== 'node_modules') {
      const candidate = path.join(directory, 'node_modules', ...name.split('/'));
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    }
    if (directory === root) break;
  }
  return undefined;
}

/** A duplicate is removable only with byte-identical contents, no nested
 * modules/bin/native addon, and equivalent declared dependency/peer resolution.
 * Keeping native addons avoids changing their helper and ABI lookup paths. */
export function compactDependencies(app, platform) {
  if (!TARGETS.has(platform)) throw Error('Unknown compaction platform');
  const root = path.resolve(app); inspect(root);
  const [os, cpu] = platform.split('-'), removed = [];
  let savedBytes = 0;
  const treeBytes = directory => {
    let size = 0;
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) size += treeBytes(file);
      else if (item.isFile()) size += fs.statSync(file).size;
    }
    return size;
  };
  const remove = (directory, reason) => {
    savedBytes += treeBytes(directory); removed.push({ path: path.relative(root, directory).split(path.sep).join('/'), reason });
    fs.rmSync(directory, { recursive: true });
  };
  // Foreign esbuild optional packages also occur several levels below the SDK.
  // Plan removals first: malformed metadata must not cause partial deletion.
  const foreign = packages(root).filter(({ pkg }) => typeof pkg.name === 'string' && pkg.name.startsWith('@esbuild/') &&
    (!supports(pkg.os, os) || !supports(pkg.cpu, cpu)));
  for (const { directory } of foreign) if (fs.existsSync(directory)) remove(directory, 'foreign-platform');

  const fingerprints = new Map();
  const fingerprint = directory => {
    if (fingerprints.has(directory)) return fingerprints.get(directory);
    const lines = []; let eligible = true;
    const walk = (at, relative = '') => {
      for (const item of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        const file = path.join(at, item.name), name = relative + item.name;
        if (item.name === 'node_modules' || item.name.endsWith('.node') || item.isSymbolicLink()) { eligible = false; continue; }
        if (item.isDirectory()) walk(file, name + '/');
        else lines.push(name + '\0' + (fs.statSync(file).mode & 0o111) + '\0' + hash(fs.readFileSync(file)));
      }
    };
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (pkg.bin || pkg.gypfile || pkg.scripts?.install || pkg.scripts?.postinstall) eligible = false;
    walk(directory);
    const value = eligible ? hash(lines.join('\n')) : undefined;
    fingerprints.set(directory, value); return value;
  };
  const equivalent = (left, right, seen = new Set()) => {
    if (left === right) return true;
    if (!left || !right) return false;
    const a = fingerprint(left), b = fingerprint(right);
    if (!a || a !== b) return false;
    const key = left + '\0' + right;
    if (seen.has(key)) return true;
    seen.add(key);
    const pkg = JSON.parse(fs.readFileSync(path.join(left, 'package.json'), 'utf8'));
    for (const name of new Set(DEPENDENCIES.flatMap(field => Object.keys(pkg[field] ?? {})))) {
      if (!equivalent(resolvePackage(root, left, name), resolvePackage(root, right, name), seen)) return false;
    }
    return true;
  };
  for (const { directory, pkg } of packages(root).reverse()) {
    if (!fs.existsSync(directory) || typeof pkg.name !== 'string') continue;
    const modules = pkg.name.startsWith('@') ? path.dirname(path.dirname(directory)) : path.dirname(directory);
    const ancestor = resolvePackage(root, path.dirname(path.dirname(modules)), pkg.name);
    if (ancestor && ancestor !== directory && equivalent(directory, ancestor)) remove(directory, 'identical-dependency');
  }
  return { platform, savedBytes, removed };
}
