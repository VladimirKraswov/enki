#!/usr/bin/env python3
"""Offline regression checks for portable shared skill helpers."""
import importlib.util
import json
import sys
sys.dont_write_bytecode = True
import tempfile
from types import SimpleNamespace
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1] / "src-tauri/resources/skills/web-file-download/scripts"


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


verify, archive = load("verify"), load("archive_search")


class Skills(unittest.TestCase):
    def test_invalid_and_missing_files_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "error.pdf"
            path.write_text("<html>access denied</html>")
            self.assertEqual(verify.inspect(path)["status"], "invalid")
            self.assertEqual(verify.inspect(path.with_name("absent.pdf"))["status"], "invalid")
            with patch("sys.argv", ["verify.py", str(path)]), patch("builtins.print"):
                self.assertEqual(verify.main(), 1)

    def test_header_only_is_never_complete_or_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "partial.pdf"
            path.write_bytes(b"%PDF-1.7\ntruncated")
            result = verify.inspect(path)
            self.assertIn(result["status"], ("invalid", "unverified"))
            self.assertEqual(result["complete"], "unknown")
            self.assertEqual(len(result["sha256"]), 64)

    def test_parser_accepted_one_page_is_not_proof_of_complete_book(self):
        objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                   b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>",
                   b"<< /Length 0 >>\nstream\n\nendstream"]
        raw = b"%PDF-1.4\n"; offsets = [0]
        for i, item in enumerate(objects, 1):
            offsets.append(len(raw)); raw += str(i).encode() + b" 0 obj\n" + item + b"\nendobj\n"
        xref = len(raw)
        raw += b"xref\n0 5\n0000000000 65535 f \n" + b"".join(f"{n:010d} 00000 n \n".encode() for n in offsets[1:])
        raw += f"trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cover.pdf"; path.write_bytes(raw)
            # This is a completeness-policy fixture, not qualification of a
            # real PDF parser. Never depend on optional host packages/tools.
            case = self

            class AcceptedReader:
                def __init__(self, selected, *, strict):
                    case.assertEqual(Path(selected).read_bytes(), raw)
                    case.assertIs(strict, True)
                    self.is_encrypted = False
                    self.pages = [SimpleNamespace(extract_text=lambda: "fixture page")]

            with patch.dict(sys.modules, {"pypdf": SimpleNamespace(PdfReader=AcceptedReader)}), \
                    patch.object(verify.shutil, "which", side_effect=AssertionError("No ambient PDF tool lookup")), \
                    patch.object(verify.subprocess, "run", side_effect=AssertionError("No PDF tool execution")):
                result = verify.inspect(path)
            self.assertEqual(result["status"], "structure-checked")
            self.assertEqual(result["parser"], "pypdf")
            self.assertEqual(result["pages"], 1)
            self.assertEqual(result["complete"], "unknown")

    def test_missing_parser_stays_unverified_and_cli_fails_without_completeness_claim(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "unparsed.pdf"
            path.write_bytes(b"%PDF-1.4\nparser-unavailable fixture\n")
            # Block even an installed pypdf and any ambient pdfinfo. A header
            # plus hash must never become successful structural verification.
            with patch.dict(sys.modules, {"pypdf": None}), \
                    patch.object(verify.shutil, "which", return_value=None), \
                    patch.object(verify.subprocess, "run", side_effect=AssertionError("No parser available")):
                result = verify.inspect(path)
                self.assertEqual(result["status"], "unverified")
                self.assertEqual(result["complete"], "unknown")
                self.assertNotIn("pages", result)
                self.assertNotIn("parser", result)
                self.assertEqual(len(result["sha256"]), 64)
                with patch("sys.argv", ["verify.py", str(path)]), patch("builtins.print"):
                    self.assertEqual(verify.main(), 1)

    def test_restrictions_and_exact_unicode_names(self):
        data = {"metadata": {"title": "Example", "rights": "Check licence"}, "files": [
            {"name": "Book’s contents.pdf", "size": "900"},
            {"name": "private.pdf", "private": "true"}, {"name": "notes.txt"}]}
        result = archive.candidates("item/with space", data)
        self.assertEqual(len(result["candidates"]), 2)
        self.assertIn("item%2Fwith%20space/Book%E2%80%99s%20contents.pdf", result["candidates"][0]["url"])
        self.assertIsNone(result["candidates"][1]["url"])
        self.assertEqual(result["candidates"][0]["completeness"], "unknown")
        data["metadata"]["access-restricted-item"] = "true"
        self.assertTrue(archive.candidates("id", data)["restricted"])
        self.assertTrue(all(c["url"] is None for c in archive.candidates("id", data)["candidates"]))

    def test_network_failure_returns_failure_without_claims(self):
        with patch("sys.argv", ["archive_search.py", "--item", "id"]), patch.object(archive, "fetch", side_effect=OSError("offline")), patch("builtins.print"):
            self.assertEqual(archive.main(), 1)


if __name__ == "__main__":
    unittest.main()
