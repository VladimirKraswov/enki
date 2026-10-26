// Validate maintained Markdown without traversing generated or private data.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\0');
const files = [...new Set(names)].filter(name => name.endsWith('.md') &&
  !name.startsWith('test/fixtures/') && !name.includes('/test/legacy-qualified/fixtures/') &&
  fs.existsSync(path.join(root, name)));
const errors = [];
let links = 0;

function prose(text) {
  let fence;
  return text.split('\n').map(line => {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined;
      return '';
    }
    return fence ? '' : line;
  }).join('\n');
}

function anchors(file) {
  const text = prose(fs.readFileSync(file, 'utf8'));
  const found = new Set();
  for (const match of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1].toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
    let id = base, suffix = 1;
    while (found.has(id)) id = `${base}-${suffix++}`;
    found.add(id);
  }
  for (const match of text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) found.add(match[1]);
  return found;
}

for (const name of files) {
  const file = path.join(root, name);
  const text = prose(fs.readFileSync(file, 'utf8'));
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g)) {
    const target = match[1] ?? match[2];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
    const line = text.slice(0, match.index).split('\n').length;
    let local, fragment;
    try { [local, fragment] = target.split('#').map(decodeURIComponent); }
    catch { errors.push(`${name}:${line}: invalid URL encoding: ${target}`); continue; }
    // Absolute machine paths are not portable repository links.
    if (path.isAbsolute(local)) { errors.push(`${name}:${line}: absolute local link: ${target}`); continue; }
    const resolved = local ? path.resolve(path.dirname(file), local) : file;
    links++;
    if (!resolved.startsWith(root + path.sep) || !fs.existsSync(resolved)) {
      errors.push(`${name}:${line}: missing repository target: ${target}`);
    } else if (fragment && resolved.endsWith('.md') && !anchors(resolved).has(fragment)) {
      errors.push(`${name}:${line}: missing heading: ${target}`);
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log(`Documentation: ${files.length} Markdown files, ${links} local links verified.`);
