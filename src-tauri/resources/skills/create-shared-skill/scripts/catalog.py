#!/usr/bin/env python3
"""Read-only common skill inventory. No scripts or registry secrets are emitted."""
import argparse
import hashlib
import json
import os
import re
import stat
from pathlib import Path

LIMIT = 262144

def project_key(project):
    value = 0xcbf29ce484222325
    for byte in str(project.resolve()).encode():
        value = ((value ^ byte) * 0x100000001b3) & 0xffffffffffffffff
    return f"project-{value:016x}"

def registry_sources(root, project):
    sources = {}
    for key in ['global'] + ([project_key(project)] if project else []):
        file = root / (key + '.json')
        if not file.exists():
            continue
        if file.is_symlink() or file.stat().st_size > LIMIT:
            raise ValueError('Invalid registry file')
        data = json.loads(file.read_text(encoding='utf-8'))
        if data.get('version') != 1 or not isinstance(data.get('sources'), list):
            raise ValueError('Unsupported registry')
        for source in data['sources']:
            if not isinstance(source, dict) or not isinstance(source.get('id'), str):
                raise ValueError('Invalid source')
            sources[source['id']] = source
    return [Path(s['path']) for s in sources.values()
            if s.get('enabled') is True and isinstance(s.get('path'), str) and Path(s['path']).is_absolute()]

def inventory(roots):
    records, seen = [], set()
    for root in roots:
        if not root.is_dir():
            continue
        # Only direct skill packages, never a recursive walk of home/project.
        children = sorted(root.iterdir(), key=lambda p: p.name)
        if len(children) > 1000:
            raise ValueError('Too many skill packages')
        for directory in children:
            file = directory / 'SKILL.md'
            if not file.is_file() or file.is_symlink():
                continue
            resolved = file.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            if file.stat().st_size > LIMIT:
                raise ValueError('Skill too large')
            raw = file.read_bytes()
            text = raw.decode('utf-8')
            front = re.match(r'^---\r?\n(.*?)\r?\n---(?:\r?\n|$)', text, re.S)
            if not front:
                continue
            values = {}
            for line in front[1].splitlines():
                match = re.match(r'^(name|description):\s*(.+)$', line)
                if match:
                    values[match[1]] = match[2].strip().strip('\"\'')
            records.append({**values, 'path': str(resolved), 'sha256': hashlib.sha256(raw).hexdigest(),
                            'kind': 'managed-copy' if any(p in resolved.parts for p in ('builtin-skills', 'hub-cache')) else 'source',
                            'descriptionFormat': 'read-SKILL.md' if values.get('description') in ('>', '|', '>-', '|-') else 'inline'})
            if len(records) > 1000:
                raise ValueError('Too many skills')
    return records

def mark_connected(records, connected):
    """Enki Runtime loads only enabled registry sources, never ambient folders."""
    roots = {c.resolve() for c in connected}
    for record in records:
        record['enki'] = 'connected-source' if Path(record['path']).parent.parent in roots else 'not-loaded'
    return records

def profile_root(value, home):
    """Read-only mirror of native `paths::validate_profile_root`.

    Absolute, not `..`, not HOME; no existing component may be a symbolic link
    or a file (a linked profile or linked ancestor could alias another profile
    or HOME); an existing profile is compared with HOME by physical identity.
    Unlike native, nothing is created: a missing profile simply has no registry.
    Any doubt fails closed (ValueError), never falls back to the owner."""
    profile = Path(value)
    if not value or not profile.is_absolute() or profile.parent == profile or '..' in profile.parts or profile == home:
        raise ValueError('ENKI_PROFILE_DIR must be a separate absolute directory')
    prefix = Path(profile.anchor)
    for part in profile.parts[1:]:
        prefix = prefix / part
        try:
            mode = os.lstat(prefix).st_mode
        except FileNotFoundError:
            break
        except OSError:
            raise ValueError('ENKI_PROFILE_DIR cannot be inspected')
        if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
            raise ValueError('ENKI_PROFILE_DIR contains a link or a file')
    if not profile.exists():
        return profile
    try:
        physical, owner = profile.resolve(strict=True), home.resolve(strict=True)
    except OSError:
        raise ValueError('ENKI_PROFILE_DIR or HOME is unavailable')
    if physical == owner:
        raise ValueError('ENKI_PROFILE_DIR must not be the home directory')
    return physical

def locations(env, home, windows):
    """(registry root, owner-HOME skill roots) for this installation.

    Mirrors the native registry: an explicit ENKI_PROFILE_DIR owns
    `<profile>/capabilities` and nothing below the owner's HOME is inspected;
    an invalid profile fails closed instead of reading the owner's data. An
    inherited MESH_CAPABILITIES_ROOT never redirects an explicit profile (the
    native registry has no such override); a caller that really owns another
    registry passes `--registry`. The default Windows registry lives under
    `%USERPROFILE%\\.enki` (legacy `.opencode-desktop`), outside
    MSIX-virtualised AppData."""
    if 'ENKI_PROFILE_DIR' in env:
        return profile_root(env['ENKI_PROFILE_DIR'], home) / 'capabilities', []
    explicit = env.get('MESH_CAPABILITIES_ROOT')
    if explicit:
        return Path(explicit), [home / '.agents/skills']
    if windows:
        bases = [home / '.enki', home / '.opencode-desktop']
    else:
        xdg = Path(env.get('XDG_DATA_HOME') or '.')
        data = xdg if xdg.is_absolute() else home / '.local/share'  # relative XDG is ignored, as natively
        bases = [data / 'enki', data / 'opencode-desktop']
    # Read-only legacy discovery before migration.
    registry = next((b / 'capabilities' for b in bases if (b / 'capabilities').exists()), bases[0] / 'capabilities')
    return registry, [home / '.agents/skills']

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path)
    parser.add_argument('--registry', type=Path)
    parser.add_argument('--source', type=Path, action='append', default=[])
    args = parser.parse_args()
    try:
        registry, roots = locations(os.environ, Path.home(), os.name == 'nt')
        registry = args.registry or registry
        if args.project:
            if not args.project.is_absolute() or not args.project.is_dir():
                raise ValueError('Project must be an existing absolute directory')
            roots.append(args.project / '.agents/skills')
        connected = registry_sources(registry, args.project)
        roots.extend(connected)
        roots.extend(args.source)
        print(json.dumps({'skills': mark_connected(inventory(roots), connected), 'scope': 'common local sources; current engine catalogue remains authoritative'}, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, UnicodeError) as error:
        print(json.dumps({'error': type(error).__name__, 'detail': 'Catalogue unavailable; inspect the engine catalogue and connected sources'}, ensure_ascii=False))
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
