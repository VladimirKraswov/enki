import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import Hub


class HubConsoleTest(unittest.TestCase):
    def test_overview_lists_devices_channels_and_model_centre_without_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            hub = Hub(Path(tmp))
            device = hub.provision("MacBook", "macos", admin=True)
            device_id, token = device["id"], device["token"]
            data = hub.console_overview({"id": device_id})
            self.assertEqual([d["id"] for d in data["devices"]], [device_id])
            self.assertEqual(data["devices"][0]["name"], "MacBook")
            self.assertEqual(set(data["channels"]), {"stable", "preview"})
            self.assertIn("services", data)
            self.assertEqual(data["credentialProviders"], [])
            self.assertEqual(data["catalogModels"], [])
            self.assertNotIn(token, json.dumps(data))

    def test_console_shell_is_a_self_contained_page(self):
        root = Path(__file__).resolve().parents[1]
        html = (root / "console.html").read_text()
        self.assertIn("/console.js", html)
        self.assertIn("/console.css", html)
        for name in ("console.js", "console.css"):
            self.assertTrue((root / name).is_file())
        self.assertIn("/api/console/overview", (root / "console.js").read_text())


if __name__ == "__main__":
    unittest.main()
