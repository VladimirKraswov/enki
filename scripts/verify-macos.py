"""Validate the signed release artifact, not just source plist files.

Run on macOS after bundling: python3 scripts/verify-macos.py /path/to/App.app
"""
import pathlib
import plistlib
import subprocess
import sys


MACHO = {b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"}


def verify_runtime(app):
    """The bundled Enki Runtime: manifest-complete, no symlinks, every nested
    Mach-O signed with the hardened runtime, Node with only the JIT entitlements."""
    import hashlib
    import json

    root = app / "Contents/Resources/agent-runtime"
    manifest = json.loads((root / "runtime-manifest.json").read_text())
    if manifest.get("schema") != 1 or manifest.get("node") != "node/bin/node":
        raise ValueError("Bundled runtime manifest is missing or unexpected")
    for relative, expected in manifest["files"].items():
        path = root / relative
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Bundled runtime file is not a regular file: {relative}")
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f"Bundled runtime file changed after manifest: {relative}")
        with path.open("rb") as file:
            if file.read(4) in MACHO:
                subprocess.run(["codesign", "--verify", "--strict", str(path)], check=True)
                flags = subprocess.run(["codesign", "-d", "-vv", str(path)], capture_output=True, text=True, check=True)
                if "runtime" not in (flags.stdout + flags.stderr):
                    raise ValueError(f"Nested runtime binary lacks the hardened runtime: {relative}")
    node = subprocess.run(["codesign", "-d", "--entitlements", ":-", str(root / "node/bin/node")], capture_output=True, check=True)
    granted = plistlib.loads(node.stdout) if node.stdout.strip() else {}
    allowed = {"com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory"}
    if set(granted) - allowed:
        raise ValueError(f"Bundled Node has unexpected entitlements: {sorted(set(granted) - allowed)}")
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
