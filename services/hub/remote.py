"""LAN remote control relay. Hub stores snapshots and commands, never executes agents.

The Runtime on each computer remains the only executor and history authority.
This module deliberately has no inference loop and no arbitrary process API.
"""
from __future__ import annotations
import http.client
import json
import re
import time
import uuid
from urllib.parse import urlsplit

ID = re.compile(r'^[A-Za-z0-9_.:-]{1,160}$')
COMMANDS = {'prompt', 'stop', 'model.set', 'compact', 'question.reply', 'question.reject',
            'permission.reply', 'session.create', 'settings.update', 'queue.pause', 'queue.resume',
            'providers.refresh'}
ASR_URL = 'http://192.168.31.59:8080/api/asr/v1/audio/transcriptions'
MAX_ASR = 25 * 1024 * 1024


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


class Remote:
    def __init__(self, connection, lock, fault):
        self.connection, self.lock, self.Fault = connection, lock, fault
        with connection() as c:
            c.executescript('''
                CREATE TABLE IF NOT EXISTS remote_state(
                    device TEXT PRIMARY KEY, payload TEXT NOT NULL, updated INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS remote_detail(
                    device TEXT NOT NULL, session TEXT NOT NULL, payload TEXT NOT NULL,
                    updated INTEGER NOT NULL, PRIMARY KEY(device,session));
                CREATE TABLE IF NOT EXISTS remote_watch(
                    device TEXT PRIMARY KEY, session TEXT NOT NULL, updated INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS remote_commands(
                    id TEXT PRIMARY KEY, device TEXT NOT NULL, session TEXT, kind TEXT NOT NULL,
                    payload TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created INTEGER NOT NULL,
                    updated INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS remote_queue ON remote_commands(device,state,created);
            ''')

    def identity(self, value, field='id'):
        if not isinstance(value, str) or not ID.fullmatch(value):
            raise self.Fault(400, f'Некорректный идентификатор {field}.')
        return value

    def bounded(self, value, limit=2 * 1024 * 1024):
        try:
            raw = encode(value).encode()
        except (TypeError, ValueError):
            raise self.Fault(400, 'Некорректные данные.')
        if len(raw) > limit:
            raise self.Fault(413, 'Снимок или команда слишком велики.')
        return value

    def sync(self, actor, data):
        """Runtime heartbeat: publish a fresh snapshot and take a bounded command page."""
        if not isinstance(data, dict) or not isinstance(data.get('overview'), dict):
            raise self.Fault(400, 'Нужен снимок устройства.')
        overview = self.bounded(data['overview'])
        detail = data.get('detail')
        now = int(time.time() * 1000)
        with self.lock, self.connection() as c:
            c.execute('INSERT INTO remote_state VALUES(?,?,?) ON CONFLICT(device) DO UPDATE SET payload=excluded.payload,updated=excluded.updated',
                      (actor['id'], encode(overview), now))
            c.execute('UPDATE devices SET seen=?,app_version=? WHERE id=?',
                      (now, str(overview.get('version', ''))[:40], actor['id']))
            if isinstance(detail, dict) and ID.fullmatch(str(detail.get('session', ''))):
                c.execute('INSERT INTO remote_detail VALUES(?,?,?,?) ON CONFLICT(device,session) DO UPDATE SET payload=excluded.payload,updated=excluded.updated',
                          (actor['id'], detail['session'], encode(self.bounded(detail, 4 * 1024 * 1024)), now))
            watch = c.execute('SELECT session FROM remote_watch WHERE device=?', (actor['id'],)).fetchone()
            rows = c.execute("SELECT * FROM remote_commands WHERE device=? AND state IN ('queued','delivered') ORDER BY created LIMIT 20",
                             (actor['id'],)).fetchall()
            for row in rows:
                c.execute("UPDATE remote_commands SET state='delivered',updated=? WHERE id=? AND state='queued'", (now, row['id']))
        return {'commands': [{'id': r['id'], 'session': r['session'], 'kind': r['kind'],
                              'payload': json.loads(r['payload'])} for r in rows],
                'watch': watch['session'] if watch else None, 'serverTime': now}

    def complete(self, actor, data):
        if not isinstance(data, dict) or type(data.get('ok')) is not bool:
            raise self.Fault(400, 'Нужен результат команды.')
        id_ = self.identity(data.get('id'))
        result = self.bounded(data.get('result'), 256 * 1024)
        now = int(time.time() * 1000)
        with self.lock, self.connection() as c:
            row = c.execute('SELECT state FROM remote_commands WHERE id=? AND device=?', (id_, actor['id'])).fetchone()
            if not row:
                raise self.Fault(404, 'Команда не найдена.')
            if row['state'] in ('done', 'error'):
                return {'id': id_, 'state': row['state'], 'duplicate': True}
            state = 'done' if data['ok'] else 'error'
            c.execute('UPDATE remote_commands SET state=?,result=?,updated=? WHERE id=?',
                      (state, encode(result), now, id_))
        return {'id': id_, 'state': state}

    def overview(self):
        devices = []
        with self.connection() as c:
            rows = c.execute('''SELECT d.id,d.name,d.platform,d.app_version,d.seen,r.payload,r.updated
                FROM devices d LEFT JOIN remote_state r ON r.device=d.id
                WHERE d.revoked=0 AND (r.payload IS NOT NULL OR d.platform IN ('macos','windows','linux')) ORDER BY d.seen DESC''').fetchall()
        now = int(time.time() * 1000)
        for row in rows:
            item = {'id': row['id'], 'name': row['name'], 'platform': row['platform'],
                    'appVersion': row['app_version'], 'seen': row['seen'],
                    'online': bool(row['payload'] and now-row['updated'] < 15_000)}
            if row['payload']:
                item['overview'] = json.loads(row['payload'])
                item['updated'] = row['updated']
            devices.append(item)
        return {'devices': devices, 'serverTime': now, 'authorization': 'lan-only'}

    def session(self, query):
        device = self.identity(query.get('device', [''])[0], 'device')
        session = self.identity(query.get('session', [''])[0], 'session')
        with self.connection() as c:
            row = c.execute('SELECT payload,updated FROM remote_detail WHERE device=? AND session=?',
                            (device, session)).fetchone()
            commands = c.execute('SELECT id,kind,state,result,created,updated FROM remote_commands WHERE device=? AND session=? ORDER BY created DESC LIMIT 30',
                                 (device, session)).fetchall()
        result = []
        for command in commands:
            item = dict(command)
            item['result'] = json.loads(item['result']) if item['result'] else None
            result.append(item)
        return {'detail': json.loads(row['payload']) if row else None,
                'updated': row['updated'] if row else None, 'commands': result}

    def watch(self, data):
        device = self.identity(data.get('device'), 'device')
        session = self.identity(data.get('session'), 'session')
        with self.lock, self.connection() as c:
            c.execute('INSERT INTO remote_watch VALUES(?,?,?) ON CONFLICT(device) DO UPDATE SET session=excluded.session,updated=excluded.updated',
                      (device, session, int(time.time() * 1000)))
        return {'watching': session}

    def command(self, data):
        if not isinstance(data, dict):
            raise self.Fault(400, 'Нужна команда.')
        device = self.identity(data.get('device'), 'device')
        kind = data.get('kind')
        if kind not in COMMANDS:
            raise self.Fault(400, 'Неподдерживаемая операция.')
        session = data.get('session')
        if session is not None:
            session = self.identity(session, 'session')
        elif kind not in ('session.create', 'settings.update', 'providers.refresh'):
            raise self.Fault(400, 'Нужна сессия.')
        id_ = data.get('id') or str(uuid.uuid4())
        self.identity(id_, 'command')
        payload = self.bounded(data.get('payload') or {}, 512 * 1024)
        now = int(time.time() * 1000)
        with self.lock, self.connection() as c:
            if not c.execute('SELECT 1 FROM devices WHERE id=? AND revoked=0', (device,)).fetchone():
                raise self.Fault(404, 'Устройство не подключено.')
            old = c.execute('SELECT * FROM remote_commands WHERE id=?', (id_,)).fetchone()
            if old:
                if old['device'] != device or old['kind'] != kind or old['payload'] != encode(payload):
                    raise self.Fault(409, 'ID команды уже использован для другой операции.')
                return self.command_card(old)
            c.execute('INSERT INTO remote_commands VALUES(?,?,?,?,?,?,?,?,?)',
                      (id_, device, session, kind, encode(payload), 'queued', None, now, now))
            row = c.execute('SELECT * FROM remote_commands WHERE id=?', (id_,)).fetchone()
        return self.command_card(row)

    def command_card(self, row):
        return {'id': row['id'], 'device': row['device'], 'session': row['session'],
                'kind': row['kind'], 'state': row['state'],
                'result': json.loads(row['result']) if row['result'] else None,
                'created': row['created'], 'updated': row['updated']}

    def api(self, method, route, query, actor, data):
        # Device Runtime transport still comes through the ordinary LAN identity;
        # browser pages use the same unauthenticated, LAN-gated Hub listener.
        if method == 'POST' and route == 'sync':
            return self.sync(actor, data)
        if method == 'POST' and route == 'complete':
            return self.complete(actor, data)
        if method == 'GET' and route == 'overview':
            return self.overview()
        if method == 'GET' and route == 'session':
            return self.session(query)
        if method == 'GET' and route == 'command':
            id_ = self.identity(query.get('id', [''])[0], 'command')
            with self.connection() as c:
                row = c.execute('SELECT * FROM remote_commands WHERE id=?', (id_,)).fetchone()
            if not row:
                raise self.Fault(404, 'Команда не найдена.')
            return self.command_card(row)
        if method == 'POST' and route == 'watch':
            return self.watch(data)
        if method == 'POST' and route == 'command':
            return self.command(data)
        raise self.Fault(404, 'Неизвестная операция удалённого управления.')

    def asr(self, handler):
        """Forward one owner-initiated recording to the existing GigaAM service."""
        type_ = handler.headers.get('Content-Type', '')
        if not type_.startswith('multipart/form-data; boundary='):
            raise self.Fault(415, 'Нужна multipart-запись.')
        try:
            size = int(handler.headers.get('Content-Length', '0'))
        except ValueError:
            raise self.Fault(400, 'Некорректный размер записи.')
        if not 0 < size <= MAX_ASR or handler.headers.get('Transfer-Encoding'):
            raise self.Fault(413, 'Запись пуста или превышает 25 МиБ.')
        body = handler.rfile.read(size)
        target = urlsplit(ASR_URL)
        connection = http.client.HTTPConnection(target.hostname, target.port, timeout=120)
        try:
            connection.request('POST', target.path, body=body, headers={'Content-Type': type_, 'Content-Length': str(size)})
            response = connection.getresponse()
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise self.Fault(502, 'ASR вернул слишком большой ответ.')
            try:
                value = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                raise self.Fault(502, 'ASR вернул некорректный JSON.')
            if not 200 <= response.status < 300:
                raise self.Fault(502, f'ASR HTTP {response.status}.')
            if not isinstance(value, dict) or not isinstance(value.get('text'), str):
                raise self.Fault(502, 'ASR не вернул текст.')
            handler.respond(200, {'text': value['text'][:200_000]})
        except (OSError, http.client.HTTPException):
            raise self.Fault(503, 'Сервис диктовки недоступен.')
        finally:
            connection.close()
