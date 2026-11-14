import importlib.util
import json
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path


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
        status = self.get("/v1/model-control/status", key="test-key")
        self.assertTrue(status["ready"])
        self.assertEqual(status["active_model"], "qwen38-flash-next")
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


if __name__ == "__main__":
    unittest.main()
