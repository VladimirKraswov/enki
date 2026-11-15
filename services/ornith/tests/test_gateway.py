import importlib.util
import json
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path
from unittest import mock


class GatewayTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "key").write_text("test-key")
        (root / "models").mkdir()
        spec = importlib.util.spec_from_file_location("ornith_gateway", Path(__file__).parents[1] / "gateway.py")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.module.CONTROL_KEY_FILE = root / "key"
        self.module.STATE_FILE = root / "active.json"
        self.module.MODEL_DIR = root / "models"
        self.server = self.module.ThreadingHTTPServer(("127.0.0.1", 0), self.module.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def get(self, path, body=None, key=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method="POST" if data else "GET")
        if key:
            req.add_header("Authorization", "Bearer " + key)
        if data:
            req.add_header("Content-Type", "application/json")
        return json.load(urllib.request.urlopen(req, timeout=3))

    def test_health_catalog_status_and_same_model_noop(self):
        self.assertEqual(self.get("/health")["model"], self.module.QWEN)
        with self.assertRaises(urllib.error.HTTPError):
            self.get("/v1/model-control/catalog")
        catalog = self.get("/v1/model-control/catalog", key="test-key")
        self.assertEqual([m["id"] for m in catalog["models"]], ["qwen38-flash-next", "ornith15-122b"])
        with mock.patch.object(self.module, "service_active", return_value=True):
            status = self.get("/v1/model-control/status", key="test-key")
        self.assertTrue(status["ready"])
        self.assertEqual(status["active_model"], "qwen38-flash-next")
        with mock.patch.object(self.module, "service_active", return_value=True):
            selected = self.get("/v1/model-control/select", {"model": "qwen38-flash-next", "agent": "pi"}, key="test-key")
        self.assertTrue(selected["ready"])
        self.assertEqual(selected["active_model"], "qwen38-flash-next")

    def test_select_rejects_unknown_model_and_bad_credential(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/v1/model-control/select", {"model": "unknown", "agent": "pi"}, key="test-key")
        self.assertEqual(caught.exception.code, 403)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/v1/model-control/status", key="wrong")
        self.assertEqual(caught.exception.code, 401)

    def test_failed_state_recovers_only_when_active_model_is_healthy(self):
        self.module.STATE.phase = "failed"
        self.module.STATE.error = "previous failure"
        with mock.patch.object(self.module, "qwen_ready", return_value=True), \
                mock.patch.object(self.module, "service_active", return_value=True):
            selected = self.get("/v1/model-control/select", {"model": "qwen38-flash-next", "agent": "pi"}, key="test-key")
        self.assertTrue(selected["ready"])
        self.assertIsNone(selected["error"])

    def test_unloaded_qwen_uses_load_not_service_restart(self):
        self.module.STATE.active = self.module.ORNITH
        with mock.patch.object(self.module, "stop_ornith"), \
                mock.patch.object(self.module, "qwen_model_state", return_value="unloaded"), \
                mock.patch.object(self.module, "qwen_action") as action, \
                mock.patch.object(self.module, "start_unit") as start, \
                mock.patch.object(self.module, "wait_for"):
            self.module.switch_to(self.module.QWEN, 1)
        action.assert_called_once_with("load")
        start.assert_not_called()
        self.assertEqual(self.module.STATE.active, self.module.QWEN)
        self.assertEqual(self.module.STATE.phase, "ready")

    def test_exclusive_ram_stops_qwen_service(self):
        self.module.STATE.active = self.module.QWEN
        self.module.ORNITH_EXCLUSIVE_RAM = True
        with mock.patch.object(self.module, "qwen_action"), \
                mock.patch.object(self.module, "wait_gpu_free"), \
                mock.patch.object(self.module, "stop_qwen_service") as stop_qwen, \
                mock.patch.object(self.module, "start_unit") as start_unit, \
                mock.patch.object(self.module, "wait_for"):
            self.module.switch_to(self.module.ORNITH, 1)
        stop_qwen.assert_called_once_with()
        start_unit.assert_called_once_with(self.module.ORNITH_SERVICE)

    def test_wait_for_aborts_when_owned_service_failed(self):
        with mock.patch("subprocess.run", return_value=mock.Mock(returncode=0)):
            with self.assertRaises(RuntimeError):
                self.module.wait_for(self.module.ORNITH, timeout=1)

    def test_init_prefers_healthy_ornith_when_saved_qwen_is_stopped(self):
        import tempfile
        from pathlib import Path as _Path
        with tempfile.TemporaryDirectory() as directory:
            path = _Path(directory) / "active.json"
            path.write_text('{"active": "qwen38-flash-next"}')
            with mock.patch.object(self.module, "STATE_FILE", path), \
                    mock.patch.object(self.module, "service_active", side_effect=lambda unit: unit == self.module.ORNITH_SERVICE), \
                    mock.patch.object(self.module, "ornith_ready", return_value=True):
                state = self.module.State()
        self.assertEqual(state.active, self.module.ORNITH)
        self.assertEqual(state.phase, "ready")
        self.assertIsNone(state.restore_model)

    def test_init_waits_for_warming_ornith_instead_of_claiming_ready(self):
        import tempfile
        from pathlib import Path as _Path
        with tempfile.TemporaryDirectory() as directory:
            path = _Path(directory) / "active.json"
            path.write_text('{"active": "ornith15-122b"}')
            with mock.patch.object(self.module, "STATE_FILE", path), \
                    mock.patch.object(self.module, "service_active", return_value=True), \
                    mock.patch.object(self.module, "ornith_ready", return_value=False):
                state = self.module.State()
        self.assertEqual(state.phase, "warming")
        self.assertEqual(state.restore_model, self.module.ORNITH)
        self.assertFalse(state.status()["ready"])

    def test_ornith_health_timeout_is_not_a_process_crash(self):
        with mock.patch.object(self.module, "request", side_effect=TimeoutError("slow start")):
            self.assertFalse(self.module.ornith_ready())

    def test_service_active_accepts_activating_during_readiness(self):
        with mock.patch("subprocess.run", return_value=mock.Mock(returncode=0, stdout="activating\n")):
            self.assertTrue(self.module.service_active("strata-api"))
        with mock.patch("subprocess.run", return_value=mock.Mock(returncode=0, stdout="failed\n")):
            self.assertFalse(self.module.service_active("strata-api"))

    def test_status_does_not_claim_stopped_service_is_ready(self):
        with mock.patch.object(self.module, "service_active", return_value=False):
            status = self.get("/v1/model-control/status", key="test-key")
        self.assertFalse(status["ready"])
        self.assertEqual(status["phase"], "failed")
        self.assertIn("not running", status["error"])

    def test_wait_for_aborts_when_started_unit_stays_inactive(self):
        with mock.patch.object(self.module, "service_restarts", return_value=0), \
                mock.patch.object(self.module.time, "sleep"), \
                mock.patch("subprocess.run", return_value=mock.Mock(returncode=1, stdout="inactive\n")):
            with self.assertRaises(RuntimeError) as caught:
                self.module.wait_for(self.module.ORNITH, timeout=30, baseline_restarts=0)
        self.assertIn("not running after start", str(caught.exception))

    def test_unit_start_does_not_block_on_readiness(self):
        with mock.patch("subprocess.run") as run:
            run.return_value.returncode = 0
            self.module.start_unit("strata-api")
        self.assertEqual(run.call_args.args[0], ["systemctl", "start", "--no-block", "strata-api"])

    def test_wait_for_aborts_on_service_restart_loop(self):
        with mock.patch.object(self.module, "service_restarts", side_effect=[0, 1]), \
                mock.patch.object(self.module, "ornith_ready", return_value=False), \
                mock.patch.object(self.module.time, "sleep"), \
                mock.patch("subprocess.run", return_value=mock.Mock(returncode=1)):
            with self.assertRaises(RuntimeError) as caught:
                self.module.wait_for(self.module.ORNITH, timeout=10, baseline_restarts=0)
        self.assertIn("restarted 1 time", str(caught.exception))

    def test_failed_target_is_stopped_before_previous_model_restore(self):
        self.module.STATE.active = self.module.QWEN
        with mock.patch.object(self.module, "qwen_action"), \
                mock.patch.object(self.module, "wait_gpu_free"), \
                mock.patch.object(self.module, "start_unit", return_value=0), \
                mock.patch.object(self.module, "wait_for", side_effect=RuntimeError("crash loop")), \
                mock.patch.object(self.module, "stop_ornith") as stop_target, \
                mock.patch.object(self.module, "activate_qwen") as restore_qwen:
            self.module.switch_to(self.module.ORNITH, 7)
        stop_target.assert_called_once_with()
        restore_qwen.assert_called_once_with()
        self.assertEqual(self.module.STATE.active, self.module.QWEN)
        self.assertEqual(self.module.STATE.phase, "failed")
        self.assertIn("crash loop", self.module.STATE.error)

    def test_qwen_transport_failure_is_not_ready(self):
        with mock.patch.object(self.module, "strata_key", return_value="key"), \
                mock.patch.object(self.module, "request", side_effect=ConnectionRefusedError(111, "Connection refused")):
            self.assertFalse(self.module.qwen_ready())


if __name__ == "__main__":
    unittest.main()
