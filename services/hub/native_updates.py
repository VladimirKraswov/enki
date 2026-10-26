"""Qualify GitHub packages for an already published source release.

No network under the Hub catalog lock. One bounded probe per head/minute; the
isolated signer verifies the source signature before signing package metadata.
"""
import base64
import hashlib
import json
import re
import threading
import time
import urllib.error
import urllib.request

REPO = 'VladimirKraswov/enki'
API = 'https://api.github.com/repos/' + REPO
DOWNLOAD = 'https://github.com/' + REPO + '/releases/download/'
PLATFORMS = {'macos-arm64': '.dmg', 'windows-x64': '-setup.exe', 'linux-x64': '.deb'}
MAX_PACKAGE = 512 * 1024 * 1024

def validate_manifest(m, version, fingerprint, commit=None):
    if (not isinstance(m, dict) or set(m) != {'schemaVersion','kind','version','nativeFingerprint','commit','runId','packages'}
            or m['schemaVersion'] != 1 or m['kind'] != 'native' or m['version'] != version
            or m['nativeFingerprint'] != fingerprint or not re.fullmatch(r'[0-9a-f]{64}', fingerprint)
            or not re.fullmatch(r'[0-9a-f]{40}', m['commit']) or (commit and m['commit'] != commit)
            or type(m['runId']) is not int or m['runId'] <= 0 or set(m['packages']) != set(PLATFORMS)):
        raise ValueError('Native package identity mismatch')
    for platform, p in m['packages'].items():
        if (not isinstance(p, dict) or set(p) != {'name','sha256','bytes','url'}
                or not re.fullmatch(r'Enki_[A-Za-z0-9_.+-]+', p['name']) or not p['name'].endswith(PLATFORMS[platform])
                or not p['name'].lower().startswith(('Enki_' + version + '_').lower())
                or type(p['bytes']) is not int or not 1024 <= p['bytes'] <= MAX_PACKAGE
                or not re.fullmatch(r'[0-9a-f]{64}', p['sha256'])
                or p['url'] != DOWNLOAD + 'v' + version + '/' + p['name']):
            raise ValueError('Invalid native package')
    return m

def get_json(url):
    req = urllib.request.Request(url, headers={'User-Agent':'Enki-Hub-updater','Accept':'application/json'})
    with urllib.request.urlopen(req, timeout=12) as r:
        data = r.read(256 * 1024 + 1)
    if len(data) > 256 * 1024: raise ValueError('Oversized GitHub response')
    return json.loads(data)

def qualify(head, get=get_json):
    version, fp = head['version'], head['nativeFingerprint']
    commit = head.get('publication', {}).get('commit')
    if not isinstance(commit, str) or not re.fullmatch(r'[0-9a-f]{40}', commit):
        return None
    release = get(API + '/releases/tags/v' + version)
    if release.get('draft') or release.get('tag_name') != 'v' + version:
        raise ValueError('Release is not published')
    assets = {a['name']:a for a in release['assets']}
    manifest_asset = assets.get('enki-native.json')
    if not manifest_asset or manifest_asset['size'] > 32768: raise ValueError('Missing package manifest')
    m = validate_manifest(get(DOWNLOAD + 'v' + version + '/enki-native.json'), version, fp, commit)
    run = get(API + '/actions/runs/' + str(m['runId']))
    if (run.get('head_sha') != commit or run.get('head_branch') != 'main'
            or run.get('event') != 'workflow_dispatch' or run.get('path') != '.github/workflows/desktop.yml'
            or run.get('status') != 'completed' or run.get('conclusion') != 'success'):
        raise ValueError('Package workflow is not qualified')
    for p in m['packages'].values():
        a = assets.get(p['name'], {})
        if (a.get('state') != 'uploaded' or a.get('size') != p['bytes'] or a.get('digest') != 'sha256:' + p['sha256']
                or a.get('browser_download_url') != p['url']):
            raise ValueError('GitHub package digest mismatch')
    return m

class NativeUpdates:
    def __init__(self, releases, sign, get=get_json):
        self.releases, self.sign, self.get = releases, sign, get
        self.lock = threading.Lock()
        self.cache = {}

    def status(self, channel):
        with self.releases.lock:
            head = self.releases.head(channel)
        if not head.get('available'): return {'state':'unavailable','message':'Обновление ещё не опубликовано.'}
        key = head['revision']
        # No accumulating worker threads on repeated client checks.
        if not self.lock.acquire(blocking=False):
            return {'state':'pending','message':'Проверяем готовность пакетов GitHub.'}
        try:
            cached = self.cache.get(key)
            if cached and (cached[1]['state']=='ready' or time.monotonic() < cached[0]): return cached[1]
            attempts = cached[2]+1 if cached else 1
            try:
                manifest = qualify(head, self.get)
                if manifest is None:
                    result = {'state':'pending','message':'Для этого выпуска пока нет готового пакета GitHub.'}
                else:
                    with self.releases.lock:
                        if self.releases.head(channel)['revision'] != key:
                            return {'state':'pending','message':'Выпуск изменился. Повторяем проверку.'}
                        source = self.releases.read(self.releases.root / (head['artifacts']['source']['digest'] + '.json'))
                    payload = base64.b64encode(json.dumps(manifest, separators=(',',':')).encode()).decode()
                    envelope = self.sign({'type':'native','source':source,'payload':payload}, self.releases.fault, expected={'native'})['native']
                    if envelope.get('payload') != payload: raise ValueError('Signer returned another manifest')
                    result = {'state':'ready','envelope':envelope,'digest':hashlib.sha256(base64.b64decode(payload)).hexdigest()}
            except urllib.error.HTTPError as e:
                result = {'state':'pending' if e.code == 404 else 'unavailable','message':
                          'Пакет ещё собирается или не опубликован.' if e.code == 404 else 'GitHub временно не отвечает. Проверим снова.'}
            except (OSError, ValueError, KeyError, TypeError):
                result = {'state':'unavailable','message':'Не удалось подтвердить готовый пакет. Исходники доступны; проверим пакет снова.'}
            with self.releases.lock:
                if self.releases.head(channel)['revision'] != key:
                    return {'state':'pending','message':'Выпуск изменился. Повторяем проверку.'}
            self.cache[key] = (time.monotonic()+min(300,60*2**min(attempts-1,3)), result,attempts)
            # Stable and preview clients must not evict each other's backoff.
            while len(self.cache)>4: self.cache.pop(next(iter(self.cache)))
            return result
        finally: self.lock.release()
