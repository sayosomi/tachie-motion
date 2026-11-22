"""Content-based identities for a future selective batch-MOV reuse gate.

These are *not* sufficient to authorize reuse on their own. A batch coordinator
must also verify the saved generation record, MOV metadata, source identities,
destination ownership, and its own publication lease before reusing a file.
"""

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import stat
from typing import Any


# A change to render behavior or encoder settings must invalidate saved recipes.
# This deliberately does not promise that two fresh blinking renders are equal:
# retaining the original MOV preserves its already-randomized blink sequence.
RECIPE_FORMAT = "tachie-motion-mov-recipe-v1"

_RENDER_FIELDS = frozenset({
    "psd", "wav", "fingerprint", "source_identity", "layers", "mouth",
    "aiueo_mouth", "mouth_groups", "lab_source_identity", "mode",
    "blink_enabled", "eyes", "eye_groups", "blink_timing",
    "timeline_changes", "fps",
})
_PUBLICATION_FIELDS = frozenset({
    "output_dir", "basename", "conflict_policy", "progress_id",
    "batch_id", "batch_index",
})
_REQUIRED_FIELDS = frozenset({
    "psd", "wav", "fingerprint", "source_identity", "layers", "mode",
    "blink_enabled", "fps",
})


@dataclass(frozen=True)
class FileDigest:
    """A verified, regular inode observed unchanged throughout the hash read."""

    sha256: str
    size: int
    identity: tuple[int, int, int, int, int]


def _identity(info: os.stat_result) -> tuple[int, int, int, int, int]:
    return (info.st_dev, info.st_ino, info.st_ctime_ns,
            info.st_size, info.st_mtime_ns)


def digest_regular_file(path: Path) -> FileDigest:
    """Hash file bytes without following links or accepting an unstable source."""

    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink < 1:
        raise ValueError("Source is not a regular file: " + str(path))
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open(path, flags)
    try:
        first = os.fstat(descriptor)
        if not stat.S_ISREG(first.st_mode) or _identity(first) != _identity(before):
            raise ValueError("Source changed before hashing: " + str(path))
        digest = hashlib.sha256()
        while data := os.read(descriptor, 1024 * 1024):
            digest.update(data)
        last = os.fstat(descriptor)
        if _identity(last) != _identity(first) or _identity(path.lstat()) != _identity(first):
            raise ValueError("Source changed while hashing: " + str(path))
        return FileDigest(digest.hexdigest(), last.st_size, _identity(last))
    finally:
        os.close(descriptor)


def fingerprint_render_recipe(payload: dict[str, Any], *,
                              psd: FileDigest, wav: FileDigest,
                              lab: FileDigest | None = None,
                              engine_revision: str) -> str:
    """Exclude order/output paths, but conservatively include every render input.

    Unknown request fields fail closed: adding a renderer argument must never
    silently keep the old recipe key. The server supplies verified byte digests;
    neither the browser nor a cache manifest may assert those as trusted facts.
    """

    keys = set(payload)
    if not _REQUIRED_FIELDS <= keys or keys - _RENDER_FIELDS - _PUBLICATION_FIELDS:
        raise ValueError("Unknown or missing MOV recipe field")
    if not engine_revision or not isinstance(engine_revision, str):
        raise ValueError("Renderer revision is required")
    if payload["mode"] not in ("none", "open", "aiueo"):
        raise ValueError("Invalid lip mode")
    if payload["fps"] not in (24, 30, 60):
        raise ValueError("Invalid frame rate")
    changes = payload.get("timeline_changes")
    if changes is not None and (not isinstance(changes, list) or
                                any(not isinstance(item, dict) for item in changes)):
        raise ValueError("Invalid timeline change points")
    needs_lab = payload["mode"] == "aiueo" or any(
        point.get("mode") == "aiueo" for point in changes or [])
    if needs_lab != (lab is not None):
        raise ValueError("LAB content must match the effective render mode")
    # Identical source bytes with different registered paths are intentionally
    # separate: the existing API independently validates each source identity.
    record = {
        "format": RECIPE_FORMAT,
        "engine_revision": engine_revision,
        "inputs": {key: payload.get(key) for key in sorted(_RENDER_FIELDS)},
        "source_sha256": {
            "psd": psd.sha256, "wav": wav.sha256,
            "lab": lab.sha256 if lab is not None else None,
        },
    }
    try:
        encoded = json.dumps(record, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (ValueError, TypeError) as exc:
        raise ValueError("Invalid MOV recipe data") from exc
    return hashlib.sha256(encoded).hexdigest()
