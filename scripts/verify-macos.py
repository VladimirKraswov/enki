"""Validate the signed release artifact, not just source plist files.

Run on macOS after bundling: python3 scripts/verify-macos.py /path/to/App.app
"""
import pathlib
import plistlib
import os
import re
import subprocess
import sys


MACHO = {b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"}
NODE_JIT = {"com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory"}
NODE_ADHOC = NODE_JIT | {"com.apple.security.cs.disable-library-validation"}


def adhoc_signature(details):
    return re.search(r"^Signature=adhoc$", details, re.MULTILINE) is not None


def signature_team(details):
    match = re.search(r"^TeamIdentifier=(.+)$", details, re.MULTILINE)
    return match.group(1) if match and match.group(1) != "not set" else None


def verify_node_policy(granted, node_details, app_details, nested_details):
    """Only a genuinely ad-hoc distribution needs the Node LV exception."""
    adhoc = adhoc_signature(app_details)
    if adhoc_signature(node_details) != adhoc:
        raise ValueError("Bundled Node signing mode differs from the signed app")
    allowed = NODE_ADHOC if adhoc else NODE_JIT
    if set(granted) != allowed or any(value is not True for value in granted.values()):
        raise ValueError(f"Bundled Node must have exactly the {'ad-hoc' if adhoc else 'Developer ID'} entitlement set")
    if not adhoc:
        team = signature_team(app_details)
        if not team or signature_team(node_details) != team:
            raise ValueError("Bundled Node must share the signed app's team")
        for relative, details in nested_details.items():
            if adhoc_signature(details) or signature_team(details) != team:
                raise ValueError(f"Nested runtime binary must share the signed app's team: {relative}")


def verify_runtime(app):
    """The bundled Enki Runtime: manifest-complete, no symlinks, every nested
    Mach-O signed with the hardened runtime; only ad-hoc Node may bypass LV."""
    import hashlib
    import json

    root = app / "Contents/Resources/agent-runtime"
    manifest = json.loads((root / "runtime-manifest.json").read_text())
    if manifest.get("schema") != 1 or manifest.get("node") != "node/bin/node":
        raise ValueError("Bundled runtime manifest is missing or unexpected")
    app_signature = subprocess.run(["codesign", "-d", "-vv", str(app)], capture_output=True, text=True, check=True)
    app_details = app_signature.stdout + app_signature.stderr
    nested = {}
    for relative, expected in manifest["files"].items():
        path = root / relative
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Bundled runtime file is not a regular file: {relative}")
        executable = relative == "node/bin/node" or relative.startswith("app/node_modules/node-pty/") and relative.endswith("/spawn-helper")
        if os.name != "nt" and executable and not path.stat().st_mode & 0o111:
            raise ValueError(f"Bundled runtime executable has no execute permission: {relative}")
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f"Bundled runtime file changed after manifest: {relative}")
        with path.open("rb") as file:
            if file.read(4) in MACHO:
                subprocess.run(["codesign", "--verify", "--strict", str(path)], check=True)
                flags = subprocess.run(["codesign", "-d", "-vv", str(path)], capture_output=True, text=True, check=True)
                details = flags.stdout + flags.stderr
                if "runtime" not in details:
                    raise ValueError(f"Nested runtime binary lacks the hardened runtime: {relative}")
                nested[relative] = details
    node = subprocess.run(["codesign", "-d", "--entitlements", ":-", str(root / "node/bin/node")], capture_output=True, check=True)
    granted = plistlib.loads(node.stdout) if node.stdout.strip() else {}
    if "node/bin/node" not in nested:
        raise ValueError("Bundled Node is not a verified Mach-O executable")
    verify_node_policy(granted, nested["node/bin/node"], app_details, nested)
    print(f"Verified bundled Enki Runtime {manifest['version']} ({len(manifest['files'])} files)")


def verify(app):
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
    result = subprocess.run(
        ["codesign", "-d", "--entitlements", ":-", str(app)],
        capture_output=True, check=True,
    )
    if not result.stdout.strip():
        raise ValueError("Signed bundle has no entitlements: microphone capture will be denied")
    entitlements = plistlib.loads(result.stdout)
    if entitlements.get("com.apple.security.device.audio-input") is not True:
        raise ValueError("Signed bundle is missing the audio-input entitlement")
    with (app / "Contents/Info.plist").open("rb") as file:
        info = plistlib.load(file)
    if not info.get("NSMicrophoneUsageDescription", "").strip():
        raise ValueError("Bundle is missing NSMicrophoneUsageDescription")
    for key in ("NSDocumentsFolderUsageDescription", "NSDesktopFolderUsageDescription", "NSDownloadsFolderUsageDescription"):
        if not info.get(key, "").strip():
            raise ValueError(f"Bundle is missing {key}")
    verify_runtime(app)
    signature = subprocess.run(["codesign", "-d", "-r-", str(app)], capture_output=True, text=True, check=True)
    requirement = signature.stdout + signature.stderr
    if "designated => cdhash" in requirement:
        print("WARNING: ad hoc identity changes between builds; macOS privacy grants may need renewal. Stable release signing requires Developer ID.")
    print(f"Verified signature and microphone capability: {info['CFBundleShortVersionString']}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: python3 scripts/verify-macos.py /path/to/App.app")
    try:
        verify(pathlib.Path(sys.argv[1]))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
