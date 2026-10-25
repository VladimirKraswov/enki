"""Immutable release storage. Admin publishing only; uploaded code is never executed.

The native client, not this untrusted transport, verifies the pinned minisign key.
Both complete UI and source snapshots are required so every OS can update.
"""
import base64
import hashlib
import importlib.util
import io
import json
import re
import shutil
import zipfile
from pathlib import Path

# Loaded by file location like every Hub module (server.py, release_signer.py, tests).
_durable_spec = importlib.util.spec_from_file_location('enki_hub_durable', Path(__file__).with_name('durable.py'))
durable = importlib.util.module_from_spec(_durable_spec)
_durable_spec.loader.exec_module(durable)

MAX_UPLOAD = 64 * 1024 * 1024
MAX_PAYLOAD = 24 * 1024 * 1024
VERSION = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$')
HASH = re.compile(r'^[0-9a-f]{64}$')
RESERVED = re.compile(r'^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', re.I)


def version_key(version):
    match = VERSION.fullmatch(version) if isinstance(version, str) else None
    if not match or len(version) > 80:
        raise ValueError('Invalid release version')
    major, minor, patch, preview = match.groups()
    suffix = [(0, int(p)) if p.isdigit() else (1, p) for p in preview.split('.')] if preview else []
    return (int(major), int(minor), int(patch), 0 if preview else 1, suffix)


def safe_path(name):
    return (isinstance(name, str) and 0 < len(name) <= 240
            and all(32 < ord(c) < 127 for c in name) and '\\' not in name and ':' not in name
            and all(p not in ('', '.', '..') and not p.endswith(('.', ' ')) and not RESERVED.match(p)
                    for p in name.split('/')))


class Releases:
    def __init__(self, root, lock, fault):
        self.root, self.lock, self.fault = root / 'releases', lock, fault
        if self.root.is_symlink():
            raise fault(500, 'Release directory cannot be a symbolic link')
        self.root.mkdir(mode=0o700, exist_ok=True)

    def error(self, message, status=400):
        raise self.fault(status, message)

    def read(self, path):
        if path.is_symlink():
            self.error('Небезопасный путь обновления.', 500)
        if not path.exists():
            return None
        if path.stat().st_size > MAX_UPLOAD:
            self.error('Пакет слишком велик.', 413)
        return json.loads(path.read_bytes())

    def atomic(self, path, value):
        durable.publish(path, json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode())

    def validate_unsigned(self, payload, kind):
        try:
            if not isinstance(payload, str) or len(payload) > MAX_PAYLOAD * 4 // 3 + 4:
                self.error('Пакет слишком велик.', 413)
            raw = base64.b64decode(payload, validate=True)
            if len(raw) > MAX_PAYLOAD:
                self.error('Пакет слишком велик.', 413)
            packet = json.loads(raw)
            if (not isinstance(packet, dict) or packet.get('schemaVersion') != 1
                    or packet.get('kind') != kind or not HASH.fullmatch(packet.get('nativeFingerprint', ''))):
                raise ValueError()
            version_key(packet['version'])
            files = packet['files']
            if not isinstance(files, dict) or not 1 <= len(files) <= 4000 or len({p.lower() for p in files}) != len(files):
                raise ValueError()
            total = 0
            for name, value in files.items():
                if not safe_path(name) or not isinstance(value, str):
                    raise ValueError()
                parts = name.lower().split('/')
                if any(p in ('.git', '.local', '.pi', 'node_modules', 'target') or p == '.env' or p.startswith('.env.') for p in parts):
                    raise ValueError()
                data = base64.b64decode(value, validate=True)
                total += len(data)
                if len(data) > 12 * 1024 * 1024 or total > MAX_PAYLOAD:
                    self.error('Пакет слишком велик.', 413)
            if kind == 'hot' and 'index.html' not in files:
                raise ValueError()
            if kind == 'source' and not {'package.json', 'package-lock.json', 'src-tauri/Cargo.toml',
                                         'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json'} <= files.keys():
                raise ValueError()
            return raw, packet
        except (ValueError, TypeError, KeyError, UnicodeError):
            self.error('Некорректный пакет обновления.')

    def validate(self, envelope, kind):
        if not isinstance(envelope, dict) or set(envelope) != {'payload', 'signature'}:
            self.error('Нужен подписанный пакет обновления.')
        raw, packet = self.validate_unsigned(envelope.get('payload'), kind)
        try:
            if not isinstance(envelope['signature'], str) or len(envelope['signature']) > 8192:
                raise ValueError()
            signature = base64.b64decode(envelope['signature'], validate=True).decode()
            if not any(line.startswith('trusted comment: ') and 'version:' + packet['version'] in line.split('\t')
                       for line in signature.splitlines()):
                raise ValueError()
        except (ValueError, TypeError, KeyError, UnicodeError):
            self.error('Некорректная подпись обновления.')
        return raw, packet

    def head(self, channel):
        if channel not in ('stable', 'preview'):
            self.error('Неизвестный канал обновлений.')
        return self.read(self.root / (channel + '.json')) or {'available': False, 'revision': None}

    def collect(self):
        # Retain the latest 40 immutable artifacts plus both channel heads.
        # Installed clients keep their own verified current/previous copies.
        keep=set()
        for channel in ('stable','preview'):
            head=self.head(channel)
            keep.update(a['digest'] for a in head.get('artifacts',{}).values())
        for channel in ('stable','preview'):
            bridge=self.read(self.root / ('legacy-' + channel + '.json')) or {}
            keep.update(a['digest'] for a in bridge.get('artifacts',{}).values())
        items=[p for p in self.root.glob('*.json') if HASH.fullmatch(p.stem) and not p.is_symlink()]
        items.sort(key=lambda p:p.stat().st_mtime_ns,reverse=True)
        keep.update(p.stem for p in items[:40])
        for p in items:
            if p.stem not in keep:p.unlink()

    def download(self, path):
        """Public source-only bootstrap; never expose catalog/history/device data.

        Take a consistent head/envelope snapshot before releasing the publication
        lock. Immutable URLs let a client pin the manifest across a new release.
        The signed envelope remains available for native signature verification.
        """
        latest = path in ('/downloads/latest', '/downloads/latest/source.zip')
        match = re.fullmatch(r'/downloads/source/([0-9a-f]{64})\.(zip|json)', path)
        if not latest and not match:
            self.error('Файл релиза не найден.', 404)
        with self.lock:
            head = self.head('stable') if latest else None
            if latest and not head['available']:
                self.error('Стабильный релиз ещё не опубликован.', 404)
            key = head['artifacts']['source']['digest'] if latest else match[1]
            if not isinstance(key, str) or not HASH.fullmatch(key):
                self.error('Повреждён указатель релиза.', 500)
            envelope = self.read(self.root / (key + '.json'))
        if envelope is None:
            self.error('Исходники релиза не найдены.', 404)
        raw, packet = self.validate(envelope, 'source')
        if hashlib.sha256(raw).hexdigest() != key:
            self.error('Контрольная сумма исходников не совпала.', 500)
        if head and (packet['version'] != head['version']
                     or packet['nativeFingerprint'] != head['nativeFingerprint']
                     or len(raw) != head['artifacts']['source']['bytes']):
            self.error('Исходники не соответствуют стабильному релизу.', 500)
        if match and match[2] == 'json':
            return envelope, 'application/json; charset=utf-8', None
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for name, value in sorted(packet['files'].items()):
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, base64.b64decode(value, validate=True))
        data = output.getvalue()
        if path == '/downloads/latest':
            return {'version': packet['version'], 'channel': 'stable',
                    'source': {'url': '/downloads/source/' + key + '.zip',
                               'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)},
                    'signedSource': {'url': '/downloads/source/' + key + '.json',
                                     'payloadSha256': key}}, 'application/json; charset=utf-8', None
        return data, 'application/zip', 'Enki-' + packet['version'] + '-source.zip'

    def api(self, method, path, actor, data):
        suffix = path.removeprefix('/api/updates')
        with self.lock:
            if method == 'GET' and suffix == '':
                return {channel: self.head(channel) for channel in ('stable', 'preview')}
            if method == 'GET' and suffix.startswith('/artifacts/'):
                key = suffix.removeprefix('/artifacts/')
                if not HASH.fullmatch(key):
                    self.error('Некорректный идентификатор пакета.')
                result = self.read(self.root / (key + '.json'))
                if result is None:
                    self.error('Пакет не найден.', 404)
                return result
            if method == 'GET' and suffix in ('/enki/stable', '/enki/preview'):
                return self.head(suffix.rsplit('/',1)[1])
            if method == 'GET' and suffix in ('/stable', '/preview'):
                # Pre-Enki natives reject renamed source manifests. Keep the
                # last compatible signed bridge; its native updater opts into
                # /enki/<channel> after installation. No code/signature rewrite.
                return self.read(self.root / ('legacy-' + suffix[1:] + '.json')) or self.head(suffix[1:])
            if method == 'POST' and suffix == '':
                if not actor['admin']:
                    self.error('Публикация доступна только администратору.', 403)
                channel = data.get('channel')
                current = self.head(channel)
                if 'expectedRevision' not in data or data['expectedRevision'] != current['revision']:
                    self.error('Канал обновлений изменился. Проверьте текущую версию.', 409)
                artifacts, packets = {}, {}
                for kind in ('hot', 'source'):
                    raw, packet = self.validate(data.get(kind), kind)
                    key = hashlib.sha256(raw).hexdigest()
                    artifacts[kind] = {'digest': key, 'bytes': len(raw)}
                    packets[kind] = packet
                hot, source = packets['hot'], packets['source']
                if hot['version'] != source['version'] or hot['nativeFingerprint'] != source['nativeFingerprint']:
                    self.error('Исходники и интерфейс относятся к разным сборкам.')
                if channel == 'stable' and '-' in hot['version']:
                    self.error('Предварительная версия не может попасть в стабильный канал.')
                if current['available'] and version_key(hot['version']) <= version_key(current['version']):
                    self.error('Версия должна быть новее опубликованной.', 409)
                head = {'available': True, 'version': hot['version'], 'nativeFingerprint': hot['nativeFingerprint'],
                        'notes': str(hot.get('notes', ''))[:4000], 'artifacts': artifacts}
                if data.get('_devicePublication'):head['publication']=data['_devicePublication']
                head['revision'] = hashlib.sha256(json.dumps(head, sort_keys=True).encode()).hexdigest()
                if shutil.disk_usage(self.root).free < 256 * 1024 * 1024 + sum(a['bytes'] * 2 for a in artifacts.values()):
                    self.error('На сервере недостаточно места для обновления.', 507)
                # Write immutable packages before atomically exposing the head.
                # An uncertain artifact write is safe to repeat: identical
                # hash-addressed bytes are accepted again, different ones refused.
                for kind, artifact in artifacts.items():
                    file = self.root / (artifact['digest'] + '.json')
                    existing = self.read(file)
                    if existing is not None and existing != data[kind]:
                        self.error('Пакет с этим хешем уже существует.', 409)
                    if existing is None:
                        try:
                            self.atomic(file, data[kind])
                        except durable.PublicationUncertain:
                            self.error('Пакет записан, но его сохранность на диске не подтверждена. Канал не изменён; повторите ту же публикацию.', 503)
                try:
                    config=json.loads(base64.b64decode(source['files']['src-tauri/tauri.conf.json'],validate=True))
                except (ValueError,TypeError,KeyError):config={}
                try:
                    if config.get('productName') == 'Arvela':
                        self.atomic(self.root / ('legacy-' + channel + '.json'), head)
                    self.atomic(self.root / (channel + '.json'), head)
                except durable.PublicationUncertain:
                    # The new head may already be served. Never claim the old
                    # release was kept; the publisher reconciles by reading the
                    # channel head and both envelopes, not by re-POSTing blindly.
                    self.error('Новая версия канала, возможно, уже опубликована, но её сохранность на диске не подтверждена. '
                               'Проверьте канал и загрузки пакетов перед любым повтором.', 503)
                try:self.collect()
                except OSError:pass
                return head
        self.error('Маршрут обновления не найден.', 404)
