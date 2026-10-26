"""Bounded compiler-object storage. No archive extraction or execution on Hub.
Each short-lived lease is restricted to one paired device and host platform.
"""
import contextlib
import hashlib
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import sqlite3
import threading
import time

MIB = 1024 * 1024
MAX_OBJECT = 64 * MIB
PLATFORMS = {'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'}
KEY = re.compile(r'(?:[0-9a-f]/){0,3}[0-9a-f]{64}\Z')


class CacheError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class BuildCache:
    def __init__(self, root, quota=8 * 1024 * MIB, device_quota=3 * 1024 * MIB,
                 reserve=2 * 1024 * MIB, ttl=30 * 86400):
        self.root = Path(root)
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.quota, self.device_quota, self.reserve, self.ttl = quota, device_quota, reserve, ttl
        self.lock = threading.RLock()
        self.slots = threading.BoundedSemaphore(2)
        self.leases = {}
        with self.connection() as db:
            db.execute('CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY, device TEXT, size INTEGER, sha TEXT, used REAL)')
        # A killed upload can leave only its private temporary file.
        for f in self.root.glob('*.partial'):
            if f.stat().st_mtime < time.time() - 86400:
                f.unlink(missing_ok=True)

    @contextlib.contextmanager
    def connection(self):
        db = sqlite3.connect(self.root / 'index.sqlite', timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    def lease(self, actor, platform):
        if platform not in PLATFORMS:
            raise CacheError(400, 'Неподдерживаемая платформа кэша.')
        token, now = secrets.token_urlsafe(32), time.time()
        with self.lock:
            self.leases = {k: v for k, v in self.leases.items() if v[2] > now}
            if len(self.leases) >= 256 or sum(v[0] == actor['id'] for v in self.leases.values()) >= 8:
                raise CacheError(429, 'Слишком много активных сборок.')
            self.leases[hashlib.sha256(token.encode()).hexdigest()] = (actor['id'], platform, now + 14400)
        return {'token': token, 'expiresAt': int(now + 14400), 'maxObjectBytes': MAX_OBJECT}

    def release(self, token):
        with self.lock:
            self.leases.pop(hashlib.sha256(token.encode()).hexdigest(), None)

    def authorize(self, token, platform, active):
        with self.lock:
            lease = self.leases.get(hashlib.sha256(token.encode()).hexdigest())
        if not lease or lease[1] != platform or lease[2] <= time.time() or not active(lease[0]):
            raise CacheError(401, 'Срок доступа к кэшу истёк или устройство отключено.')
        return lease[0]

    def identity(self, device, platform, key):
        if platform not in PLATFORMS or not KEY.fullmatch(key):
            raise CacheError(400, 'Некорректный ключ кэша.')
        return hashlib.sha256(f'{device}\0{platform}\0{key}'.encode()).hexdigest()

    def _prune(self, db, device, incoming):
        now = time.time()
        rows = db.execute('SELECT id,device,size,used FROM objects ORDER BY used').fetchall()
        total = sum(row[2] for row in rows)
        own = sum(row[2] for row in rows if row[1] == device)
        free = shutil.disk_usage(self.root).free
        count = len(rows)
        for ident, owner, size, used in rows:
            expired = used < now - self.ttl
            global_full = total + incoming > self.quota or free < self.reserve + incoming or count >= 50000
            own_full = owner == device and own + incoming > self.device_quota
            if not (expired or global_full or own_full):
                continue
            (self.root / ident).unlink(missing_ok=True)
            db.execute('DELETE FROM objects WHERE id=?', (ident,))
            count -= 1
            total -= size
            free += size
            if owner == device:
                own -= size
        if incoming > self.device_quota or total + incoming > self.quota or shutil.disk_usage(self.root).free < self.reserve + incoming:
            raise CacheError(507, 'Кэш заполнен; сборка продолжится без сохранения.')

    def put(self, device, platform, key, source, size):
        ident = self.identity(device, platform, key)
        if not 0 < size <= MAX_OBJECT:
            raise CacheError(413, 'Объект кэша превышает лимит.')
        if not self.slots.acquire(False):
            raise CacheError(429, 'Кэш занят.')
        partial = self.root / (secrets.token_hex(16) + '.partial')
        try:
            # A slow client must not lock out cache reads, leases or maintenance.
            # At most two bounded uploads consume temporary disk space.
            if shutil.disk_usage(self.root).free < self.reserve + size:
                raise CacheError(507, 'Недостаточно места для кэша.')
            hasher, remaining = hashlib.sha256(), size
            with partial.open('xb') as out:
                os.chmod(partial, 0o600)
                while remaining:
                    chunk = source.read(min(128 * 1024, remaining))
                    if not chunk:
                        raise CacheError(400, 'Загрузка кэша оборвалась.')
                    remaining -= len(chunk)
                    hasher.update(chunk)
                    out.write(chunk)
                out.flush()
                os.fsync(out.fileno())
            sha = hasher.hexdigest()
            # Serialize the short commit only; never hold Hub's catalog lock.
            with self.lock, self.connection() as db:
                db.execute('BEGIN IMMEDIATE')
                old = db.execute('SELECT sha FROM objects WHERE id=?', (ident,)).fetchone()
                if old and old[0] != sha:
                    raise CacheError(409, 'Ключ кэша уже содержит другой объект.')
                if old and (self.root / ident).is_file():
                    db.execute('UPDATE objects SET used=? WHERE id=?', (time.time(), ident))
                    return
                self._prune(db, device, size)
                os.replace(partial, self.root / ident)
                db.execute('INSERT OR REPLACE INTO objects VALUES(?,?,?,?,?)', (ident, device, size, sha, time.time()))
        finally:
            partial.unlink(missing_ok=True)
            self.slots.release()

    def get(self, device, platform, key):
        ident = self.identity(device, platform, key)
        with self.lock, self.connection() as db:
            row = db.execute('SELECT size,sha,used FROM objects WHERE id=?', (ident,)).fetchone()
            if not row or row[2] < time.time() - self.ttl:
                raise CacheError(404, 'Объекта нет в кэше.')
            try:
                f = (self.root / ident).open('rb')
            except FileNotFoundError:
                db.execute('DELETE FROM objects WHERE id=?', (ident,))
                raise CacheError(404, 'Объекта нет в кэше.')
            db.execute('UPDATE objects SET used=? WHERE id=?', (time.time(), ident))
            return f, row[0], row[1]

    def maintain(self):
        with self.lock, self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            self._prune(db, '', 0)
            known = {row[0] for row in db.execute('SELECT id FROM objects')}
            for f in self.root.iterdir():
                if re.fullmatch(r'[0-9a-f]{64}', f.name) and f.name not in known and f.stat().st_mtime < time.time() - 86400:
                    f.unlink(missing_ok=True)

    def handle(self, handler, path, active):
        handler.close_connection = True
        parts = path.split('/', 5)
        if len(parts) != 6 or parts[:4] != ['', 'api', 'build-cache', 'objects']:
            raise CacheError(404, 'Неизвестный маршрут кэша.')
        platform, key = parts[4:]
        auth = handler.headers.get('Authorization', '')
        device = self.authorize(auth[7:] if auth.startswith('Bearer ') else '', platform, active)
        if handler.command == 'PUT':
            values = handler.headers.get_all('Content-Length', [])
            if len(values) != 1 or not values[0].isdigit() or handler.headers.get('Transfer-Encoding'):
                raise CacheError(411, 'Требуется точный размер объекта.')
            def expire():
                try:
                    handler.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            deadline = threading.Timer(30, expire)
            deadline.daemon = True
            deadline.start()
            try:
                self.put(device, platform, key, handler.rfile, int(values[0]))
            finally:
                deadline.cancel()
            return handler.respond(201, b'', 'application/octet-stream')
        if handler.command not in ('GET', 'HEAD'):
            raise CacheError(405, 'Метод кэша не поддерживается.')
        f, size, sha = self.get(device, platform, key)
        with f:
            handler.send_response(200)
            handler.send_header('Content-Type', 'application/octet-stream')
            handler.send_header('Content-Length', str(size))
            handler.send_header('X-Content-SHA256', sha)
            handler.send_header('Cache-Control', 'no-store')
            handler.send_header('Connection', 'close')
            handler.end_headers()
            if handler.command == 'GET':
                shutil.copyfileobj(f, handler.wfile, 128 * 1024)
