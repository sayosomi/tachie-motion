"""Safe exclusive/overwrite publication for a single batch MOV or combined OTIO.

Distinct from the legacy pair publisher: no throwaway individual OTIO is written.
Keep original targets in an exclusive recovery directory until publication succeeds.
"""
from pathlib import Path
import os
import re
import shutil
import stat
import unicodedata


def validate_media_basename(name: str) -> str:
    """A single safe component; accept Japanese and NFD without normalizing bytes."""
    if not isinstance(name, str) or not name or len(name) > 120 or len(name.encode("utf-8")) > 180:
        raise ValueError("Output filename must be 1–120 characters / <=180 UTF-8 bytes")
    if name in (".", "..") or name.startswith(".") or name[-1] in (" ", "."):
        raise ValueError("Invalid leading/trailing output filename")
    if any(c in '/\\:*?"<>|' or unicodedata.category(c).startswith("C") for c in name):
        raise ValueError("Filename contains unsupported characters")
    if re.fullmatch(r"(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", name, re.I):
        raise ValueError("Reserved Windows filename")
    return name


def recovery(path: Path) -> Path:
    return path.parent / ("." + path.name + ".single-backup")


def _identity(path: Path) -> tuple[int, int, int, int] | None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("Output target is not a regular file (symlink forbidden)")
    # Hard-link backup creation legitimately updates ctime. Do not treat that
    # in-process change as a competing overwrite.
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns



def published_media_identity(path: Path) -> tuple[int, int, int, int, int] | None:
    """Stable snapshot after a published MOV's staging hardlink is cleaned up.

    Not used during hardlink-backed rollback: creating/removing a backup link
    intentionally updates ctime, even when the file's contents are unchanged.
    """
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("Published MOV is not a regular file")
    return (info.st_dev, info.st_ino, info.st_ctime_ns,
            info.st_size, info.st_mtime_ns)


def _has_sibling_file(path: Path) -> bool:
    """Do not overwrite one half of an existing MOV/OTIO pair."""
    if path.suffix.lower() not in (".mov", ".otio"):
        return False
    sibling = path.with_suffix(".otio" if path.suffix.lower() == ".mov" else ".mov")
    return sibling.exists() or sibling.is_symlink()


def _recovery_paths(path: Path) -> tuple[Path, ...]:
    from tachie_motion.web.output_destinations import all_output_recovery
    return all_output_recovery(path.with_suffix(".mov"))


def initial_single_identity(path: Path, policy: str):
    if policy not in ("error", "overwrite"):
        raise ValueError("Unsupported output conflict policy")
    if _recovery_paths(path):
        raise RuntimeError("Previous export needs recovery: " +
                           ", ".join(map(str, _recovery_paths(path))))
    if _has_sibling_file(path):
        raise ValueError("Output name belongs to a MOV/OTIO pair; choose another name")
    prior = _identity(path)
    if prior is None and policy == "overwrite":
        raise ValueError("No existing file to overwrite")
    if prior is not None and policy == "error":
        raise FileExistsError("Output already exists")
    return prior


def single_destination(path: Path) -> dict:
    if _recovery_paths(path):
        return {"state": "recovery_required"}
    if _has_sibling_file(path):
        return {"state": "unsafe"}
    try:
        existing = _identity(path)
    except ValueError:
        return {"state": "unsafe"}
    return {"state": "complete" if existing is not None else "available"}


def publish_single(staged: Path, target: Path, *, policy: str, prior) -> str | None:
    """Exclusive creation for fresh files, hardlink-backed rollback for overwrite."""
    if _recovery_paths(target):
        raise RuntimeError("Previous export needs recovery: " +
                           ", ".join(map(str, _recovery_paths(target))))
    if _has_sibling_file(target):
        raise ValueError("Output is paired with another file; refusing single-file overwrite")
    if _identity(target) != prior:
        raise FileExistsError("Output changed while rendering; nothing published")
    if prior is None:
        if policy != "error":
            raise ValueError("No existing output was approved for overwrite")
        os.link(staged, target)  # fails with EEXIST; cannot replace a competing file
        return None
    if policy != "overwrite":
        raise FileExistsError("Existing output not approved for overwrite")

    backup = recovery(target)
    backup.mkdir(mode=0o700, exist_ok=False)
    saved = backup / "saved"
    removed = backup / "removed"
    failed = backup / "uncommitted"
    moved = False
    published = False
    unexpected = False
    try:
        os.link(target, saved)
        if _identity(target) != prior:
            raise FileExistsError("Output changed before overwrite")
        os.rename(target, removed)
        moved = True
        if _identity(removed) != prior:
            unexpected = True
            raise FileExistsError("Concurrent target change; original preserved")
        os.link(staged, target)  # exclusive; never clobber a competing file
        published = True
    except BaseException:
        try:
            if published:
                os.rename(target, failed)
                if _identity(failed) != _identity(staged):
                    unexpected = True
            if _identity(target) is None and saved.exists():
                os.link(saved, target)
            if _identity(target) != prior or unexpected:
                raise RuntimeError("Concurrent changes need manual recovery")
        except BaseException as error:
            raise RuntimeError("Overwrite recovery required: " + str(backup)) from error
        try:
            shutil.rmtree(backup)
        except OSError as error:
            raise RuntimeError("Backup cleanup required: " + str(backup)) from error
        raise
    try:
        shutil.rmtree(backup)
    except OSError:
        return "Export saved; inspect recovery directory: " + str(backup)
    return None
