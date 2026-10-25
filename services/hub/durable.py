"""Whole-file publication for Hub stores (releases, model catalog), with an
explicit outcome when durability cannot be confirmed.

Contents: a private temporary in the SAME directory is written, flushed and
fsynced (Windows: CRT _commit) before any rename. The rename, per platform:

* POSIX: os.replace, then fsync of the containing directory, which is what
  makes the new directory entry durable on POSIX filesystems.
* Windows: MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH),
  same volume only (never MOVEFILE_COPY_ALLOWED). Microsoft documents that
  write-through returns after the move is on disk; that is the strongest
  documented per-rename barrier available without administrator volume flush.
  It is NOT a universal crash guarantee: SMB/FAT/ReFS, disks that ignore cache
  write-through and other storage stacks are outside the qualified contract,
  and a directory handle is never "fsynced" (no documented Windows primitive).

Outcomes are phase-aware:

* A failure BEFORE the rename raises OSError; the previously published file is
  unchanged and the temporary is removed.
* A failure AFTER the rename may already have made the new content visible
  (POSIX: replace succeeded, directory fsync failed; Windows: the temporary is
  gone after a failed write-through move). This raises PublicationUncertain.
  Callers must not report "unchanged", must not blindly repeat the mutation,
  and must reconcile by reading what is actually published.
"""
import os
import secrets

MOVEFILE_REPLACE_EXISTING = 0x1
MOVEFILE_WRITE_THROUGH = 0x8
_windows_move = None


class PublicationUncertain(OSError):
    """The new content may already be visible, but its durability is unconfirmed."""


def sync_directory(directory):
    """POSIX directory fsync; never called on Windows (see module docstring)."""
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def posix_replace(source, target, sync=None):
    os.replace(source, target)
    try:
        (sync or sync_directory)(os.path.dirname(os.path.abspath(target)))
    except OSError as error:
        raise PublicationUncertain(
            f'{os.fspath(target)} was replaced, but the directory flush failed ({error}); '
            'the new content is visible and its durability is unconfirmed') from error


def _kernel32_move():
    global _windows_move
    if _windows_move is None:
        import ctypes
        from ctypes import wintypes
        move = ctypes.WinDLL('kernel32', use_last_error=True).MoveFileExW
        move.argtypes = (wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD)
        move.restype = wintypes.BOOL
        _windows_move = (move, ctypes.get_last_error)
    return _windows_move


def windows_replace(source, target, move=None, last_error=None):
    """Replace with write-through. `move`/`last_error` are injectable so the
    exact flags and failure classification are tested on every platform."""
    if move is None:
        move, last_error = _kernel32_move()
    if not move(os.fspath(source), os.fspath(target), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH):
        code = last_error() if last_error else 0
        message = f'MoveFileExW write-through replace failed (Windows error {code}): {os.fspath(target)}'
        # The temporary still present means the name was not moved. Gone means
        # the move may have happened even though the call reported failure.
        if os.path.lexists(source):
            raise OSError(message)
        raise PublicationUncertain(message + '; the new content may already be visible')


durable_replace = windows_replace if os.name == 'nt' else posix_replace


def publish(path, raw, replace=None):
    """Make `raw` (bytes) the complete content of `path` (a pathlib.Path).

    Raises OSError when nothing changed, PublicationUncertain when the new
    content may be visible but its durability is unconfirmed."""
    temporary = path.with_name('.' + secrets.token_hex(12) + '.tmp')
    try:
        with temporary.open('xb') as output:
            os.chmod(temporary, 0o600)
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        (replace or durable_replace)(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
