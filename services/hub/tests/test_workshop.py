import base64
import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('hub_workshop_test', Path(__file__).parents[1]/'server.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Exchange(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.h = m.Hub(Path(self.tmp.name))
        self.mac = self.h.authenticate(self.h.provision('Mac', 'macos')['token'])
        self.win = self.h.authenticate(self.h.provision('Windows', 'windows')['token'])

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, route, actor=None, data=None, query=None):
        return self.h.api('POST' if data is not None else 'GET', '/api/workshop/'+route,
                          query or {}, actor or self.mac, data or {})

    def change(self):
        return dict(requestId='push-1', agent='workshop', session='mac-session',
                    baseCommit='a'*40, commit='b'*40, summary='Reviewed timeout default',
                    files={'src/change.ts': base64.b64encode(b'export const timeout = 1800;').decode(), 'old.ts': None})

    def message(self):
        return dict(requestId='message-1', agent='workshop', session='mac-session', recipient=self.win['id'],
                    recipientAgent='workshop', recipientSession='win-session', text='Please review the timeout patch.')

    def test_changes_survive_restart_and_do_not_publish_or_execute(self):
        receipt = self.call('changes', data=self.change())
        self.h = m.Hub(Path(self.tmp.name))
        received = self.call('changes/'+receipt['id'], self.win)
        self.assertEqual(received['payload'], self.change())
        self.assertEqual(received['device'], self.mac['id'])
        self.assertEqual(self.call('changes')['items'][0]['payload']['files'], ['old.ts', 'src/change.ts'])
        self.assertFalse(self.call('status')['execution'])
        self.assertFalse(self.h.releases.head('stable')['available'])

    def test_lost_ack_is_idempotent_but_id_reuse_conflicts(self):
        first = self.call('changes', data=self.change())
        self.assertEqual(first, self.call('changes', data=self.change()))
        changed = self.change() | {'commit': 'c'*40}
        with self.assertRaises(m.Fault) as error: self.call('changes', data=changed)
        self.assertEqual(error.exception.status, 409)

    def test_mailbox_scope_receipt_and_sender_status(self):
        message = self.message()
        receipt = self.call('messages', data=message)
        query = {'agent': ['workshop'], 'session': ['win-session']}
        self.assertEqual(self.call('inbox', self.win, query=query)['items'][0]['id'], receipt['id'])
        self.assertEqual(self.call('inbox', self.mac, query=query)['items'], [])
        self.assertEqual(self.call('inbox', self.win, query=query | {'session':['other']})['items'], [])
        ack = dict(id=receipt['id'], agent='workshop', session='win-session')
        with self.assertRaises(m.Fault): self.call('ack', self.mac, ack)
        with self.assertRaises(m.Fault): self.call('ack', self.win, ack | {'session':'other'})
        self.assertEqual(self.call('ack', self.win, ack), self.call('ack', self.win, ack))
        self.assertEqual(self.call('inbox', self.win, query=query)['items'], [])
        self.assertIsNotNone(self.call('messages')['items'][0]['acknowledged'])

    def test_no_cross_device_agent_identity_or_revocation_bypass(self):
        self.call('messages', data=self.message())
        with self.h.connection() as c: c.execute('UPDATE devices SET revoked=1 WHERE id=?', (self.win['id'],))
        for route, actor, data in [('status',self.win,None), ('messages',self.mac,self.message() | {'requestId':'second'})]:
            with self.assertRaises(m.Fault): self.call(route, actor, data)
        with self.assertRaises(m.Fault): self.call('messages', data=self.message() | {'device':self.win['id']})

    def test_source_paths_and_secrets_are_rejected_atomically(self):
        for name in ['../x', '/x', 'x//y', 'x\\y', '.local/key', '.env', 'target/x', 'src/CON.ts', 'src/x.', 'src/x\ny', 'src/a b']:
            with self.subTest(name=name), self.assertRaises(m.Fault):
                self.call('changes', data=self.change() | {'files': {name:'YQ=='}})
        for content in [b'\x00', b'-----BEGIN '+b'PRIVATE KEY-----', b'sk-'+b'x'*32, b'\xff']:
            with self.assertRaises(m.Fault):
                self.call('changes', data=self.change() | {'files': {'src/x':base64.b64encode(content).decode()}})
        self.assertEqual(self.call('changes')['items'], [])

    def test_logs_are_session_scoped_redacted_and_do_not_become_conversations(self):
        log = dict(requestId='log-1', agent='workshop', session='win-session', level='critical',
                   code='shell.cleanup-unknown', operation='tool-1', detail='Bearer private-secret password=hidden')
        self.call('logs', self.win, log)
        rows = self.call('logs', query={'device':[self.win['id']], 'session':['win-session'], 'operation':['tool-1']})['items']
        self.assertEqual(len(rows), 1)
        self.assertNotIn('private-secret', rows[0]['payload']['detail'])
        self.assertNotIn('hidden', rows[0]['payload']['detail'])
        self.assertEqual(self.call('logs', query={'session':['mac-session']})['items'], [])
        with self.h.connection() as c: self.assertEqual(c.execute('SELECT COUNT(*) FROM records').fetchone()[0], 0)

    def test_pagination_does_not_skip_equal_timestamps(self):
        for i in range(3): self.call('changes', data=self.change() | {'requestId':str(i)})
        first = self.call('changes', query={'limit':['2']})
        second = self.call('changes', query={'limit':['2'], 'after':[str(first['next'])]})
        self.assertEqual(len(first['items'])+len(second['items']), 3)
        self.assertIsNone(second['next'])
        with self.assertRaises(m.Fault): self.call('changes', query={'limit':['100000']})

    def test_agent_discovery_is_observed_presence_not_online_or_execution(self):
        self.call('presence', self.win, {'agent':'enki','session':'win-session'})
        self.call('presence', self.win, {'agent':'enki','session':'win-session'})
        agents = self.call('status')['agents']
        self.assertEqual(len(agents), 1)
        self.assertEqual(agents[0]['device'], self.win['id'])
        self.assertNotIn('online', agents[0])

    def test_automatic_ingest_failures_are_retrievable_by_original_session_and_device(self):
        record = dict(engine='pi',sessionId='win-session',id='reply',role='assistant',created=1,
                      tools=[dict(id='tool-1',name='bash',status='error',error='password=hidden timeout',durationMs=1800000)])
        self.h.ingest(self.win, {'records':[record]})
        log = self.call('logs',query={'session':['win-session'],'device':[self.win['id']]})
        self.assertEqual(len(log['historyErrors']), 1)
        self.assertNotIn('hidden', log['historyErrors'][0]['detail'])
        self.assertEqual(self.call('logs',query={'session':['other']})['historyErrors'], [])

    def test_retention_only_removes_exchange_and_keeps_conversations(self):
        self.call('changes',data=self.change())
        self.h.ingest(self.mac, {'records':[dict(engine='pi',sessionId='saved',id='m',role='user',created=1)]})
        self.h.workshop.maintain(9*10**15)
        self.assertEqual(self.call('changes')['items'], [])
        with self.h.connection() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM records').fetchone()[0], 1)

if __name__ == '__main__':
    unittest.main()
