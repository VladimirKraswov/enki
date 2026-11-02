"""Owner-device exchange. Uploaded source and messages are data, never jobs.

Sender identity is authenticated; reported Git commits are provenance claims,
not server-verified Git objects. Stable request IDs make lost ACKs recoverable.
"""
import base64
import hashlib
import json
import re
import time
from pathlib import PurePosixPath


class Workshop:
    def __init__(self, connection, lock, scrub, fault):
        self.connection, self.lock, self.scrub, self.Fault = connection, lock, scrub, fault
        with connection() as c:
            c.executescript('''
                CREATE TABLE IF NOT EXISTS workshop_exchange(
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE,
                    device TEXT NOT NULL REFERENCES devices(id), kind TEXT NOT NULL,
                    request_id TEXT NOT NULL, digest TEXT NOT NULL, created INTEGER NOT NULL,
                    agent TEXT NOT NULL, session TEXT NOT NULL, recipient TEXT,
                    recipient_agent TEXT, recipient_session TEXT, payload TEXT NOT NULL,
                    acknowledged INTEGER, UNIQUE(device,kind,request_id));
                CREATE INDEX IF NOT EXISTS workshop_inbox
                    ON workshop_exchange(recipient,recipient_agent,acknowledged,seq);
                CREATE INDEX IF NOT EXISTS workshop_session
                    ON workshop_exchange(device,session,seq);
                CREATE TABLE IF NOT EXISTS workshop_agents(
                    device TEXT REFERENCES devices(id), agent TEXT, session TEXT,
                    seen INTEGER NOT NULL, PRIMARY KEY(device,agent,session));
            ''')

    def text(self, value, limit, required=False):
        if not isinstance(value, str) or len(value) > limit or required and not value.strip():
            raise self.Fault(400, 'Некорректное поле обмена Мастерской.')
        return self.scrub(value, limit)

    def identity(self, value, limit=160):
        if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,'+str(limit)+'}', value):
            raise self.Fault(400, 'Некорректный идентификатор обмена.')
        return value

    def normalize(self, kind, data):
        common = {'requestId', 'agent', 'session'}
        allowed = {
            'changes': common | {'baseCommit', 'commit', 'files', 'summary'},
            'messages': common | {'recipient', 'recipientAgent', 'recipientSession', 'text', 'change'},
            'logs': common | {'level', 'code', 'operation', 'detail', 'observed'},
        }[kind]
        if not isinstance(data, dict) or set(data) - allowed:
            raise self.Fault(400, 'Неизвестные поля обмена.')
        result = {k: self.identity(data.get(k, '')) for k in common}
        if kind == 'changes':
            for key in ('baseCommit', 'commit'):
                if not isinstance(data.get(key), str) or not re.fullmatch(r'[0-9a-f]{40}', data[key]):
                    raise self.Fault(400, 'Нужен полный Git commit.')
                result[key] = data[key]
            files = data.get('files')
            if not isinstance(files, dict) or not 1 <= len(files) <= 200:
                raise self.Fault(400, 'Нужно от 1 до 200 изменённых файлов.')
            total, seen, result['files'] = 0, set(), {}
            for name, content in sorted(files.items()):
                parts = PurePosixPath(name).parts if isinstance(name, str) else ()
                if (not isinstance(name, str) or len(name) > 240 or not re.fullmatch(r'[\x21-\x7e]+', name)
                    or not parts or name.startswith('/') or '\\' in name or ':' in name
                    or any(p in ('', '.', '..', '.git', '.local', '.pi', 'node_modules', 'target')
                           or p.startswith('.env') or p.endswith(('.', ' '))
                           or re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', p) for p in name.split('/'))
                    or name.lower() in seen):
                    raise self.Fault(400, 'Небезопасный путь исходников.')
                seen.add(name.lower())
                if content is not None:
                    try:
                        if not isinstance(content, str): raise ValueError()
                        raw = base64.b64decode(content, validate=True)
                        total += len(raw)
                        if len(raw) > 512*1024 or total > 1024*1024: raise ValueError()
                        # Source exchange deliberately accepts UTF-8 text only.
                        text = raw.decode('utf8')
                        if '\x00' in text or re.search(r'-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-|gh[pousr]_|github_pat_|hf_|xox[baprs]-)[A-Za-z0-9_-]{16,}', text):
                            raise ValueError()
                    except (ValueError, UnicodeError):
                        raise self.Fault(400, 'Исходник повреждён, слишком велик или содержит ключ.')
                result['files'][name] = content
            result['summary'] = self.text(data.get('summary', ''), 1000)
        elif kind == 'messages':
            result.update({k: self.identity(data.get(k, '')) for k in ('recipient', 'recipientAgent', 'recipientSession')})
            result['text'] = self.text(data.get('text'), 8000, True)
            result['change'] = self.identity(data['change'], 64) if data.get('change') else None
        else:
            if data.get('level') not in ('warning', 'error', 'critical'):
                raise self.Fault(400, 'Нужен уровень warning/error/critical.')
            result.update(level=data['level'], code=self.identity(data.get('code', ''), 80),
                          operation=self.identity(data.get('operation', '')),
                          detail=self.text(data.get('detail', ''), 2000))
            if 'observed' in data:
                if type(data['observed']) is not int or not 0 < data['observed'] < 9*10**15:
                    raise self.Fault(400, 'Некорректное время наблюдения.')
                result['observed'] = data['observed']
        return result

    def post(self, actor, kind, data):
        payload = self.normalize(kind, data)
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        digest = hashlib.sha256(encoded.encode()).hexdigest()
        id_ = hashlib.sha256((actor['id']+':'+kind+':'+payload['requestId']).encode()).hexdigest()
        now = int(time.time()*1000)
        with self.lock, self.connection() as c:
            self.active(c, actor['id'])
            old = c.execute('SELECT id,digest,seq FROM workshop_exchange WHERE id=?', (id_,)).fetchone()
            if old:
                if old['digest'] != digest: raise self.Fault(409, 'Идентификатор уже использован с другим содержимым.')
                return {'id': id_, 'digest': digest, 'seq': old['seq'], 'accepted': True}
            if kind == 'messages':
                self.active(c, payload['recipient'])
                if payload['change'] and not c.execute("SELECT id FROM workshop_exchange WHERE id=? AND kind='changes'", (payload['change'],)).fetchone():
                    raise self.Fault(404, 'Изменение не найдено.')
            count, size = c.execute('SELECT COUNT(*),COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM workshop_exchange WHERE device=?', (actor['id'],)).fetchone()
            if count >= 10000 or size+len(encoded.encode()) > 64*1024*1024:
                raise self.Fault(429, 'Квота обмена устройства исчерпана; данные не удалены.')
            cur = c.execute('''INSERT INTO workshop_exchange
                (id,device,kind,request_id,digest,created,agent,session,recipient,recipient_agent,recipient_session,payload)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''',
                (id_, actor['id'], kind, payload['requestId'], digest, now, payload['agent'], payload['session'],
                 payload.get('recipient'), payload.get('recipientAgent'), payload.get('recipientSession'), encoded))
            return {'id': id_, 'digest': digest, 'seq': cur.lastrowid, 'accepted': True}

    def active(self, c, device):
        if not c.execute('SELECT id FROM devices WHERE id=? AND revoked=0', (device,)).fetchone():
            raise self.Fault(403, 'Устройство не подключено или отозвано.')

    def api(self, method, route, query, actor, data):
        with self.connection() as c: self.active(c, actor['id'])
        if method == 'GET' and route == 'status':
            with self.connection() as c:
                devices = [dict(r) for r in c.execute('SELECT id,name,platform,seen FROM devices WHERE revoked=0 ORDER BY name')]
                agents = [dict(r) for r in c.execute('''SELECT a.* FROM workshop_agents a JOIN devices d ON d.id=a.device
                    WHERE d.revoked=0 ORDER BY a.seen DESC LIMIT 201''')]
            return {'schema': 1, 'device': actor['id'], 'devices': devices, 'execution': False,
                    'agents': agents[:200], 'agentsTruncated': len(agents)>200,
                    'capabilities': ['changes', 'messages', 'logs', 'ack', 'presence']}
        if method == 'POST' and route == 'presence':
            if not isinstance(data, dict) or set(data) != {'agent', 'session'}:
                raise self.Fault(400, 'Некорректная регистрация агента.')
            agent, session = self.identity(data['agent']), self.identity(data['session'])
            with self.lock, self.connection() as c:
                self.active(c, actor['id'])
                c.execute('INSERT INTO workshop_agents VALUES (?,?,?,?) ON CONFLICT(device,agent,session) DO UPDATE SET seen=excluded.seen',
                          (actor['id'], agent, session, int(time.time()*1000)))
                c.execute('DELETE FROM workshop_agents WHERE rowid IN (SELECT rowid FROM workshop_agents WHERE device=? ORDER BY seen DESC LIMIT -1 OFFSET 200)', (actor['id'],))
            return {'device': actor['id'], 'agent': agent, 'session': session, 'registered': True}
        if method == 'POST' and route in ('changes', 'messages', 'logs'):
            return self.post(actor, route, data)
        if method == 'POST' and route == 'ack':
            if not isinstance(data, dict) or set(data) != {'id', 'agent', 'session'}:
                raise self.Fault(400, 'Некорректное подтверждение.')
            id_, agent, session = (self.identity(data[k]) for k in ('id', 'agent', 'session'))
            with self.lock, self.connection() as c:
                self.active(c, actor['id'])
                row = c.execute("SELECT * FROM workshop_exchange WHERE id=? AND kind='messages'", (id_,)).fetchone()
                if not row or (row['recipient'], row['recipient_agent'], row['recipient_session']) != (actor['id'], agent, session):
                    raise self.Fault(404, 'Сообщение для этого агента не найдено.')
                c.execute('UPDATE workshop_exchange SET acknowledged=COALESCE(acknowledged,?) WHERE id=?', (int(time.time()*1000), id_))
            return {'id': id_, 'acknowledged': True}
        if method == 'GET' and route.startswith('changes/'):
            id_ = self.identity(route[8:], 64)
            with self.connection() as c:
                row = c.execute("SELECT * FROM workshop_exchange WHERE id=? AND kind='changes'", (id_,)).fetchone()
            if not row: raise self.Fault(404, 'Изменение не найдено.')
            return self.card(row, True)
        if method == 'GET' and route in ('changes', 'inbox', 'messages', 'logs'):
            allowed = {'after', 'limit', 'device', 'agent', 'session', 'operation'}
            if set(query)-allowed or any(len(v) != 1 for v in query.values()):
                raise self.Fault(400, 'Некорректные фильтры обмена.')
            try:
                after, limit = int(query.get('after', ['0'])[0]), int(query.get('limit', ['50'])[0])
                if after < 0 or after > 2**63-1 or not 1 <= limit <= 100: raise ValueError()
            except (ValueError, TypeError): raise self.Fault(400, 'Некорректный курсор обмена.')
            where, args = ['seq>?', 'kind=?'], [after, 'messages' if route in ('inbox', 'messages') else route]
            if route == 'inbox':
                where += ['recipient=?', 'recipient_agent=?', 'recipient_session=?', 'acknowledged IS NULL']
                args += [actor['id'], self.identity(query.get('agent', [''])[0]), self.identity(query.get('session', [''])[0])]
            elif route == 'messages':
                where.append('device=?'); args.append(actor['id'])
            for key in ('device', 'agent', 'session'):
                if key in query and route != 'inbox':
                    where.append(key+'=?'); args.append(self.identity(query[key][0]))
            if 'operation' in query:
                where.append("json_extract(payload,'$.operation')=?"); args.append(self.identity(query['operation'][0]))
            with self.connection() as c:
                rows = c.execute('SELECT * FROM workshop_exchange WHERE '+' AND '.join(where)+' ORDER BY seq LIMIT ?', (*args, limit+1)).fetchall()
            result = {'items': [self.card(r) for r in rows[:limit]], 'next': rows[limit-1]['seq'] if len(rows)>limit else None}
            if route == 'logs':
                result.update(self.history_errors(query))
            return result
        raise self.Fault(404, 'Неизвестная операция обмена.')

    def card(self, row, include_files=False):
        payload = json.loads(row['payload'])
        if row['kind'] == 'changes' and not include_files:
            payload['files'] = list(payload['files'])
        return {k: row[k] for k in ('id', 'seq', 'device', 'kind', 'digest', 'created', 'acknowledged')} | {'payload': payload}

    def history_errors(self, query):
        """Existing durable ingest is the automatic error transport. Keep this
        diagnostic view separate from conversation messages and explicit logs."""
        if 'agent' in query:
            return {'historyErrors':[], 'historyTruncated':False, 'historyRecordsScanned':0}
        where, args = [], []
        if 'device' in query:
            where.append('device_id=?'); args.append(self.identity(query['device'][0]))
        if 'session' in query:
            raw = self.identity(query['session'][0])
            where.append('session_id IN (?,?,?)')
            args += [raw, hashlib.sha256(('pi:'+raw).encode()).hexdigest(), hashlib.sha256(('opencode:'+raw).encode()).hexdigest()]
        sql = 'SELECT id,session_id,device_id,error,tools,updated FROM records'
        if where: sql += ' WHERE '+' AND '.join(where)
        with self.connection() as c:
            rows = c.execute(sql+' ORDER BY updated DESC,id DESC LIMIT 1001', args).fetchall()
        errors = []
        for row in rows[:1000]:
            entries = [('agent', row['id'], row['error'])] if row['error'] else []
            entries += [(t['name'],t['id'],t['error']) for t in json.loads(row['tools']) if t.get('status')=='error']
            for tool, call, error in entries:
                if 'operation' in query and call != query['operation'][0]: continue
                errors.append({'source':'session-history','device':row['device_id'],'session':row['session_id'],
                               'record':row['id'],'operation':call,'tool':tool,'detail':error,'updated':row['updated']})
        return {'historyErrors':errors[:100], 'historyTruncated':len(rows)>1000 or len(errors)>100,
                'historyRecordsScanned':min(1000,len(rows))}

    def maintain(self, cutoff):
        # Dedicated exchange retention, never remove owner conversations or Git.
        with self.lock, self.connection() as c:
            c.execute('DELETE FROM workshop_exchange WHERE created<?', (cutoff,))
            c.execute('DELETE FROM workshop_agents WHERE seen<?', (cutoff,))
