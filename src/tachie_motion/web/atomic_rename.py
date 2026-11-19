"""Native atomic no-replace rename; never fall back to a racy check + rename.

Both Linux and macOS provide a kernel primitive that fails when the target
exists. Unsupported filesystems must fail closed rather than overwrite data.
"""
import ctypes
import errno
import os
from pathlib import Path
import sys


def rename_noreplace(source: Path, destination: Path) -> None:
    """Atomically move source to an unoccupied name, preserving any occupant."""
    libc = ctypes.CDLL(None, use_errno=True)
    src, dst = os.fsencode(source), os.fsencode(destination)
    if sys.platform == "darwin":
        try:
            call = libc.renamex_np
        except AttributeError as exc:
            raise OSError(errno.ENOTSUP, "Atomic exclusive rename unavailable") from exc
        call.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        call.restype = ctypes.c_int
        code = call(src, dst, 0x00000004)  # Darwin RENAME_EXCL
    elif sys.platform.startswith("linux"):
        try:
            call = libc.renameat2
        except AttributeError as exc:
            raise OSError(errno.ENOTSUP, "Atomic exclusive rename unavailable") from exc
        call.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                         ctypes.c_char_p, ctypes.c_uint]
        call.restype = ctypes.c_int
        code = call(-100, src, -100, dst, 0x00000001)  # RENAME_NOREPLACE
    else:
        raise OSError(errno.ENOTSUP, "Atomic exclusive rename unsupported on this OS")
    if code != 0:
        current_errno = ctypes.get_errno()
        raise OSError(current_errno, os.strerror(current_errno),
                      str(source), str(destination))
