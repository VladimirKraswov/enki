"""Publication port (services/hub/durable.py).

Regression: Windows CI failed 28 Hub cases because releases.atomic did
os.open(directory) -> PermissionError. POSIX fsyncs the directory, Windows uses
MoveFileExW write-through (a documented per-rename barrier on local NTFS, not a
universal crash guarantee). Failures are phase-aware: before the rename the old
file is unchanged (OSError); after it the new content may be visible
(PublicationUncertain). Each platform's REAL primitive runs on that platform;
flags and failure classification are verified everywhere with injected ports.
"""
import importlib.util, os, tempfile, unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('hub_durable', Path(__file__).parents[1] / 'durable.py')
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


class Durable(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_platform_selects_its_durable_rename(self):
        self.assertIs(d.durable_replace, d.windows_replace if os.name == 'nt' else d.posix_replace)

    def test_publish_replaces_completely_and_leaves_no_temporary(self):
        target = self.root / 'stable.json'
        d.publish(target, b'{"v":1}')
        d.publish(target, b'{"v":2}')
        self.assertEqual(target.read_bytes(), b'{"v":2}')
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['stable.json'])
        if os.name != 'nt':
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_failed_rename_keeps_the_previous_file_and_removes_the_temporary(self):
        target = self.root / 'stable.json'
        d.publish(target, b'old')
        def broken(source, destination):
            self.assertEqual(Path(source).read_bytes(), b'new', 'contents are complete before the rename')
            raise OSError('simulated rename failure')
        with self.assertRaises(OSError):
            d.publish(target, b'new', replace=broken)
        self.assertEqual(target.read_bytes(), b'old')
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['stable.json'])

    def test_windows_strategy_requests_write_through_and_never_hides_failure(self):
        calls = []
        def move(source, target, flags):
            calls.append((source, target, flags))
            return True
        d.windows_replace(self.root / 'a.tmp', self.root / 'a.json', move=move, last_error=lambda: 0)
        self.assertEqual(calls, [(str(self.root / 'a.tmp'), str(self.root / 'a.json'), 0x1 | 0x8)])
        with self.assertRaisesRegex(OSError, 'Windows error 5'):
            d.windows_replace(self.root / 'a.tmp', self.root / 'a.json', move=lambda *_: False, last_error=lambda: 5)

    def test_first_publication_and_replacement_are_complete_and_never_partial(self):
        target = self.root / 'preview.json'
        self.assertFalse(target.exists())
        d.publish(target, b'{"head":1}')
        self.assertEqual(target.read_bytes(), b'{"head":1}')
        d.publish(target, b'{"head":2,"pad":"' + b'x' * 65536 + b'"}')
        self.assertTrue(target.read_bytes().startswith(b'{"head":2,'))
        self.assertTrue(target.read_bytes().endswith(b'"}'))

    def test_a_failure_after_the_posix_rename_is_uncertain_not_unchanged(self):
        target = self.root / 'stable.json'
        d.publish(target, b'old')
        def failing_sync(_directory):
            raise PermissionError('directory flush denied')
        with self.assertRaises(d.PublicationUncertain) as raised:
            d.publish(target, b'new', replace=lambda s, t: d.posix_replace(s, t, sync=failing_sync))
        self.assertIsInstance(raised.exception, OSError)
        self.assertIn('durability is unconfirmed', str(raised.exception))
        # Visible new head: the caller must reconcile, never report "old kept".
        self.assertEqual(target.read_bytes(), b'new')
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['stable.json'])

    def test_windows_failure_is_classified_by_whether_the_name_moved(self):
        source, target = self.root / 'b.tmp', self.root / 'b.json'
        target.write_bytes(b'old')
        source.write_bytes(b'new')
        # Reported failure with the temporary still present: nothing moved.
        with self.assertRaises(OSError) as before:
            d.windows_replace(source, target, move=lambda *_: False, last_error=lambda: 32)
        self.assertNotIsInstance(before.exception, d.PublicationUncertain)
        self.assertEqual(target.read_bytes(), b'old')
        # Reported failure after the name moved: uncertain, new content visible.
        def moved_then_failed(src, dst, _flags):
            os.replace(src, dst)
            return False
        with self.assertRaises(d.PublicationUncertain):
            d.windows_replace(source, target, move=moved_then_failed, last_error=lambda: 1117)
        self.assertEqual(target.read_bytes(), b'new')

    @unittest.skipIf(os.name == 'nt', 'POSIX directory fsync primitive; Windows runs its own case below')
    def test_posix_rename_is_followed_by_a_directory_fsync(self):
        source, target = self.root / 'x.tmp', self.root / 'x.json'
        source.write_bytes(b'x')
        opened, synced, real_open, real_fsync = [], [], os.open, os.fsync
        def tracking_open(path, flags, *rest):
            fd = real_open(path, flags, *rest)
            opened.append((os.fspath(path), flags, fd))
            return fd
        def tracking_fsync(fd):
            synced.append((fd, target.exists()))
            return real_fsync(fd)
        with patch.object(d.os, 'open', tracking_open), patch.object(d.os, 'fsync', tracking_fsync):
            d.posix_replace(source, target)
        self.assertEqual([(p, f & getattr(os, 'O_DIRECTORY', 0)) for p, f, _ in opened],
                         [(os.path.abspath(self.root), getattr(os, 'O_DIRECTORY', 0))])
        self.assertEqual(synced, [(opened[0][2], True)], 'directory fsync happens after the rename')

    @unittest.skipUnless(os.name == 'nt', 'real MoveFileExW write-through on Windows')
    def test_real_windows_write_through_replace(self):
        source, target = self.root / 'w.tmp', self.root / 'w.json'
        target.write_bytes(b'old')
        source.write_bytes(b'new')
        d.windows_replace(source, target)
        self.assertEqual(target.read_bytes(), b'new')
        self.assertFalse(source.exists())


if __name__ == '__main__':
    unittest.main()
