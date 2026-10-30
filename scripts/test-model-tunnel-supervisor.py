import importlib.util
import threading
import unittest
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

spec = importlib.util.spec_from_file_location('supervisor', Path(__file__).with_name('model-tunnel-supervisor.py'))
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class Tests(unittest.TestCase):
    def test_arguments_and_validation(self):
        config = {'ssh_host': 'service-vm', 'forwards': [{'local_port': 18021, 'remote_port': 8080, 'remote_host': '10.0.0.5'}], 'health_port': 18021}
        args, url = supervisor.connection(config)
        self.assertIn('StrictHostKeyChecking=yes', args)
        self.assertIn('ForkAfterAuthentication=no', args)
        self.assertIn('PermitLocalCommand=no', args)
        self.assertIn('127.0.0.1:18021:10.0.0.5:8080', args)
        self.assertEqual(url, 'http://127.0.0.1:18021/health')
        for patch in [{'ssh_host': '-oProxyCommand=evil'}, {'health_port': 4096}, {'health_path': '/?token=secret'}, {'forwards': [config['forwards'][0]] * 2}]:
            with self.assertRaises(ValueError): supervisor.connection(dict(config, **patch))

    def test_actual_http_server_errors_and_redirect_do_not_restart_transport(self):
        paths = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                paths.append(self.path)
                self.send_response(302 if self.path == '/redirect' else 503)
                self.send_header('Location', '/not-allowed'); self.end_headers()
            def log_message(self, *_): pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            origin = 'http://127.0.0.1:%d' % server.server_port
            self.assertTrue(supervisor.reachable(origin + '/health', 1))
            self.assertTrue(supervisor.reachable(origin + '/redirect', 1))
            self.assertEqual(paths, ['/health', '/redirect'])
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_stalled_forward_requires_three_failures_and_only_kills_owned_child(self):
        stop = threading.Event(); children = []; calls = []
        class Child:
            def __init__(self): self.closed = False
            def poll(self): return 0 if self.closed else None
            def terminate(self): self.closed = True
            def wait(self, **_): pass
        def spawn():
            c = Child(); children.append(c); return c
        def probe(_):
            calls.append(len(children))
            if len(children) == 2: stop.set(); return True
            return False
        supervisor.supervise([], 'http://127.0.0.1:1/health', stop, spawn, probe, interval=.001, retry=.001)
        self.assertEqual(calls, [1, 1, 1, 2])
        self.assertEqual(len(children), 2)
        self.assertTrue(all(c.closed for c in children))

    def test_real_listening_but_stalled_child_recovers_without_inference(self):
        with tempfile.TemporaryDirectory(prefix='arvela-tunnel-http-') as directory:
            root = Path(directory); port_file = root / 'port'; fixture = root / 'fixture.py'
            fixture.write_text('''import pathlib,sys,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  if sys.argv[2]=='1': time.sleep(30)
  else: self.send_response(200); self.end_headers()
 def log_message(self,*_): pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
pathlib.Path(sys.argv[1]).write_text(str(server.server_port))
server.serve_forever()
''')
            stop = threading.Event(); children = []; deadline = 0.0
            observations = []
            def spawn():
                nonlocal deadline
                port_file.unlink(missing_ok=True)
                child = subprocess.Popen([sys.executable, str(fixture), str(port_file), str(len(children)+1)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                children.append(child)
                # A cold CI interpreter may start slowly. Readiness is separate
                # from the recovery deadline; an early exit must fail explicitly.
                startup_deadline = time.monotonic() + 60
                while not port_file.exists() and child.poll() is None and time.monotonic() < startup_deadline: time.sleep(.01)
                if not port_file.exists():
                    supervisor.terminate(child)
                    self.fail('HTTP fixture did not become ready before its startup deadline')
                deadline = time.monotonic() + 15
                return child
            def probe(_):
                if time.monotonic() >= deadline: stop.set(); return False
                url = 'http://127.0.0.1:%s/health' % port_file.read_text()
                result = supervisor.reachable(url, .05); observations.append(result)
                if result: stop.set()
                return result
            supervisor.supervise([], '', stop, spawn, probe, interval=.01, retry=.01)
            self.assertEqual(observations, [False, False, False, True])
            self.assertEqual(len(children), 2)
            self.assertTrue(all(child.poll() is not None for child in children))


if __name__ == '__main__': unittest.main()
