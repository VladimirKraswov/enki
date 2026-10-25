import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location("hub", Path(__file__).parents[1] / "server.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def entry(mid):
    return {"id": mid, "label": mid, "control": {"service": "v100", "bindings": {mid: mid}},
        "opencode": {"providerId": "local-" + mid, "provider": {"options": {"baseURL": "http://127.0.0.1:18021/v1", "apiKey": "local"}, "models": {mid: {"name": mid}}}}}


class Gateway:
    def __init__(self):
        self.selected = []
        self.current = self.ready("qwen")

    def ready(self, model):
        return dict(schema=1, operation_id="op-" + model, phase="ready", ready=True,
            active_model=model, target_model=model, elapsed_seconds=1, active_requests=0, error=None, loader=None)

    def __call__(self, service, path, body=None):
        if path == "catalog":
            return {"schema": 1, "models": [{"id": mid, "agents": ["opencode"]} for mid in ("qwen", "artemis")]}
        if path == "select":
            self.selected.append(body["model"])
            self.current = {**self.ready(body["model"]), "phase": "loading", "ready": False, "active_model": None,
                "loader": {"phase": "weights", "unit": "bytes", "current": 4, "total": 10}}
        return dict(self.current)


class Coordination(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.hub = m.Hub(self.root)
        self.a = self.hub.authenticate(self.hub.provision("A", "macos")["token"])
        self.b = self.hub.authenticate(self.hub.provision("B", "windows")["token"])
        self.hub.model_catalog.put({"models": [entry("qwen"), entry("artemis")]}, {"name": "Owner"})
        FixturePath = Path
        if os.name == "nt":
            # The deployed Hub has a Linux private-file policy. Windows chmod
            # exposes only a readonly attribute, so this coordinator fixture
            # models POSIX modes for its TWO owned files. Reads, symlink/type,
            # size checks, SQLite and gateway calls remain real. Production
            # refuses insecure files unchanged; no Windows ACL claim is made.
            private_modes = {}
            tracked = {os.path.normcase(str(self.root / name))
                       for name in ("gateway.key", "services.json")}
            class FixturePath(type(Path())):
                def chmod(file, mode, **kwargs):
                    super().chmod(mode, **kwargs)
                    key = os.path.normcase(str(file))
                    if key in tracked:
                        private_modes[key] = mode & 0o777
                def stat(file, **kwargs):
                    info = super().stat(**kwargs)
                    mode = private_modes.get(os.path.normcase(str(file)))
                    return (os.stat_result(((info.st_mode & ~0o777) | mode, *info[1:]))
                            if mode is not None else info)
            native_path = patch.object(m._services_module, "Path", FixturePath)
            native_path.start()
            self.addCleanup(native_path.stop)
        token = FixturePath(self.root / "gateway.key")
        self.token = token
        token.write_text("test-private-control")
        token.chmod(0o600)
        self.config = FixturePath(self.root / "services.json")
        self.config.write_text(json.dumps({"services": {"v100": {"resource": "tesla-v100", "label": "V100", "endpoint": "http://192.168.1.3:8080", "tokenFile": str(token)}}}))
        self.config.chmod(0o600)
        self.gateway = Gateway()
        self.now = 100
        self.broker = self.new_broker()

    def new_broker(self):
        return m._services_module.ModelServices(self.root, self.hub.model_catalog, m.Fault,
            self.config, self.gateway, lambda: self.now)

    def tearDown(self):
        self.tmp.cleanup()

    def prepare(self, model, key, actor=None, mode="run"):
        self.now += .01
        return self.broker.api("POST", "prepare", actor or self.a,
            dict(providerID="local-" + model, modelID=model, agent="opencode", requestKey=key, mode=mode))

    def poll(self, result, actor=None):
        return self.broker.api("POST", "status", actor or self.a, {"ticket": result["operation_id"]})

    def release(self, result, actor=None):
        return self.broker.api("POST", "release", actor or self.a, {"ticket": result["operation_id"]})

    def test_switch_progress_exact_readiness_idempotency_and_no_inference(self):
        first = self.prepare("artemis", "unique")
        self.assertFalse(first["ready"])
        self.assertEqual(first["phase"], "loading")
        self.assertEqual(first["loader"]["current"], 4)
        same = self.prepare("artemis", "unique")
        self.assertEqual(first["operation_id"], same["operation_id"])
        self.assertEqual(self.gateway.selected, ["artemis"])
        self.gateway.current = self.gateway.ready("artemis")
        self.assertTrue(self.poll(first)["ready"])

    def test_whole_turn_lease_blocks_switch_even_between_http_requests(self):
        first = self.prepare("qwen", "run-a")
        self.assertTrue(first["ready"])
        waiting = self.prepare("artemis", "run-b", self.b)
        self.assertEqual(waiting["phase"], "waiting")
        self.assertEqual(self.gateway.selected, [])
        self.release(first)
        self.assertEqual(self.poll(waiting, self.b)["phase"], "loading")
        self.assertEqual(self.gateway.selected, ["artemis"])

    def test_same_model_clients_share_residency_but_cannot_release_anothers_lease(self):
        first = self.prepare("qwen", "run-a")
        second = self.prepare("qwen", "run-b", self.b)
        self.assertTrue(second["ready"])
        self.release(first, self.b)
        waiting = self.prepare("artemis", "next", self.b)
        self.release(second, self.b)
        self.assertEqual(self.poll(waiting, self.b)["phase"], "waiting")
        with self.assertRaises(m.Fault) as error:
            self.poll(first, self.b)
        self.assertEqual(error.exception.status, 404)

    def test_selection_does_not_block_run_and_lost_ack_is_idempotent(self):
        warm = self.prepare("qwen", "choose", mode="select")
        same = self.prepare("qwen", "choose", mode="select")
        self.assertTrue(same["ready"])
        self.assertEqual(warm["operation_id"], same["operation_id"])
        self.assertEqual(self.prepare("artemis", "run")["phase"], "loading")

    def test_restart_keeps_leases_and_expiry_frees_abandoned_client(self):
        self.prepare("qwen", "run")
        self.broker = self.new_broker()
        waiting = self.prepare("artemis", "next", self.b)
        self.assertEqual(waiting["phase"], "waiting")
        self.now += 599.9
        self.assertEqual(self.poll(waiting, self.b)["phase"], "waiting")
        self.now += .2
        self.assertEqual(self.poll(waiting, self.b)["phase"], "loading")

    def test_failed_loader_is_terminal_without_automatic_restarts(self):
        loading = self.prepare("artemis", "load")
        self.gateway.current.update(phase="failed", ready=False, error="secret gateway detail")
        failed = self.poll(loading)
        self.assertEqual(failed["phase"], "failed")
        self.assertNotIn("secret", json.dumps(failed))
        self.poll(failed)
        self.assertEqual(self.gateway.selected, ["artemis"])

    def test_external_model_change_fails_running_reservation_without_switching_back(self):
        ready = self.prepare("qwen", "run")
        self.gateway.current = self.gateway.ready("artemis")
        self.assertEqual(self.poll(ready)["phase"], "failed")
        self.assertEqual(self.gateway.selected, [])

    def test_catalog_contains_routes_but_no_gateway_address_or_key(self):
        catalog = self.broker.api("GET", "catalog", self.a, {})
        self.assertEqual(len(catalog["routes"]), 2)
        self.assertNotIn("192.168", json.dumps(catalog))
        self.assertNotIn("private", json.dumps(catalog))
        self.config.unlink()
        self.assertEqual(len(self.broker.routes()), 2)
        with self.assertRaises(m.Fault) as error:
            self.prepare("qwen", "run")
        self.assertEqual(error.exception.status, 503)

    def test_unregistered_model_untrusted_agent_and_credential_permissions_fail_closed(self):
        with self.assertRaises(m.Fault):
            self.prepare("unknown", "run")
        with self.assertRaises(m.Fault):
            self.broker.api("POST", "prepare", self.a, dict(providerID="local-qwen", modelID="qwen", agent="pi", requestKey="pi", mode="run"))
        self.config.chmod(0o644)
        with self.assertRaises(m.Fault):
            self.prepare("qwen", "run")

    def test_broad_gateway_key_permissions_are_refused_before_gateway_io(self):
        self.token.chmod(0o644)
        with self.assertRaises(m.Fault) as error:
            self.prepare("qwen", "private-key-policy")
        self.assertEqual(error.exception.status, 503)
        self.assertEqual(self.gateway.selected, [])

    def test_inspect_never_selects_or_creates_a_reservation(self):
        result = self.broker.api("POST", "inspect", self.a, dict(providerID="local-artemis", modelID="artemis", agent="opencode"))
        self.assertEqual(result["active_model"], "qwen")
        self.assertEqual(self.gateway.selected, [])
        with self.broker.db() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM reservations").fetchone()[0], 0)

    def test_cancel_during_gateway_io_cannot_resurrect_a_reservation(self):
        ready = self.prepare("qwen", "run")
        entered, finish = threading.Event(), threading.Event()
        def slow(service, path, body=None):
            if path == "status":
                entered.set()
                finish.wait(3)
            return self.gateway(service, path, body)
        self.broker.transport = slow
        errors = []
        def poll():
            try:
                self.poll(ready)
            except m.Fault as error:
                errors.append(error.status)
        thread = threading.Thread(target=poll)
        thread.start()
        self.assertTrue(entered.wait(2))
        self.release(ready)
        finish.set()
        thread.join(3)
        self.assertEqual(errors, [409])
        self.assertEqual(self.gateway.selected, [])

    def test_other_gpu_is_independent_of_a_running_v100_lease(self):
        self.prepare("qwen", "first")
        models = [entry("qwen"), entry("artemis")]
        models[1]["control"]["service"] = "other-gpu"
        self.hub.model_catalog.put({"models": models}, {"name": "Owner"})
        config = json.loads(self.config.read_bytes())
        config["services"]["other-gpu"] = {**config["services"]["v100"], "resource": "rtx5090"}
        self.config.write_text(json.dumps(config))
        other = Gateway()
        self.broker.transport = lambda service, path, body=None: (other if service["resource"] == "rtx5090" else self.gateway)(service, path, body)
        self.assertEqual(self.prepare("artemis", "other", self.b)["phase"], "loading")
        self.assertEqual(other.selected, ["artemis"])
        self.assertEqual(self.gateway.selected, [])

    def test_fixed_server_health_and_exact_id_are_checked_without_inference(self):
        seen = []
        class Handler(BaseHTTPRequestHandler):
            model = "qwen"
            health = {"status": "ok"}
            def log_message(self, *_):
                pass
            def do_GET(self):
                seen.append(self.path)
                body = json.dumps({"data": [{"id": self.model}]} if self.path == "/v1/models" else self.health).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            config = json.loads(self.config.read_bytes())
            service = config["services"]["v100"]
            service.update(kind="fixed", model="qwen", agents=["opencode"], endpoint="http://127.0.0.1:" + str(server.server_port))
            self.config.write_text(json.dumps(config))
            self.broker.transport = self.broker._request
            self.assertTrue(self.prepare("qwen", "fixed")["ready"])
            self.assertEqual(seen, ["/health", "/v1/models"])
            for health in ({"status": "ok", "loaded": False}, {"status": "loading"},
                           {"status": "error", "message": "private engine detail"},
                           {"status": "ok", "maintenance": "draining"},
                           {"status": "ok", "model": "another-model"},
                           {"status": "ok", "loaded": "true"}, {}):
                with self.subTest(health=health):
                    Handler.health = health
                    state = self.broker.state(service)
                    self.assertFalse(state["ready"])
                    self.assertNotIn("private engine detail", json.dumps(state))
            Handler.health = {"status": "ok", "loaded": True, "model": "qwen"}
            self.assertTrue(self.broker.state(service)["ready"])
            Handler.health = {"status": "ok", "maintenance": "serving", "model": "qwen"}
            self.assertTrue(self.broker.state(service)["ready"])
            Handler.model = "another-model"
            state = self.broker.state(service)
            self.assertFalse(state["ready"])
            self.assertEqual(state["phase"], "failed")
            before = len(seen)
            self.assertEqual(self.prepare("qwen", "fixed-offline")["phase"], "failed")
            self.assertEqual(seen[before:], ["/health", "/v1/models"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)
