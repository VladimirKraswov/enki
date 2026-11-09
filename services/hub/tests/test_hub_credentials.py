import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from model_services import ModelServices


class Fault(Exception):
    def __init__(self, code, text):
        super().__init__(text)
        self.code = code


class HubCredentialsTest(unittest.TestCase):
    def make(self, data):
        tmp = tempfile.TemporaryDirectory()
        root = Path(tmp.name)
        config = root / "model-services.json"
        config.write_text(json.dumps(data))
        config.chmod(0o600)
        catalog = type("Catalog", (), {"get": lambda self: {"models": []}})()
        return tmp, ModelServices(root, catalog, Fault, config=config)

    def test_credentials_are_served_to_devices_and_never_leak_into_the_catalog(self):
        tmp, services = self.make({"services": {}, "credentials": {
            "deepseek": {"type": "api_key", "key": "hub-key"},
            "kimi-coding": {"type": "oauth", "access": "a", "refresh": "r", "expires": 1}}})
        try:
            result = services.api("POST", "credentials", {"id": "device"}, {"providerID": "deepseek"})
            self.assertEqual(result["credential"]["key"], "hub-key")
            result = services.api("POST", "credentials", {"id": "device"}, {"providerID": "kimi-coding"})
            self.assertEqual(result["credential"]["type"], "oauth")
            with self.assertRaises(Fault) as missing:
                services.api("POST", "credentials", {"id": "device"}, {"providerID": "unknown"})
            self.assertEqual(missing.exception.code, 404)
            self.assertNotIn("hub-key", json.dumps(services.api("GET", "catalog", {"id": "device"}, {})))
        finally:
            tmp.cleanup()

    def test_malformed_credential_fails_closed(self):
        tmp, services = self.make({"services": {}, "credentials": {"deepseek": {"type": "api_key", "key": ""}}})
        try:
            with self.assertRaises(Fault) as failure:
                services.api("POST", "credentials", {"id": "device"}, {"providerID": "deepseek"})
            self.assertEqual(failure.exception.code, 503)
        finally:
            tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
