import http.server
import http.client
import json
import threading
import unittest
from test_http import HTTP
from test_hub import m


class RemoteAPI(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path
        self.tmp = tempfile.TemporaryDirectory()
        self.h = m.Hub(Path(self.tmp.name))
        self.mac = self.h.lan_actor('MacBook', 'macos')
        self.win = self.h.lan_actor('Windows', 'windows')

    def tearDown(self): self.tmp.cleanup()

    def test_snapshots_commands_watch_and_idempotent_receipts(self):
        overview = {'version':'2.0.66','sessions':[], 'providers':{'all':[]}, 'settings':{}}
        first = self.h.remote.sync(self.mac, {'overview':overview})
        self.assertEqual(first['commands'], [])
        command = self.h.remote.command({'id':'cmd-1','device':self.mac['id'],'session':'session-1',
            'kind':'stop','payload':{}})
        self.assertEqual(command['state'],'queued')
        duplicate = self.h.remote.command({'id':'cmd-1','device':self.mac['id'],'session':'session-1',
            'kind':'stop','payload':{}})
        self.assertEqual(duplicate['id'],'cmd-1')
        with self.assertRaises(m.Fault):
            self.h.remote.command({'id':'cmd-1','device':self.mac['id'],'session':None,
                'kind':'providers.refresh','payload':{'other':True}})
        delivered = self.h.remote.sync(self.mac, {'overview':overview})
        self.assertEqual(delivered['commands'][0]['id'],'cmd-1')
        self.assertEqual(self.h.remote.sync(self.mac, {'overview':overview})['commands'][0]['id'],'cmd-1')
        self.h.remote.complete(self.mac, {'id':'cmd-1','ok':True,'result':{'errors':[]}})
        self.assertTrue(self.h.remote.complete(self.mac, {'id':'cmd-1','ok':True,'result':{'errors':[]}})['duplicate'])
        with self.assertRaises(m.Fault): self.h.remote.complete(self.win, {'id':'cmd-1','ok':True,'result':{}})
        listed = self.h.remote.overview()
        self.assertEqual(listed['authorization'],'lan-only')
        self.assertTrue(next(d for d in listed['devices'] if d['id']==self.mac['id'])['online'])
        self.h.remote.watch({'device':self.mac['id'],'session':'session-1'})
        sync = self.h.remote.sync(self.mac, {'overview':overview})
        self.assertEqual(sync['watch'],'session-1')
        self.h.remote.sync(self.mac, {'overview':overview,'detail':{'session':'session-1','messages':[{'info':{'role':'user'},'parts':[]}]}})
        detail = self.h.remote.session({'device':[self.mac['id']],'session':['session-1']})
        self.assertEqual(detail['detail']['messages'][0]['info']['role'],'user')
        self.assertEqual(detail['commands'][0]['state'],'done')

    def test_invalid_or_cross_device_commands_fail_closed(self):
        for data in [
            {'device':self.mac['id'],'kind':'shell','payload':{}},
            {'device':self.mac['id'],'kind':'stop','payload':{}},
            {'device':'missing','session':'s','kind':'stop','payload':{}},
        ]:
            with self.subTest(data=data), self.assertRaises(m.Fault): self.h.remote.command(data)


class RemoteHTTP(HTTP):
    def test_pwa_manifest_icons_and_worker_are_served_without_login(self):
        import struct
        code, headers, raw = self.req('/remote.webmanifest')
        self.assertEqual(code,200)
        self.assertEqual(headers['Content-Type'],'application/manifest+json; charset=utf-8')
        manifest = json.loads(raw)
        self.assertEqual(manifest['start_url'],'/remote')
        self.assertEqual(manifest['display'],'standalone')
        self.assertEqual([icon['sizes'] for icon in manifest['icons']],['192x192','512x512'])
        for size in (192,512):
            code, headers, icon = self.req(f'/remote-icon-{size}.png')
            self.assertEqual(code,200)
            self.assertEqual(headers['Content-Type'],'image/png')
            self.assertEqual(icon[:8],b'\x89PNG\r\n\x1a\n')
            self.assertEqual(struct.unpack('>II',icon[16:24]),(size,size))
        code, headers, worker = self.req('/remote-sw.js')
        self.assertEqual(code,200)
        self.assertIn('no-cache',headers['Cache-Control'])
        text = worker.decode()
        self.assertIn("url.pathname.startsWith('/api/')",text)
        self.assertNotIn("cache.addAll(SHELL)", text.split('self.addEventListener(\'fetch\'')[1])

    def test_page_needs_no_login_and_asr_uses_existing_service(self):
        code, _, body = self.req('/remote')
        self.assertEqual(code, 200)
        self.assertIn('Enki', body.decode())
        self.assertEqual(self.req('/api/remote/overview')[0], 200)
        seen = {}
        class ASR(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers['Content-Length'])
                seen['body'] = self.rfile.read(length)
                seen['type'] = self.headers['Content-Type']
                raw = json.dumps({'text':'Привет с телефона'}).encode()
                self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(raw))); self.end_headers(); self.wfile.write(raw)
            def log_message(self, *args): pass
        fixture = http.server.ThreadingHTTPServer(('127.0.0.1',0), ASR)
        thread = threading.Thread(target=fixture.serve_forever, daemon=True); thread.start()
        old = m._remote_module.ASR_URL
        m._remote_module.ASR_URL = f'http://127.0.0.1:{fixture.server_port}/v1/audio/transcriptions'
        try:
            boundary = 'enki-test-boundary'
            body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.webm"\r\nContent-Type: audio/webm\r\n\r\n').encode() + b'audio' + f'\r\n--{boundary}--\r\n'.encode()
            # HTTP.req JSON-encodes structured bodies; use the raw client for audio.
            c = http.client.HTTPSConnection('localhost',self.server.server_port,context=self.ctx,timeout=5)
            c.request('POST','/api/remote/asr',body=body,headers={'Content-Type':'multipart/form-data; boundary='+boundary})
            response = c.getresponse(); raw = response.read(); code = response.status; c.close()
            self.assertEqual(code,200)
            self.assertEqual(json.loads(raw)['text'],'Привет с телефона')
            self.assertIn(b'audio',seen['body'])
            self.assertIn('multipart/form-data',seen['type'])
        finally:
            m._remote_module.ASR_URL = old; fixture.shutdown(); fixture.server_close(); thread.join()
