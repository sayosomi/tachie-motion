"""Preflight and safely publish matching MOV/OTIO destinations.

OS filesystems cannot atomically replace *two separate pathnames* at once.
Every overwrite is staged first; hard-linked originals are kept in a named
recovery directory until both new paths are published. Ordinary exceptions
roll back changes, while a hard process interruption leaves recoverable
originals in that directory (never silently delete/reuse it).
"""

import os
from pathlib import Path
import re
import shutil
import stat
import tempfile


_NAME = re.compile(r"[A-Za-z0-9_-]{1,64}\Z", re.ASCII)


def validate_basename(value: str) -> str:
    if not isinstance(value, str) or not _NAME.fullmatch(value):
        raise ValueError("Output basename must use 1-64 ASCII letters, digits, - or _")
    return value


def paths_for(folder: Path, name: str) -> tuple[Path, Path]:
    validate_basename(name)
    return folder / (name + ".mov"), folder / (name + ".otio")


def backup_location(mov: Path) -> Path:
    return mov.parent / ("." + mov.stem + ".tachie-backup")


def _regular_identity(path: Path) -> tuple[int, int, int, int] | None:
    try:
        data = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(data.st_mode):
        raise ValueError("Output destination is not a regular file (symlinks forbidden)")
    return data.st_dev, data.st_ino, data.st_size, data.st_mtime_ns


def recovery_locations(mov: Path) -> tuple[Path, ...]:
    """Find interrupted overwrite and new-export recovery areas."""
    backup = backup_location(mov)
    found = [backup] if backup.exists() or backup.is_symlink() else []
    prefix = "." + mov.stem + ".failed-"
    found.extend(entry for entry in mov.parent.iterdir()
                 if entry.name.startswith(prefix))
    return tuple(sorted(found))


def all_output_recovery(mov: Path) -> tuple[Path, ...]:
    """Recovery paths for BOTH publication protocols for one basename."""
    if mov.suffix.lower() != ".mov":
        mov = mov.with_suffix(".mov")
    otio = mov.with_suffix(".otio")
    found = list(recovery_locations(mov))
    for path in (mov, otio):
        candidate = path.parent / ("." + path.name + ".single-backup")
        if candidate.exists() or candidate.is_symlink():
            found.append(candidate)
    return tuple(sorted(found))


def target_state(mov: Path, otio: Path) -> tuple[str, tuple | None]:
    from tachie_motion.web.batch_publish import recovery_directories
    if recovery_directories(mov.parent) or all_output_recovery(mov):
        return "recovery_required", None
    try:
        a, b = _regular_identity(mov), _regular_identity(otio)
    except ValueError:
        return "unsafe", None
    if a is None and b is None:
        return "available", None
    if a is not None and b is not None:
        return "complete", (a, b)
    return "partial", None


def available_name(folder: Path, requested: str) -> str:
    validate_basename(requested)
    for number in range(2, 10002):
        suffix = f"_{number:03d}"
        name = requested[:64 - len(suffix)] + suffix
        mov, otio = paths_for(folder, name)
        if target_state(mov, otio)[0] == "available":
            return name
    raise ValueError("No unused output name available")


def destination_info(folder: Path, basename: str) -> dict:
    mov, otio = paths_for(folder, basename)
    state, _ = target_state(mov, otio)
    return {
        "state": state,
        "suggested_basename": available_name(folder, basename)
            if state != "available" else basename,
    }


def initial_target_identity(mov: Path, otio: Path, policy: str) -> tuple | None:
    if policy not in ("error", "overwrite"):
        raise ValueError("Unsupported output conflict policy")
    state, identity = target_state(mov, otio)
    if state == "recovery_required":
        raise RuntimeError(
            "Previous export needs recovery; inspect "
            + ", ".join(str(path) for path in all_output_recovery(mov))
            + " before exporting to this filename"
        )
    if state == "unsafe":
        raise ValueError("Unsafe output destination; choose another filename")
    if state == "partial":
        raise ValueError("Only one output exists; choose another filename")
    if policy == "overwrite":
        if state != "complete":
            raise ValueError("No complete MOV/OTIO pair to overwrite; try normal export")
    elif state != "available":
        raise FileExistsError("Output already exists; choose another name or overwrite")
    return identity


def _check_same_target(
    mov: Path, otio: Path, old: tuple | None, *, owned_backup: bool = False,
) -> None:
    if owned_backup:
        # We created the exclusive backup directory ourselves and hold it
        # until publishing finishes; do not interpret our lock as a stale crash.
        a, b = _regular_identity(mov), _regular_identity(otio)
        state = "complete" if a is not None and b is not None else "partial"
        now = (a, b) if state == "complete" else None
    else:
        state, now = target_state(mov, otio)
    if old is None and state == "available":
        return
    if old is not None and state == "complete" and now == old:
        return
    raise FileExistsError("Output changed while rendering; nothing was published")


def publish_pair(
    staged_mov: Path, staged_otio: Path, mov: Path, otio: Path,
    *, policy: str, prior: tuple | None,
) -> str | None:
    """Publish a pair; return a post-commit cleanup warning, if any.

    The output names are never unconditionally replaced. Existing names are
    moved into an exclusive recovery directory and new names are created via
    hard links (which fail if another writer has occupied the path). A writer
    that races our rename is saved inside the recovery directory rather than
    being deleted on a failed publication. Non-cooperating same-inode writers
    cannot be made fully transactional with portable filesystem operations.
    """
    _check_same_target(mov, otio, prior)
    if policy == "error":
        # Reserve recovery space before any output is published. Failure
        # here leaves both target names untouched.
        recovery = Path(tempfile.mkdtemp(
            prefix="." + mov.stem + ".failed-", dir=mov.parent,
        ))
        try:
            os.link(staged_mov, mov)  # exclusive, never replaces another file
        except BaseException:
            try:
                shutil.rmtree(recovery)
            except OSError as cleanup_error:
                raise RuntimeError(
                    "New export could not start; inspect " + str(recovery)
                ) from cleanup_error
            raise

        try:
            os.link(staged_otio, otio)
        except BaseException:
            # Quarantine first: a competing process might replace MOV during
            # rollback, and a stat-then-unlink check is not safe.
            try:
                os.rename(mov, recovery / "candidate.mov")
                if _regular_identity(recovery / "candidate.mov") != _regular_identity(staged_mov):
                    raise RuntimeError("An external MOV was preserved")
            except BaseException as recovery_error:
                raise RuntimeError(
                    "New export rollback incomplete; inspect " + str(recovery)
                ) from recovery_error
            try:
                shutil.rmtree(recovery)
            except OSError as cleanup_error:
                raise RuntimeError(
                    "New export rollback cleanup incomplete; inspect " + str(recovery)
                ) from cleanup_error
            raise

        # Both outputs committed; failure to remove an empty recovery folder
        # must be reported as a warning rather than an export failure.
        try:
            shutil.rmtree(recovery)
        except OSError:
            return (
                "MOV and OTIO were saved, but the recovery directory could not "
                "be removed: " + str(recovery) + ". Inspect before re-exporting."
            )
        return None

    if policy != "overwrite" or prior is None:
        raise ValueError("No existing output pair was approved for overwrite")

    backup = backup_location(mov)
    backup.mkdir(mode=0o700, exist_ok=False)  # also excludes cooperating exporters
    saved = (backup / "saved.mov", backup / "saved.otio")
    removed = (backup / "removed.mov", backup / "removed.otio")
    failed = (backup / "uncommitted.mov", backup / "uncommitted.otio")
    targets = (mov, otio)
    stages = (staged_mov, staged_otio)
    published = [False, False]
    unexpected = False
    try:
        # Hard-linked originals survive ordinary exceptions and hard kills.
        os.link(mov, saved[0])
        os.link(otio, saved[1])
        _check_same_target(mov, otio, prior, owned_backup=True)

        for i in range(2):
            # Atomic move preserves even a competing writer's last-minute
            # replacement. Verify the *moved* inode before continuing.
            os.rename(targets[i], removed[i])
            if _regular_identity(removed[i]) != prior[i]:
                unexpected = True
                raise FileExistsError(
                    "Output changed while publishing; conflicting file preserved in " + str(backup)
                )

        for i in range(2):
            os.link(stages[i], targets[i])  # EEXIST rather than clobbering a competitor
            published[i] = True

    except BaseException:
        try:
            for i in range(2):
                if published[i]:
                    # Quarantine rather than unlink: an external writer could
                    # have replaced or modified our published file.
                    try:
                        os.rename(targets[i], failed[i])
                    except FileNotFoundError:
                        unexpected = True
                    else:
                        if _regular_identity(failed[i]) != _regular_identity(stages[i]):
                            unexpected = True

            for i in range(2):
                current = _regular_identity(targets[i])
                if current is None:
                    if saved[i].exists():
                        os.link(saved[i], targets[i])  # exclusive restore
                    else:
                        unexpected = True
                elif current != prior[i]:
                    # Never replace somebody else's output during rollback.
                    unexpected = True

            if any(_regular_identity(targets[i]) != prior[i] for i in range(2)):
                unexpected = True
            if unexpected:
                raise RuntimeError("Concurrent output change; manual recovery required")

        except BaseException as restoration_error:
            raise RuntimeError(
                "Overwrite rollback incomplete; originals and changed files are preserved in "
                + str(backup) + "; do not export again until recovered"
            ) from restoration_error

        try:
            shutil.rmtree(backup)
        except OSError as cleanup_error:
            raise RuntimeError(
                "Overwrite failed and originals were restored, but backup cleanup failed at "
                + str(backup)
            ) from cleanup_error
        raise

    # Both outputs are now committed. Cleanup is not part of the transaction;
    # failing here must not turn an already-successful export into HTTP 400.
    try:
        shutil.rmtree(backup)
    except OSError:
        return (
            "MOV and OTIO were saved, but the previous-output backup could not be "
            "fully removed: " + str(backup)
            + ". Inspect it before the next same-name export."
        )
    return None
