"""Signing-policy fixtures only: no real codesign, app or native addon runs."""
import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("verify_macos", HERE / "verify-macos.py")
macos = importlib.util.module_from_spec(spec)
spec.loader.exec_module(macos)
ADHOC = "flags=0x10002(adhoc,runtime)\nSignature=adhoc\nTeamIdentifier=not set\n"
DEVELOPER = "flags=0x10000(runtime)\nAuthority=Developer ID Application: Example\nTeamIdentifier=TEAM123\n"
JIT = {key: True for key in macos.NODE_JIT}
ADHOC_NODE = {key: True for key in macos.NODE_ADHOC}


class NodeSigningPolicy(unittest.TestCase):
    def test_tracked_entitlements_have_only_the_exact_two_signing_sets(self):
        root = HERE.parent / "src-tauri"
        self.assertEqual(plistlib.loads((root / "runtime-node.entitlements").read_bytes()), JIT)
        self.assertEqual(plistlib.loads((root / "runtime-node-adhoc.entitlements").read_bytes()), ADHOC_NODE)

    def test_adhoc_node_requires_the_library_validation_exception(self):
        macos.verify_node_policy(ADHOC_NODE, ADHOC, ADHOC, {"node/bin/node": ADHOC})
        with self.assertRaisesRegex(ValueError, "exactly the ad-hoc"):
            macos.verify_node_policy(JIT, ADHOC, ADHOC, {})

    def test_developer_id_retains_library_validation(self):
        macos.verify_node_policy(JIT, DEVELOPER, DEVELOPER, {"app/native.node": DEVELOPER})
        with self.assertRaisesRegex(ValueError, "exactly the Developer ID"):
            macos.verify_node_policy(ADHOC_NODE, DEVELOPER, DEVELOPER, {})

    def test_no_other_entitlements_or_false_required_grants_are_accepted(self):
        for details, allowed in [(ADHOC, ADHOC_NODE), (DEVELOPER, JIT)]:
            for forbidden in ["com.apple.security.cs.allow-dyld-environment-variables",
                              "com.apple.security.cs.disable-executable-page-protection",
                              "com.apple.security.device.audio-input"]:
                with self.subTest(forbidden=forbidden, details=details):
                    with self.assertRaises(ValueError):
                        macos.verify_node_policy({**allowed, forbidden: True}, details, details, {})
            for key in allowed:
                with self.assertRaises(ValueError):
                    macos.verify_node_policy({**allowed, key: False}, details, details, {})

    def test_signing_mode_cannot_be_mixed_to_bypass_developer_id_policy(self):
        for node, app in [(ADHOC, DEVELOPER), (DEVELOPER, ADHOC)]:
            with self.assertRaisesRegex(ValueError, "signing mode differs"):
                macos.verify_node_policy(ADHOC_NODE, node, app, {})

    def test_developer_id_node_and_every_nested_binary_share_the_app_team(self):
        wrong = DEVELOPER.replace("TEAM123", "OTHERTEAM")
        for node in [wrong, DEVELOPER.replace("TEAM123", "not set")]:
            with self.assertRaisesRegex(ValueError, "share the signed app's team"):
                macos.verify_node_policy(JIT, node, DEVELOPER, {})
        for nested in [wrong, ADHOC]:
            with self.assertRaisesRegex(ValueError, "Nested runtime binary"):
                macos.verify_node_policy(JIT, DEVELOPER, DEVELOPER, {"app/native.node": nested})

    def runtime_fixture(self, directory, details, entitlements):
        app = Path(directory) / "Fixture.app"
        root = app / "Contents/Resources/agent-runtime"
        files = {"node/bin/node": b"\xcf\xfa\xed\xfeowned-node",
                 "app/native.node": b"\xcf\xfa\xed\xfeowned-addon"}
        for relative, data in files.items():
            file = root / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
        manifest = {"schema": 1, "node": "node/bin/node", "version": "fixture",
                    "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
        (root / "runtime-manifest.json").write_text(json.dumps(manifest))

        def codesign(argv, **kwargs):
            self.assertEqual(argv[0], "codesign")
            if "--entitlements" in argv:
                return subprocess.CompletedProcess(argv, 0, plistlib.dumps(entitlements), b"")
            return subprocess.CompletedProcess(argv, 0, "", details)

        return app, root, codesign

    def test_final_bundle_gate_applies_the_mode_specific_policy(self):
        with tempfile.TemporaryDirectory(prefix="verify-macos-fixture-") as directory:
            app, _, codesign = self.runtime_fixture(directory, ADHOC, ADHOC_NODE)
            with patch.object(macos.subprocess, "run", side_effect=codesign) as calls:
                macos.verify_runtime(app)
            self.assertEqual(sum("--verify" in call.args[0] for call in calls.call_args_list), 2)
            _, _, codesign = self.runtime_fixture(directory, DEVELOPER, ADHOC_NODE)
            with patch.object(macos.subprocess, "run", side_effect=codesign):
                with self.assertRaisesRegex(ValueError, "exactly the Developer ID"):
                    macos.verify_runtime(app)

    def test_manifest_byte_validation_is_not_weakened_by_signing_mode(self):
        with tempfile.TemporaryDirectory(prefix="verify-macos-fixture-") as directory:
            app, root, codesign = self.runtime_fixture(directory, ADHOC, ADHOC_NODE)
            (root / "app/native.node").write_bytes(b"tampered")
            with patch.object(macos.subprocess, "run", side_effect=codesign):
                with self.assertRaisesRegex(ValueError, "changed after manifest"):
                    macos.verify_runtime(app)


if __name__ == "__main__":
    unittest.main()
